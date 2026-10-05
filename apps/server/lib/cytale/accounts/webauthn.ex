defmodule Cytale.Accounts.WebAuthn do
  @moduledoc """
  WebAuthn passkey ceremonies (ticket #36) — passkeys are the ADDITIVE second
  login credential beside the password (bottom-button v1; passwordless signup
  is explicitly deferred). This module owns:

    * config — `enabled?/0` (CYTALE_AUTH_PASSKEYS / `[:webauthn, :enabled]`),
      the RP ID and origin allowlist, the challenge TTL;
    * the RP-ID derivation — `rp_id_from_origin/1`, a tested pure function
      (an origin URL → the registrable host, no scheme/port);
    * the two ceremonies, both built on `wax_` (the library does all
      WebAuthn crypto: CBOR/COSE parsing, ES256/RS256 verification — nothing
      here hand-rolls any of it):
        - REGISTRATION (authenticated): `new_registration/1` issues the
          challenge + PublicKeyCredentialCreationOptions JSON;
          `verify_registration/4` verifies the attestation (policy `none`)
          and stores the credential;
        - AUTHENTICATION (pre-auth, DISCOVERABLE): `new_authentication/0`
          issues an empty-`allowCredentials` challenge — the browser's own
          picker chooses the identity, no username is typed;
          `verify_authentication/3` resolves the credential server-side,
          verifies the assertion (signature against the stored COSE key,
          challenge bytes, origin, RP-ID hash — wax), enforces sign-count
          monotonicity, and returns the account for token issuance.

  Security posture (all per ticket, non-negotiable):

    * challenges are single-use and session-bound: random opaque id +
      `%Wax.Challenge{}` in `ChallengeStore` (ETS, TTL ~2 min, consumed on
      use); registration challenges are additionally bound to the enrolling
      account;
    * RP-ID + origin validation runs on EVERY ceremony — wax checks the
      client-data origin against the configured allowlist and the
      authenticator-data RP-ID hash against the derived RP ID;
    * sign-count monotonicity (`counter_ok?/2`): a non-increasing counter on
      an authenticator that HAS counted refuses the login (clone detection).
      The spec's documented counter=0 edge — authenticators that never count
      stay at 0 forever — is accepted;
    * credential ids are globally unique (LWT gate in `Credentials.put/1`).

  Login success returns the user; the controller then issues the EXACT
  token pair `POST /auth/login` returns — passkey is a credential-check swap
  at one seam, and everything downstream (refresh rotation, gateway JWT,
  credential epoch) is unchanged.
  """

  alias Cytale.Accounts.{User, WebAuthn.Credential, WebAuthn.Credentials, WebAuthn.ChallengeStore}

  require Logger

  @rp_id_default "localhost"

  # ---------------------------------------------------------------------------
  # Config
  # ---------------------------------------------------------------------------

  @doc "Whether the passkey surface answers at all (`auth.passkeys_enabled`)."
  @spec enabled?() :: boolean()
  def enabled?, do: Cytale.Config.webauthn_enabled?()

  @doc """
  Whether the passkey surface is ADVERTISED and answers: enabled AND a real
  RP ID derivable (explicit override or the external origin). The
  `"localhost"` fallback is never advertised — credentials enrolled against it
  cannot survive the deploy getting its real domain.
  """
  @spec available?() :: boolean()
  def available?, do: Cytale.Config.webauthn_available?()

  @doc "Challenge lifetime in seconds (one browser prompt)."
  @spec challenge_timeout_s() :: pos_integer()
  def challenge_timeout_s, do: Cytale.Config.webauthn_challenge_timeout_s()

  @doc """
  The RP ID every ceremony is baked to: explicit `[:webauthn, :rp_id]` when
  configured, else derived from the deploy's external origin, else
  `"localhost"` (bare dev). A credential is registered AGAINST this id —
  credentials enrolled on one RP ID cannot authenticate on another, which is
  why the derivation (and the prod domain existing at all) matters.
  """
  @spec rp_id() :: String.t()
  def rp_id do
    case Cytale.Config.webauthn_rp_id() do
      id when is_binary(id) and id != "" ->
        id

      _ ->
        case Cytale.Config.external_base_url() do
          nil ->
            @rp_id_default

          origin ->
            # UNWRAP: rp_id_from_origin/1 answers {:ok, host} | :error, and
            # passing the tuple whole reached Wax as a non-binary rp_id —
            # "Missing mandatory parameter `rp_id`", a 500 on the login page's
            # options fetch the moment a deploy sets CYTALE_EXTERNAL_BASE_URL
            # (live incident 2026-09-19). A malformed origin degrades to the
            # dev default rather than crashing the ceremony.
            case rp_id_from_origin(origin) do
              {:ok, host} -> host
              :error -> @rp_id_default
            end
        end
    end
  end

  @doc """
  The EXACT origins a ceremony's clientDataJSON may carry (wax string-matches
  the browser's serialized origin). Explicit `[:webauthn, :origins]` wins;
  else the external origin; else the loopback dev pair.

  Each configured value is normalized to a serialized origin
  (`origin_from_url/1`) before the match: the browser never sends a trailing
  slash, a path or a default port, while an operator's
  `CYTALE_EXTERNAL_BASE_URL=https://chat.example.com/` is accepted everywhere
  else (`CytaleWeb.ExternalUrl` trims the slash). Matched verbatim, that one
  slash refused every passkey on the deploy.
  """
  @spec origins() :: [String.t()]
  def origins do
    case Cytale.Config.webauthn_origins() do
      [_ | _] = origins ->
        Enum.map(origins, &normalize_origin/1)

      _ ->
        case Cytale.Config.external_base_url() do
          nil ->
            ["http://localhost:4000", "http://127.0.0.1:4000"]

          origin ->
            [normalize_origin(origin)]
        end
    end
  end

  @doc """
  The serialized origin of a URL, as a browser writes it into clientDataJSON:
  lowercase scheme and host, the port only when it is not the scheme's
  default, and no path, query, fragment or trailing slash.

      iex> Cytale.Accounts.WebAuthn.origin_from_url("https://Chat.Example.com/")
      {:ok, "https://chat.example.com"}

      iex> Cytale.Accounts.WebAuthn.origin_from_url("https://chat.example.com:443/app")
      {:ok, "https://chat.example.com"}

      iex> Cytale.Accounts.WebAuthn.origin_from_url("http://localhost:4000")
      {:ok, "http://localhost:4000"}

  `:error` for anything without a scheme and a host.
  """
  @spec origin_from_url(String.t()) :: {:ok, String.t()} | :error
  def origin_from_url(url) when is_binary(url) do
    case URI.new(String.trim(url)) do
      {:ok, %URI{scheme: scheme, host: host, port: port}}
      when is_binary(scheme) and scheme != "" and is_binary(host) and host != "" ->
        scheme = String.downcase(scheme)
        default_port = URI.default_port(scheme)
        port_suffix = if is_nil(port) or port == default_port, do: "", else: ":#{port}"
        {:ok, "#{scheme}://#{String.downcase(host)}#{port_suffix}"}

      _ ->
        :error
    end
  end

  def origin_from_url(_), do: :error

  # An unparseable configured origin stays as written: it can never match a
  # browser's origin, and the refusal it causes is logged as :wrong_origin.
  defp normalize_origin(value) do
    case origin_from_url(value) do
      {:ok, origin} -> origin
      :error -> value
    end
  end

  @doc """
  RP-ID derivation — a tested PURE function (ticket requirement): the origin
  URL's HOST, lowercased, scheme/port/userinfo/path stripped. WebAuthn
  requires the RP ID to be equal to (or a registrable suffix of) the origin
  host; using the host itself is always valid, and a deploy that wants a
  parent-domain RP ID (subdomain-wide passkeys) sets `[:webauthn, :rp_id]`
  explicitly instead of widening this rule.

      iex> Cytale.Accounts.WebAuthn.rp_id_from_origin("https://chat.example.com")
      {:ok, "chat.example.com"}

      iex> Cytale.Accounts.WebAuthn.rp_id_from_origin("http://localhost:4000")
      {:ok, "localhost"}

  `:error` for anything without a hostname (an origin is scheme + host, so
  this refuses garbage rather than guessing).
  """
  @spec rp_id_from_origin(String.t()) :: {:ok, String.t()} | :error
  def rp_id_from_origin(origin) when is_binary(origin) do
    case URI.new(origin) do
      {:ok, %URI{host: host}} when is_binary(host) and host != "" ->
        {:ok, String.downcase(host)}

      _ ->
        :error
    end
  end

  def rp_id_from_origin(_), do: :error

  # ---------------------------------------------------------------------------
  # REGISTRATION ceremony (authenticated user, settings surface)
  # ---------------------------------------------------------------------------

  @doc """
  Mint a registration ceremony for `user_id`. Returns
  `%{challenge_id: id, options: public_key_options_map}` — the options map is
  the `PublicKeyCredentialCreationOptionsJSON` the browser consumes verbatim
  (challenge base64url; `excludeCredentials` lists what is already enrolled).
  """
  @spec new_registration(integer()) :: %{challenge_id: String.t(), options: map()}
  def new_registration(user_id) when is_integer(user_id) do
    challenge =
      Wax.new_registration_challenge(
        origin: origins(),
        rp_id: rp_id(),
        attestation: "none",
        user_verification: "preferred",
        timeout: challenge_timeout_s()
      )

    challenge_id = ChallengeStore.put(challenge, user_id)

    existing =
      user_id
      |> Credentials.list_for_user()
      |> Enum.map(fn cred -> %{type: "public-key", id: cred.credential_id} end)

    user = User.get(user_id)
    username = user && user.username

    options = %{
      challenge: Base.url_encode64(challenge.bytes, padding: false),
      rp: %{id: rp_id(), name: "Hrmny"},
      user: %{
        # The user handle: the account id, fixed-width big-endian — the
        # authenticator echoes it on discoverable logins, and the verify
        # path cross-checks it against the credential's owner.
        id: user_handle_encode(user_id),
        name: username || "user-#{user_id}",
        displayName: username || "user-#{user_id}"
      },
      pubKeyCredParams: [
        %{type: "public-key", alg: -7},
        %{type: "public-key", alg: -257}
      ],
      timeout: challenge_timeout_s() * 1000,
      attestation: "none",
      excludeCredentials: existing,
      authenticatorSelection: %{
        residentKey: "preferred",
        userVerification: "preferred"
      }
    }

    %{challenge_id: challenge_id, options: options}
  end

  @doc """
  Verify a registration response. `attestation_object_b64` and
  `client_data_json_b64` are base64url of the browser's `navigator.credentials.create()`
  artifacts. The challenge must exist, be unspent, belong to `user_id`, and
  wax must accept the attestation. Errors:

    * `{:error, :challenge_invalid}` — unknown/expired/already-consumed
      challenge, or a challenge minted for a DIFFERENT user;
    * `{:error, :ceremony_failed}` — wax refused (origin, RP-ID hash,
      challenge mismatch, malformed attestation, untrusted type);
    * `{:error, :credential_id_taken}` — the credential id is already
      registered.
  """
  @spec verify_registration(integer(), String.t(), String.t(), String.t(), String.t()) ::
          {:ok, Credential.t()} | {:error, :challenge_invalid | :ceremony_failed | :credential_id_taken}
  def verify_registration(user_id, challenge_id, name, attestation_object_b64, client_data_json_b64)
      when is_integer(user_id) and is_binary(challenge_id) and is_binary(attestation_object_b64) and
             is_binary(client_data_json_b64) do
    with {:ok, %{challenge: challenge, user_id: ^user_id}} <- ChallengeStore.consume(challenge_id),
         {:ok, attestation_object, client_data_json} <-
           decode_pair(attestation_object_b64, client_data_json_b64),
         {:ok, {auth_data, _attestation_result}} <-
           Wax.register(attestation_object, client_data_json, challenge) do
      attested = auth_data.attested_credential_data

      credential =
        Credential.new(
          user_id: user_id,
          credential_id: Base.url_encode64(attested.credential_id, padding: false),
          public_key_b64: encode_cose_key(attested.credential_public_key),
          sign_count: auth_data.sign_count,
          backup_eligible: auth_data.flag_backup_eligible,
          backup_state: auth_data.flag_credential_backed_up,
          name: sanitize_name(name)
        )

      case Credentials.put(credential) do
        :ok -> {:ok, credential}
        {:error, _} -> {:error, :credential_id_taken}
      end
    else
      # The exact error taxonomy, most specific first: a spent/unknown/foreign
      # challenge is a CHALLENGE failure; everything wax or the decode refused
      # is a CEREMONY failure (origin, RP-ID hash, challenge-bytes mismatch,
      # malformed attestation, untrusted attestation type).
      {:ok, %{challenge: _, user_id: _other}} -> {:error, :challenge_invalid}
      {:error, :not_found} -> {:error, :challenge_invalid}
      {:error, :ceremony_failed} -> {:error, :ceremony_failed}
      {:error, _wax_exception} -> {:error, :ceremony_failed}
      _ -> {:error, :ceremony_failed}
    end
  end

  def verify_registration(_, _, _, _, _), do: {:error, :ceremony_failed}

  # ---------------------------------------------------------------------------
  # AUTHENTICATION ceremony (pre-auth, discoverable — the bottom button)
  # ---------------------------------------------------------------------------

  @doc """
  Mint an authentication challenge with EMPTY allowCredentials — the
  discoverable flow: the browser's own picker chooses the identity, no
  username is typed, and `login/options` carries no identifier (no
  account-existence oracle by construction).
  """
  @spec new_authentication() :: %{challenge_id: String.t(), options: map()}
  def new_authentication do
    challenge =
      Wax.new_authentication_challenge(
        origin: origins(),
        rp_id: rp_id(),
        user_verification: "preferred",
        timeout: challenge_timeout_s(),
        allow_credentials: []
      )

    challenge_id = ChallengeStore.put(challenge, nil)

    options = %{
      challenge: Base.url_encode64(challenge.bytes, padding: false),
      rpId: rp_id(),
      timeout: challenge_timeout_s() * 1000,
      userVerification: "preferred"
    }

    %{challenge_id: challenge_id, options: options}
  end

  @doc """
  Verify a discoverable assertion. The credential is resolved server-side by
  its id (`raw_id_b64`); wax verifies the signature against the stored COSE
  key plus challenge bytes, origin and RP-ID hash; the sign count must be
  monotonic; the echoed userHandle (when present) must name the credential's
  owner; and the owner must be a live (non-deleted) account. On success the
  usage is recorded and `{:ok, user, credential_id}` returns for token
  issuance.

  The refusals, in the order they are decided:

    * `{:error, :challenge_invalid}` — the ceremony id is unknown, expired
      (`challenge_timeout_s/0`) or already spent: nothing about the
      credential has been looked at yet;
    * `{:error, :ceremony_failed}` — the browser's response does not belong
      to THIS ceremony on THIS server: the client data is not a `webauthn.get`
      for this challenge, its origin is not one `origins/0` allows, or the
      authenticator data is not hashed for `rp_id/0`. All of it is decided
      from the response and the server's own configuration BEFORE any
      credential or account is read, so it is no account oracle — and it is
      the one refusal an operator can fix (a deploy reached under an address
      its passkey settings do not name);
    * `{:error, :invalid_credentials}` — every refusal that does touch a
      credential (unknown credential, bad signature, stale counter, user
      handle mismatch, deleted account) collapses to this one answer, the
      same the password path gives: no oracle.

  Every refusal is logged at `info` with its specific reason (never an id, a
  token or a body), so an operator can tell "not registered here" from
  "wrong origin" when a member reports that passkeys fail.
  """
  @spec verify_authentication(String.t(), String.t(), String.t(), String.t(), String.t(), String.t() | nil) ::
          {:ok, User.t(), String.t()} | {:error, :challenge_invalid | :ceremony_failed | :invalid_credentials}
  def verify_authentication(
        challenge_id,
        raw_id_b64,
        authenticator_data_b64,
        signature_b64,
        client_data_json_b64,
        user_handle_b64
      )
      when is_binary(challenge_id) and is_binary(raw_id_b64) and is_binary(authenticator_data_b64) and
             is_binary(signature_b64) and is_binary(client_data_json_b64) do
    with {:ok, challenge} <- consume_login_challenge(challenge_id),
         {:ok, auth_data, client_data_json} <-
           tag(decode_auth_and_client(authenticator_data_b64, client_data_json_b64), :malformed_response),
         :ok <- ceremony_matches(challenge, auth_data, client_data_json),
         {:ok, raw_id} <- tag(b64url_decode(raw_id_b64), :malformed_response),
         {:ok, credential} <- tag(Credentials.get(raw_id_b64), :unknown_credential),
         {:ok, cose_key} <- tag(decode_cose_key(credential.public_key_b64), :unreadable_stored_key),
         {:ok, signature} <- tag(b64url_decode(signature_b64), :malformed_response),
         :ok <- tag(user_handle_matches?(user_handle_b64, credential.user_id), :user_handle_mismatch),
         {:ok, %Wax.AuthenticatorData{} = verified} <-
           tag(
             Wax.authenticate(raw_id, auth_data, signature, client_data_json, challenge, [{raw_id, cose_key}]),
             :assertion_refused
           ),
         :ok <- tag(enforce_counter(credential.sign_count, verified.sign_count), :stale_counter),
         # User records are plain maps (User.t), never structs.
         {:ok, user} <- live_owner(credential.user_id) do
      :ok = Credentials.record_usage(user.user_id, raw_id_b64, verified.sign_count, DateTime.utc_now())
      {:ok, user, raw_id_b64}
    else
      {:refused, reason} -> refuse_login(reason)
    end
  end

  def verify_authentication(_, _, _, _, _, _), do: refuse_login(:malformed_response)

  # The public answer for each logged reason: the three outcomes the doc above
  # lists, and nothing finer — the finer reason exists for the log line only.
  @challenge_reasons [:challenge_unknown_or_expired, :challenge_not_for_login]
  @ceremony_reasons [:wrong_type, :wrong_challenge, :wrong_origin, :wrong_rp_id]

  defp refuse_login(reason) do
    Logger.info("webauthn login refused: #{reason}")

    cond do
      reason in @challenge_reasons -> {:error, :challenge_invalid}
      reason in @ceremony_reasons -> {:error, :ceremony_failed}
      true -> {:error, :invalid_credentials}
    end
  end

  defp consume_login_challenge(challenge_id) do
    case ChallengeStore.consume(challenge_id) do
      {:ok, %{challenge: challenge, user_id: nil}} -> {:ok, challenge}
      {:ok, %{challenge: _, user_id: _bound}} -> {:refused, :challenge_not_for_login}
      {:error, :not_found} -> {:refused, :challenge_unknown_or_expired}
    end
  end

  # Normalize a step's result into `{:ok, value}` / `:ok`, or `{:refused, reason}`.
  defp tag(:ok, _reason), do: :ok
  defp tag({:ok, value}, _reason), do: {:ok, value}
  defp tag({:ok, a, b}, _reason), do: {:ok, a, b}
  defp tag(nil, reason), do: {:refused, reason}
  defp tag(:error, reason), do: {:refused, reason}
  defp tag({:error, _}, reason), do: {:refused, reason}
  defp tag(value, _reason), do: {:ok, value}

  defp live_owner(user_id) do
    case User.get(user_id) do
      %{deleted_at: nil} = user -> {:ok, user}
      _ -> {:refused, :account_unavailable}
    end
  end

  @doc """
  Whether a login response belongs to THIS ceremony on THIS server — the
  checks wax repeats during `Wax.authenticate/6`, run first and on their own
  so a mismatch is classified (`:ceremony_failed`) before any credential is
  read: the client data must be a `webauthn.get` for the challenge's bytes
  from an allowed origin, and the authenticator data must be hashed for the
  challenge's RP ID. `:ok` or `{:refused, reason}`.
  """
  @spec ceremony_matches(Wax.Challenge.t(), binary(), binary()) :: :ok | {:refused, atom()}
  def ceremony_matches(%Wax.Challenge{} = challenge, auth_data, client_data_json)
      when is_binary(auth_data) and is_binary(client_data_json) do
    with {:ok, %{} = client_data} <- tag(Jason.decode(client_data_json), :malformed_response),
         :ok <- check(client_data["type"] == "webauthn.get", :wrong_type),
         :ok <- check(challenge_echoed?(client_data["challenge"], challenge.bytes), :wrong_challenge),
         :ok <- check(client_data["origin"] in List.wrap(challenge.origin), :wrong_origin) do
      check(rp_id_hash_matches?(auth_data, challenge.rp_id), :wrong_rp_id)
    else
      {:ok, _not_an_object} -> {:refused, :malformed_response}
      {:refused, _} = refused -> refused
    end
  end

  defp check(true, _reason), do: :ok
  defp check(_, reason), do: {:refused, reason}

  defp challenge_echoed?(echoed, bytes) when is_binary(echoed) do
    case b64url_decode(echoed) do
      {:ok, ^bytes} -> true
      _ -> false
    end
  end

  defp challenge_echoed?(_, _), do: false

  defp rp_id_hash_matches?(<<rp_id_hash::binary-size(32), _rest::binary>>, rp_id) when is_binary(rp_id),
    do: rp_id_hash == :crypto.hash(:sha256, rp_id)

  defp rp_id_hash_matches?(_, _), do: false

  # ---------------------------------------------------------------------------
  # Counter monotonicity (clone detection, incl. the documented 0-counter edge)
  # ---------------------------------------------------------------------------

  @doc """
  Sign-count monotonicity. An authenticator that counts must ALWAYS increase:
  `new` at or below `stored` (once stored > 0) means a cloned credential —
  refuse. The spec's counter=0 edge (authenticators that never implement a
  counter report 0 forever) is the one accepted tie.
  """
  @spec counter_ok?(non_neg_integer(), non_neg_integer()) :: boolean()
  def counter_ok?(stored, new) when is_integer(stored) and is_integer(new) do
    new > stored or (stored == 0 and new == 0)
  end

  defp enforce_counter(stored, new) do
    if counter_ok?(stored, new), do: :ok, else: {:error, :stale_counter}
  end

  # ---------------------------------------------------------------------------
  # Encoding helpers
  # ---------------------------------------------------------------------------

  @doc "The user handle: the account id as fixed 8-byte big-endian, base64url."
  @spec user_handle_encode(integer()) :: String.t()
  def user_handle_encode(user_id) when is_integer(user_id) do
    <<user_id::unsigned-big-integer-size(64)>> |> Base.url_encode64(padding: false)
  end

  @doc "Decode a user handle back to an account id, `:error` on anything else."
  @spec user_handle_decode(String.t()) :: {:ok, integer()} | :error
  def user_handle_decode(b64) when is_binary(b64) do
    with {:ok, <<user_id::unsigned-big-integer-size(64)>>} <- b64url_decode(b64) do
      {:ok, user_id}
    end
  end

  def user_handle_decode(_), do: :error

  # The COSE key wax hands back is a plain map (small integer keys → binaries
  # or integers), so `term_to_binary` + base64 is a lossless at-rest encoding
  # (wax's own recommendation); `binary_to_term/2` with [:safe] on the way out
  # refuses anything that is not plain data.

  defp encode_cose_key(cose_key) when is_map(cose_key) do
    cose_key |> :erlang.term_to_binary() |> Base.encode64()
  end

  defp decode_cose_key(b64) when is_binary(b64) do
    with {:ok, bin} <- Base.decode64(b64),
         {:ok, cose_key} <- safe_binary_to_term(bin),
         true <- is_map(cose_key) do
      cose_key
    else
      _ -> nil
    end
  end

  # #125 triage (2026-09-20, sobelow Misc.BinToTerm High Confidence): the
  # [:safe] option is exactly the mitigation — it refuses to create NEW atoms,
  # closing the atom-table-exhaustion DoS the check guards. The rescue wraps
  # the malformed-input case. Do not remove [:safe] without re-triaging. The
  # finding is on scripts/security-scan.sh's expected-findings ledger.
  defp safe_binary_to_term(bin) do
    {:ok, :erlang.binary_to_term(bin, [:safe])}
  rescue
    _ -> :error
  end

  defp b64url_decode(b64) when is_binary(b64) do
    case Base.url_decode64(b64, padding: false) do
      {:ok, bin} ->
        {:ok, bin}

      :error ->
        Base.decode64(b64)
        |> case do
          {:ok, bin} -> {:ok, bin}
          :error -> :error
        end
    end
  end

  defp b64url_decode(_), do: :error

  defp decode_pair(attestation_b64, client_data_b64) do
    with {:ok, att} <- b64url_decode(attestation_b64),
         {:ok, cdj} <- b64url_decode(client_data_b64) do
      {:ok, att, cdj}
    else
      _ -> {:error, :ceremony_failed}
    end
  end

  defp decode_auth_and_client(auth_data_b64, client_data_b64) do
    with {:ok, auth_data} <- b64url_decode(auth_data_b64),
         {:ok, cdj} <- b64url_decode(client_data_b64) do
      {:ok, auth_data, cdj}
    else
      _ -> {:error, :invalid_credentials}
    end
  end

  # A credential's display name: present, bounded, on one line.
  defp sanitize_name(name) when is_binary(name) do
    name
    |> String.replace(~r/[\r\n\t]+/, " ")
    |> String.trim()
    |> String.slice(0, 64)
    |> case do
      "" -> nil
      cleaned -> cleaned
    end
  end

  defp sanitize_name(_), do: nil

  # ---------------------------------------------------------------------------
  # userHandle cross-check
  # ---------------------------------------------------------------------------

  # Some authenticators omit userHandle on a discoverable get even when one
  # was set at registration (spec-permitted); an absent handle proves nothing
  # and is accepted. A PRESENT handle names the account — it must agree with
  # the credential's owner or the assertion is refused (defense in depth on
  # top of wax's signature check).
  defp user_handle_matches?(nil, _user_id), do: :ok

  defp user_handle_matches?(user_handle_b64, user_id) do
    case user_handle_decode(user_handle_b64) do
      {:ok, ^user_id} -> :ok
      _ -> {:error, :user_handle_mismatch}
    end
  end
end
