defmodule Cytale.SessionBridge do
  @moduledoc """
  The authentication bridge (U2, R7/R8/R8b/R9): a verified SSH certificate
  identity is exchanged for a short-lived Cytale ACCESS token — never a refresh
  token (R9).

  The bridge lives outside `Cytale.SSH` on purpose (plan Output Structure): it
  is the server-side mint counterpart of an authenticated machine caller, in
  the same family as `Cytale.Accounts.Auth`, and putting it beside the process
  that holds CA private-key material would co-locate two different credential
  systems in one namespace. It is reached by `CytaleWeb.BridgeServer`'s own
  listener — never by the app router, because Caddy proxies every path on that
  one (R8a).

  ## What a mint requires, and why each check exists

  A request asserts a **serial**, a **principal**, a **public-key
  fingerprint**, an **asserted_at** timestamp and a **nonce**, and presents the
  bridge credential. Nothing here trusts the assertion: the credential gets the
  caller in the door, and every assertion is checked against what this server
  actually issued.

    * the **credential** is compared in constant time over SHA-256 hashes
      (`CytaleWeb.Plugs.BridgeAuth`), the same `Plug.Crypto.secure_compare`
      shape `Cytale.Webhooks` and the gateway socket already use — hashing
      first means the comparison is always between equal-length values, so no
      length oracle exists either;
    * the **serial** must resolve to an issuance row THIS server wrote (R8).
      That is what makes a stolen CA key insufficient on its own, and it is why
      a certificate that merely verifies cryptographically is not enough;
    * the **principal** and the **fingerprint** must equal the issuance row's
      values (R8) — one identity bind, three checks, exactly as U4 and U17
      implement theirs;
    * the **account** must still resolve to a live, un-deleted row, and must
      pass the SAME verification gate the rest of the product uses
      (`Cytale.Config.require_verified_email?/0`) rather than a hard-coded
      check, so a deploy with the gate lifted keeps the terminal working (R8);
    * the account's **credential epoch** must not have moved past the epoch
      recorded at issuance (R13a). This is the mint-side half of the rollout
      posture: fail-open at authentication (a token minted before the claim
      existed still authenticates) and fail-closed HERE, so a password reset or
      a revoke-all-sessions ends an SSH session at its next renewal — one
      access-token lifetime, the bound R13a already claims — without logging
      every live session out on the deploy that introduced the epoch;
    * the **asserted_at** must be within `acceptance_window_s/0` of this
      server's clock, and the **nonce** must be one this server has never seen;
    * the **nonce** — not the serial — is the replay key. One session re-mints
      on the SAME serial every access-token lifetime for up to 24 hours, so a
      serial-keyed single-use record would refuse the first renewal and kill
      every long session. A nonce-keyed record refuses a replayed assertion and
      lets a fresh-nonce renewal through.

  Every accept and every refusal is audited (R8b) through `Cytale.SSH.Audit`.
  Refusals that happen before any account resolves — an unknown serial, a wrong
  credential — land in the audit's unknown-account partition, because an audit
  trail that requires an account in order to record something cannot record
  the interesting cases.

  ## The credential

  Config: `config :cytale, :session_bridge, [credential_path: "..."]` (a file,
  read once and cached — never an environment VALUE, matching the CA key's
  posture), or `credential: "..."` for tests. The environment fallbacks
  (`CYTALE_SESSION_BRIDGE_CREDENTIAL_PATH`, `CYTALE_SESSION_BRIDGE_CREDENTIAL`)
  exist so the bridge is deployable without a config edit; the config key wins
  when both are present.
  """

  alias Cytale.Accounts.Auth
  alias Cytale.Accounts.User
  alias Cytale.SSH.{Audit, CertificateStore}
  alias Cytale.Repo

  require Logger

  @config_scope :session_bridge
  @default_acceptance_window_s 120

  # A nonce is opaque to the server; it only has to be long enough not to
  # collide by accident and short enough not to be a payload.
  @nonce_bytes_range 8..256

  @typedoc "A refusal reason. Every one of these is audited with its atom."
  @type refusal ::
          :invalid_serial
          | :invalid_principal
          | :invalid_fingerprint
          | :invalid_nonce
          | :invalid_asserted_at
          | :stale_assertion
          | :unknown_serial
          | :certificate_expired
          | :principal_mismatch
          | :fingerprint_mismatch
          | :unknown_account
          | :account_deleted
          | :machine_account
          | :unverified
          | :credential_epoch_moved
          | :replayed_assertion
          | :mint_failed
          | :missing_credential
          | :bad_credential

  @typedoc "What a successful mint returns to the session host."
  @type minted :: %{
          access_token: String.t(),
          token_type: String.t(),
          expires_in: pos_integer()
        }

  # ---------------------------------------------------------------------------
  # Configuration + credential custody
  # ---------------------------------------------------------------------------

  @doc """
  How far the request's `asserted_at` may sit from this server's clock. Short
  on purpose: the assertion is a one-shot, and the window is what bounds a
  captured request's usefulness in time. It is not a grace window on the
  credential epoch — the plan forbids one of those.
  """
  @spec acceptance_window_s() :: pos_integer()
  def acceptance_window_s do
    case Keyword.get(config(), :acceptance_window_s, @default_acceptance_window_s) do
      s when is_integer(s) and s > 0 -> s
      _other -> @default_acceptance_window_s
    end
  end

  @doc """
  Where the bridge credential comes from, as a cache key that carries no
  secret: `{:path, path}`, `{:value, :configured}` or `nil` when unconfigured.
  """
  @spec credential_source() :: {:path, String.t()} | {:value, :configured} | nil
  def credential_source do
    case config()[:credential_path] || System.get_env("CYTALE_SESSION_BRIDGE_CREDENTIAL_PATH") do
      path when is_binary(path) and path != "" ->
        {:path, path}

      _ ->
        case config()[:credential] || System.get_env("CYTALE_SESSION_BRIDGE_CREDENTIAL") do
          value when is_binary(value) and value != "" -> {:value, :configured}
          _ -> nil
        end
    end
  end

  @doc """
  SHA-256 of the configured bridge credential, loaded once from its configured
  path and cached (keyed by the source, so a config change reloads it).

  Raises — naming the config key and the env var, never a value — when no
  credential is configured. `CytaleWeb.BridgeServer` calls this at boot so a
  misconfigured bridge never starts, and `verify_credential/1` turns the same
  condition into a refusal rather than a 500 on the request path.
  """
  @spec credential_hash!() :: binary()
  def credential_hash! do
    case credential_source() do
      nil ->
        raise ArgumentError,
              "session bridge credential is not configured: set " <>
                "config :cytale, :session_bridge, credential_path: \"...\" " <>
                "(or CYTALE_SESSION_BRIDGE_CREDENTIAL_PATH). The credential is a PATH, never " <>
                "an environment value, so it cannot be read out of this process's environment or /proc."

      source ->
        cache_key = {__MODULE__, :credential_hash}

        case :persistent_term.get(cache_key, nil) do
          {^source, hash} ->
            hash

          _other ->
            hash = sha256(read_credential(source))
            :persistent_term.put(cache_key, {source, hash})
            hash
        end
    end
  end

  @doc """
  Constant-time comparison of a presented credential against the configured
  one, over SHA-256 hashes of both. A missing or malformed presentation is
  simply false; an unconfigured bridge is false too (fail closed — boot is
  where the loud failure lives).
  """
  @spec verify_credential(String.t() | nil) :: boolean()
  def verify_credential(presented) when is_binary(presented) do
    Plug.Crypto.secure_compare(sha256(presented), credential_hash!())
  rescue
    _ -> false
  end

  def verify_credential(_presented), do: false

  # ---------------------------------------------------------------------------
  # The mint
  # ---------------------------------------------------------------------------

  @doc """
  Exchange a verified certificate identity for an access token.

  `attrs` are the request body's string-keyed values. Returns `{:ok, minted}`
  or `{:error, reason}`; every outcome is audited.
  """
  @spec mint(map()) :: {:ok, minted()} | {:error, refusal()}
  def mint(attrs) when is_map(attrs) do
    asserted = %{
      serial: attrs["serial"],
      principal: attrs["principal"],
      fingerprint: attrs["fingerprint"]
    }

    with {:ok, serial} <- parse_serial(attrs["serial"]),
         {:ok, principal} <- parse_principal(attrs["principal"]),
         {:ok, fingerprint} <- parse_fingerprint(attrs["fingerprint"]),
         {:ok, nonce} <- parse_nonce(attrs["nonce"]),
         :ok <- check_asserted_at(attrs["asserted_at"]),
         {:ok, row} <- resolve_serial(serial) do
      identity = %{
        serial: serial,
        principal: principal,
        fingerprint: fingerprint,
        account_id: row.account_id
      }

      authorize_mint(row, identity, nonce)
    else
      {:error, reason} -> refuse(reason, asserted)
    end
  end

  # Every check past the serial resolution runs here, so each refusal's audit
  # entry carries the identity that was asserted (and the account once one is
  # known) rather than an anonymous refusal.
  defp authorize_mint(row, identity, nonce) do
    with :ok <- check_principal(row, identity.principal),
         :ok <- check_fingerprint(row, identity.fingerprint),
         :ok <- check_window(row),
         {:ok, user} <- resolve_account(row),
         :ok <- check_verification_gate(user),
         :ok <- check_credential_epoch(row, user) do
      with :ok <- claim_nonce(nonce, row),
           {:ok, minted} <- issue_token(user) do
        audit(%{
          account_id: row.account_id,
          action: :minted,
          outcome: :ok,
          serial: identity.serial,
          principal: row.principal,
          fingerprint: row.fingerprint
        })

        {:ok, minted}
      else
        {:error, reason} -> refuse(reason, identity)
      end
    else
      {:error, reason} -> refuse(reason, identity)
    end
  end

  # ---------------------------------------------------------------------------
  # internals — request shape
  # ---------------------------------------------------------------------------

  defp parse_serial(value) when is_integer(value) and value > 0, do: {:ok, value}

  defp parse_serial(value) when is_binary(value) do
    case Integer.parse(value) do
      {serial, ""} when serial > 0 -> {:ok, serial}
      _other -> {:error, :invalid_serial}
    end
  end

  defp parse_serial(_value), do: {:error, :invalid_serial}

  defp parse_principal(value) when is_binary(value) do
    case String.trim(value) do
      "" -> {:error, :invalid_principal}
      principal when byte_size(principal) > 64 -> {:error, :invalid_principal}
      principal -> {:ok, principal}
    end
  end

  defp parse_principal(_value), do: {:error, :invalid_principal}

  defp parse_fingerprint(value) when is_binary(value) do
    case CertificateStore.normalize_fingerprint(value) do
      "" -> {:error, :invalid_fingerprint}
      normalized -> {:ok, normalized}
    end
  end

  defp parse_fingerprint(_value), do: {:error, :invalid_fingerprint}

  defp parse_nonce(value) when is_binary(value) do
    if byte_size(value) in @nonce_bytes_range, do: {:ok, value}, else: {:error, :invalid_nonce}
  end

  defp parse_nonce(_value), do: {:error, :invalid_nonce}

  defp check_asserted_at(asserted_at) do
    with {:ok, seconds} <- parse_asserted_at(asserted_at) do
      if abs(System.os_time(:second) - seconds) <= acceptance_window_s(),
        do: :ok,
        else: {:error, :stale_assertion}
    end
  end

  defp parse_asserted_at(value) when is_integer(value) and value > 0, do: {:ok, value}

  defp parse_asserted_at(value) when is_binary(value) do
    case Integer.parse(value) do
      {seconds, ""} when seconds > 0 -> {:ok, seconds}
      _other -> {:error, :invalid_asserted_at}
    end
  end

  defp parse_asserted_at(_value), do: {:error, :invalid_asserted_at}

  # ---------------------------------------------------------------------------
  # internals — identity checks
  # ---------------------------------------------------------------------------

  defp resolve_serial(serial) do
    case CertificateStore.get_by_serial(serial) do
      nil -> {:error, :unknown_serial}
      row -> {:ok, row}
    end
  end

  defp check_principal(%{principal: expected}, principal) do
    if expected == principal, do: :ok, else: {:error, :principal_mismatch}
  end

  defp check_fingerprint(%{fingerprint: expected}, fingerprint) do
    if CertificateStore.fingerprint_match?(expected, fingerprint),
      do: :ok,
      else: {:error, :fingerprint_mismatch}
  end

  # The addressable check is the issuance row, not the certificate: a row that
  # has aged out is refused even though the certificate's signature would still
  # verify (the plan's "refused on more than signature alone").
  defp check_window(%{valid_before: nil}), do: {:error, :certificate_expired}

  defp check_window(%{valid_before: valid_before}) do
    if DateTime.compare(valid_before, DateTime.utc_now()) == :gt,
      do: :ok,
      else: {:error, :certificate_expired}
  end

  defp resolve_account(%{account_id: account_id}) do
    case User.get(account_id) do
      nil -> {:error, :unknown_account}
      %{deleted_at: deleted_at} when not is_nil(deleted_at) -> {:error, :account_deleted}
      user -> if machine_account?(account_id), do: {:error, :machine_account}, else: {:ok, user}
    end
  end

  # A machine principal (bot/agent/webhook) has a `users` row too, but never a
  # human session: a JWT minted for one resolves as `kind: :human`, i.e. the
  # machine acting with a person's full reach instead of its parent ∩ grant.
  # Fail-CLOSED here (this is a mint): an unreadable principals table refuses.
  defp machine_account?(account_id) do
    Cytale.Accounts.Principals.get(account_id) != nil
  rescue
    _ -> true
  end

  # The product's own gate, consulted rather than re-implemented: with
  # CYTALE_REQUIRE_VERIFIED=false a stack keeps its terminal working.
  defp check_verification_gate(user) do
    if Cytale.Config.require_verified_email?() and is_nil(user.email_verified_at),
      do: {:error, :unverified},
      else: :ok
  end

  defp check_credential_epoch(row, user) do
    if Auth.credential_epoch(user.user_id) > (row.credential_epoch || 0),
      do: {:error, :credential_epoch_moved},
      else: :ok
  end

  # ---------------------------------------------------------------------------
  # internals — replay guard + mint
  # ---------------------------------------------------------------------------

  # Single use, keyed by the NONCE (never the serial — see the moduledoc). The
  # LWT is what makes it atomic: two simultaneous copies of one assertion
  # cannot both win. The TTL is twice the acceptance window, so the table only
  # ever holds the current window's worth of rows and a nonce that has aged out
  # cannot be replayed anyway (its assertion would be stale).
  #
  # The `[applied]` result column is verified against ScyllaDB (cqlsh probe,
  # 2026-09-13): an applied insert returns one row with `[applied] = true`, a
  # refused one returns `[applied] = false` plus the existing row's values.
  defp claim_nonce(nonce, row) do
    ttl = acceptance_window_s() * 2

    case Repo.execute(
           "INSERT INTO {{K}}.ssh_bridge_nonces (nonce, account_id, serial, created_at) VALUES (?, ?, ?, ?) IF NOT EXISTS USING TTL ?",
           [
             {"text", nonce},
             {"bigint", row.account_id},
             {"bigint", row.serial},
             {"timestamp", DateTime.utc_now() |> DateTime.truncate(:millisecond)},
             {"int", ttl}
           ]
         ) do
      {:ok, page} ->
        if applied?(page), do: :ok, else: {:error, :replayed_assertion}

      {:error, reason} ->
        # A guard the server cannot write is a guard it cannot honour: refuse
        # rather than mint on an unverified single-use record.
        Logger.error("session bridge nonce guard unavailable: #{inspect(reason)}")
        {:error, :mint_failed}
    end
  end

  defp applied?(page) do
    case page |> Enum.to_list() |> List.first() do
      %{"[applied]" => true} -> true
      _other -> false
    end
  end

  defp issue_token(user) do
    token =
      Auth.issue_access_token(user.user_id, user.username, not is_nil(user.email_verified_at))

    {:ok,
     %{
       access_token: token,
       token_type: "Bearer",
       expires_in: div(Cytale.Config.access_token_ttl_ms(), 1000),
       # The identity the host has just proven, handed back so the client starts
       # knowing who it is rather than resolving it a second time.
       username: user.username
     }}
  rescue
    _ -> {:error, :mint_failed}
  end

  # Every refusal is audited with its reason (R8b), against the account when one
  # resolved and the unknown-account partition when none did.
  defp refuse(reason, context) do
    audit(%{
      account_id: context[:account_id],
      action: :mint_refused,
      outcome: :refused,
      reason: reason,
      # The asserted values arrive as request-body STRINGS, and the audit
      # columns are `bigint`. Xandra type-checks the bound value against the
      # declared type, so a string serial raises FunctionClauseError inside the
      # protocol encoder and the refusal goes unrecorded — silently, because a
      # failed audit write is deliberately non-fatal. Coerce here so a refusal
      # is always auditable, including one that fails before the serial parsed.
      serial: audit_serial(context[:serial]),
      principal: audit_string(context[:principal]),
      fingerprint: audit_string(context[:fingerprint])
    })

    {:error, reason}
  end

  defp audit_serial(value) when is_integer(value), do: value

  defp audit_serial(value) when is_binary(value) do
    case Integer.parse(value) do
      {serial, ""} -> serial
      _other -> nil
    end
  end

  defp audit_serial(_value), do: nil

  defp audit_string(value) when is_binary(value), do: value
  defp audit_string(_value), do: nil

  defp audit(event) do
    case Audit.record(event) do
      :ok -> :ok
      {:error, _reason} -> :ok
    end
  end

  # ---------------------------------------------------------------------------
  # internals — config plumbing
  # ---------------------------------------------------------------------------

  defp config do
    case Application.get_env(:cytale, @config_scope, []) do
      list when is_list(list) -> if Keyword.keyword?(list), do: list, else: []
      map when is_map(map) -> Map.to_list(map)
      _other -> []
    end
  end

  defp read_credential({:path, path}) do
    case File.read(path) do
      {:ok, body} -> String.trim(body)
      {:error, reason} -> raise "session bridge credential unreadable at #{path}: #{inspect(reason)}"
    end
  end

  defp read_credential({:value, :configured}) do
    config()[:credential] || System.get_env("CYTALE_SESSION_BRIDGE_CREDENTIAL") || ""
  end

  defp sha256(bin), do: :crypto.hash(:sha256, bin)
end
