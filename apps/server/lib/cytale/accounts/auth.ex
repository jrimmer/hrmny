defmodule Cytale.Accounts.Auth do
  @moduledoc """
  Authentication primitives (U8): argon2id password hashing, JWT access
  tokens (15 min), rotating refresh tokens (30 days), and signed single-use
  verification/reset tokens with TTL + purpose scoping.

  Secrets & Keys decision (binding): the JWT signing secret and the refresh
  pepper come from application config set fail-fast in runtime.exs —
  `[:auth, :jwt_secret]` and `[:auth, :refresh_pepper]`. Dev/test may default
  in config/{dev,test}.exs. Refresh tokens are stored only as
  HMAC-SHA256(pepper, raw) hex — raw refresh tokens never touch storage.

  Verification/reset tokens are JWK-signed JWTs whose `jti` is the SHA-256
  hash recorded in the `verification_tokens` table (single-use: the row is
  deleted on consumption; purpose scoping rides the `purpose` claim and is
  cross-checked against the stored row's purpose on verify).
  """

  require Logger

  alias Cytale.Accounts.TokenStore

  # The `typ` claim every access token carries (see `access_typed?/1`).
  @access_typ "access"

  @typedoc """
  Claims carried by a verified access token.

  `epoch` is the account's credential epoch at mint time, or `nil` for a token
  minted before the claim existed (accepted only for accounts with no stored
  epoch — see `epoch_current?/2`).
  """
  @type access_claims :: %{
          user_id: integer(),
          username: String.t(),
          verified: boolean(),
          epoch: integer() | nil
        }

  @typedoc "A freshly minted token pair."
  @type token_pair :: %{
          access_token: String.t(),
          refresh_token: String.t(),
          token_type: String.t(),
          expires_in: integer()
        }

  # ---------------------------------------------------------------------------
  # Passwords — argon2id (OWASP-tuned parameters pinned by argon2_elixir 4.1)
  # ---------------------------------------------------------------------------

  #
  # Every Argon2 computation runs through `Cytale.Accounts.HashGate` (at most
  # N at once, a short queue, then 503) — each one allocates the full memory
  # cost, and an unbounded burst of them can OOM the node.

  @spec hash_password(String.t()) :: String.t()
  def hash_password(password) when is_binary(password) do
    Cytale.Accounts.HashGate.run(fn -> Argon2.hash_pwd_salt(password) end)
  end

  @spec valid_password?(String.t(), String.t()) :: boolean()
  def valid_password?(password, stored_hash) when is_binary(password) and is_binary(stored_hash) do
    # The gate's Busy raise stays OUTSIDE the rescue below: an overloaded
    # server is a 503, never a "wrong password" (which would also count
    # against the account's attempt dam).
    Cytale.Accounts.HashGate.run(fn -> verify_pass(password, stored_hash) end)
  end

  def valid_password?(_, _), do: false

  @doc """
  The unknown-account branch's dummy verify (`Argon2.no_user_verify/0`),
  through the same gate, so a miss costs the same time and memory as a hit.
  """
  @spec no_user_verify() :: false
  def no_user_verify do
    Cytale.Accounts.HashGate.run(fn -> Argon2.no_user_verify() end)
  end

  defp verify_pass(password, stored_hash) do
    Argon2.verify_pass(password, stored_hash)
  rescue
    _ -> false
  end

  # ---------------------------------------------------------------------------
  # JWT access tokens (gateway Identify + REST Bearer)
  # ---------------------------------------------------------------------------

  @doc """
  Issue a signed access JWT (HS256, exp = configured 15 min TTL).

  The token carries the account's **credential epoch** (`credential_epoch/1`)
  as an `epoch` claim. That claim is what makes a password reset or a
  revoke-all-sessions end a live session instead of waiting out the session's
  own bound (R13a): the auth plug and the gateway authenticator compare it, and
  the session bridge refuses to mint another once it has moved.

  Cost, stated plainly: this adds ONE `users` row read per mint. Mints are rare
  (login, refresh, bridge renewal) — the per-request half of the epoch check
  lives in the auth plug, which reads the row once per authenticated request.
  """
  @spec issue_access_token(integer(), String.t(), boolean()) :: String.t()
  def issue_access_token(user_id, username, verified?) do
    now = System.system_time(:second)
    # The verification flag (CYTALE_REQUIRE_VERIFIED) lifts the gate for
    # deploys with no working mailer: effective verification is true.
    verified? = verified? or not Cytale.Config.require_verified_email?()

    claims = %{
      "typ" => @access_typ,
      "sub" => Integer.to_string(user_id),
      "username" => username,
      "verified" => verified?,
      "epoch" => credential_epoch(user_id),
      "iat" => now,
      "exp" => now + div(access_token_ttl_ms(), 1000)
    }

    {:ok, token, _claims} = Joken.encode_and_sign(claims, signer())
    token
  end

  @doc """
  Verify an access JWT. Returns the bound claims on success; `{:error, :invalid}`
  for expired/tampered/malformed tokens (never a raise on the hot path).
  """
  @spec verify_access_token(String.t()) :: {:ok, access_claims()} | {:error, :malformed | :invalid}
  def verify_access_token(token) when is_binary(token) do
    {:ok, claims} = Joken.verify_and_validate(claims_def(), token, signer())
    true = access_typed?(claims)

    {:ok,
     %{
       user_id: String.to_integer(claims["sub"]),
       username: claims["username"],
       verified: claims["verified"],
       epoch: claims["epoch"]
     }}
  rescue
    # Joken raises on signature misses, exp misses and structurally-impossible
    # tokens; the hot path only ever sees an error tuple.
    _ -> {:error, :invalid}
  end

  def verify_access_token(_), do: {:error, :malformed}

  @doc """
  Signature-only access-token decode (exp ignored) — refresh-path helper
  (OAuth2 Bearer semantics: a refresh proves identity from a possibly-expired
  access token; freshness is the refresh token's job).
  """
  @spec verify_access_token_ignoring_expiry(String.t()) ::
          {:ok, map()} | {:error, :invalid}
  def verify_access_token_ignoring_expiry(token) when is_binary(token) do
    signer = signer()

    case Joken.verify(token, signer) do
      {:ok, claims} -> if access_typed?(claims), do: {:ok, claims}, else: {:error, :invalid}
      _ -> {:error, :invalid}
    end
  rescue
    _ -> {:error, :invalid}
  end

  # Token typing. Access tokens and the single-use verify/reset tokens share
  # the HS256 key, so the claims — not the signature — are what keep one kind
  # from standing in for the other: an access token carries `typ: "access"`,
  # a single-use token `typ: <purpose>` plus its `purpose` claim. The access
  # path accepts ONLY `typ: "access"`, or — for access tokens minted before
  # the claim existed, which die at their own 15-minute TTL — a token with
  # neither `typ` nor `purpose`. A reset or verify link is never a Bearer.
  defp access_typed?(%{"typ" => @access_typ} = claims), do: not Map.has_key?(claims, "purpose")
  defp access_typed?(%{"typ" => _other}), do: false
  defp access_typed?(%{"purpose" => _}), do: false
  defp access_typed?(%{"sub" => sub}) when is_binary(sub), do: true
  defp access_typed?(_claims), do: false

  # ---------------------------------------------------------------------------
  # Refresh tokens — opaque random, HMAC-hashed at rest, rotating
  # ---------------------------------------------------------------------------
  #
  # The raw token is 32 random bytes and nothing else; the stored lookup key is
  # `HMAC-SHA256(pepper, raw)`, so a leaked `refresh_tokens` table is useless
  # without the pepper. Tokens minted before this scheme were
  # `pepper <> ":" <> random` stored as `SHA-256(raw)` — which handed the
  # pepper to every client. Those still work until they rotate or expire: every
  # lookup tries the HMAC key first and falls back to the legacy key, so the
  # change logs nobody out.

  @doc "Mint an opaque refresh token (32 bytes of entropy, baseurl-encoded)."
  @spec issue_refresh_token(integer()) :: {:ok, String.t(), String.t(), DateTime.t()}
  def issue_refresh_token(user_id) do
    raw = Base.url_encode64(:crypto.strong_rand_bytes(32), padding: false)
    hash = refresh_token_hash(raw)
    expires_at = DateTime.add(DateTime.utc_now(), refresh_token_ttl_ms(), :millisecond)
    :ok = TokenStore.put(user_id, hash, expires_at)
    {:ok, raw, hash, expires_at}
  end

  @doc "The storage key of a raw refresh token: HMAC-SHA256(pepper, raw), hex."
  @spec refresh_token_hash(String.t()) :: String.t()
  def refresh_token_hash(raw) when is_binary(raw),
    do: Base.encode16(:crypto.mac(:hmac, :sha256, pepper(), raw), case: :lower)

  # The pre-HMAC storage key (SHA-256 of the raw token) — read-side only.
  defp legacy_refresh_token_hash(raw), do: sha256_hex(raw)

  # The stored key under which `raw` is live for `user_id`, new scheme first.
  defp live_refresh_hash(user_id, raw) do
    new = refresh_token_hash(raw)
    legacy = legacy_refresh_token_hash(raw)

    cond do
      TokenStore.valid?(user_id, new) -> {:ok, new}
      TokenStore.valid?(user_id, legacy) -> {:ok, legacy}
      true -> :error
    end
  end

  @doc "True when the presented raw refresh token exists (unrevoked, unexpired)."
  @spec refresh_token_valid?(integer(), String.t()) :: boolean()
  def refresh_token_valid?(user_id, raw), do: match?({:ok, _}, live_refresh_hash(user_id, raw))

  @doc "Revoke one presented refresh token (logout), under either storage key."
  @spec revoke_refresh_token(integer(), String.t()) :: :ok
  def revoke_refresh_token(user_id, raw) when is_binary(raw) do
    :ok = TokenStore.delete(user_id, refresh_token_hash(raw))
    :ok = TokenStore.delete(user_id, legacy_refresh_token_hash(raw))
  end

  @doc """
  Rotate: issue a new refresh token and revoke the old one. Returns the new
  `{raw, hash, expires_at}` or `{:error, :revoked}`.

  Rotation leaves a TOMBSTONE of the old token (`TokenStore.mark_rotated/3`,
  kept for the refresh lifetime). That tombstone is what makes replay
  detection (S6) precise: presenting a token that was already rotated away is
  a REPLAY — someone holds a copy — and the whole family dies
  (`revoke_all_sessions/1` deletes every refresh token and bumps the
  credential epoch). A token the store has never seen (garbage, an expired
  one, one killed by logout or a revoke-all) is simply refused: it proves
  nothing, and since the only other input is an access token whose signature
  (not freshness) is checked, letting it trigger the revocation would let
  anyone holding an old access token of X log X out everywhere.
  """
  @spec rotate_refresh_token(integer(), String.t()) ::
          {:ok, String.t(), String.t(), DateTime.t()} | {:error, :revoked}
  def rotate_refresh_token(user_id, old_raw) do
    case live_refresh_hash(user_id, old_raw) do
      {:ok, stored_hash} ->
        :ok = TokenStore.mark_rotated(user_id, refresh_token_hash(old_raw), rotated_expiry())
        :ok = TokenStore.delete(user_id, stored_hash)
        issue_refresh_token(user_id)

      :error ->
        if TokenStore.rotated?(user_id, refresh_token_hash(old_raw)) do
          # Security event: log the user id and nothing else — never token
          # material, not even the presented hash.
          Logger.warning("refresh replay detected for user #{user_id}: revoking every session for the account")

          :ok = revoke_all_sessions(user_id)
        end

        {:error, :revoked}
    end
  end

  defp rotated_expiry, do: DateTime.add(DateTime.utc_now(), refresh_token_ttl_ms(), :millisecond)

  @doc "Revoke every session for the user (password-reset completion, U14)."
  @spec revoke_all_sessions(integer()) :: :ok
  def revoke_all_sessions(user_id) do
    # Bumping the epoch is what makes the revocation reach a LIVE access token
    # and a live SSH session (R13a): the auth plug and the gateway authenticator
    # reject a token whose epoch is behind, and the session bridge refuses the
    # next renewal. Order matters only for the readable reason — a token checked
    # between these two steps is rejected by the epoch, not by the store.
    :ok = bump_credential_epoch!(user_id)
    :ok = TokenStore.delete_all_for_user(user_id)

    # The epoch stops the NEXT authentication; a gateway socket that already
    # identified never re-authenticates, so it would keep streaming to whoever
    # holds it (the attacker a password reset exists to evict). Close every live
    # socket 4004 and purge the stored records — resumable ones included — the
    # same teardown `DELETE /users/@me/sessions` performs.
    close_gateway_sessions(user_id)
  end

  # Close code 4004: the credential is dead and the client must not reconnect
  # with it (the machine-principal revocation code). Best-effort — a node
  # without the session store (a bare script context) has nothing to close.
  defp close_gateway_sessions(user_id) do
    :ok = Cytale.Gateway.SessionStore.close_user_sessions(user_id, 4004)
  rescue
    ArgumentError -> :ok
  end

  # ---------------------------------------------------------------------------
  # Credential epoch (R13a)
  # ---------------------------------------------------------------------------
  #
  # A monotonic value on the user row, carried as a token claim, and compared
  # in three places: the auth plug (every authenticated request), the gateway
  # authenticator (Identify), and the session bridge (every mint). It is what
  # ends a live session on a password reset or a revoke-all-sessions instead of
  # waiting out the session's own maximum.
  #
  # Cost: each comparison is ONE `users` row read — the auth plug performs no
  # user-row read today, so honouring this adds one per authenticated request
  # that carries an epoch claim. The claim-less case (below) reads nothing.

  @doc """
  The account's current credential epoch. A row written before the column
  existed reads as `0`, as does a missing row — every reader treats absence as
  the earliest epoch rather than as a reason to fail.
  """
  @spec credential_epoch(integer()) :: non_neg_integer()
  def credential_epoch(user_id) when is_integer(user_id) do
    case read_credential_epoch(user_id) do
      {:ok, epoch} -> epoch
      :error -> 0
    end
  end

  # The row read itself: `:error` only for a FAILED read (so the memo never
  # caches one); an absent row or column is epoch 0, as documented above.
  # Prepared (review #23): the auth plug's per-request read.
  defp read_credential_epoch(user_id) do
    case Cytale.Repo.query("SELECT credential_epoch FROM {{K}}.users WHERE user_id = ?", [{"bigint", user_id}]) do
      {:ok, page} ->
        case Enum.to_list(page) do
          [%{"credential_epoch" => epoch}] when is_integer(epoch) -> {:ok, epoch}
          _other -> {:ok, 0}
        end

      {:error, _reason} ->
        :error
    end
  end

  # The per-request form behind `epoch_current?/2` (review #19): memoized in
  # `Cytale.Accounts.EpochCache`, which `bump_credential_epoch!/1` writes
  # through — a revocation is seen by the very next request on this node. The
  # mints that must never trust a memo (the session bridge, the SSH
  # certificate issue) keep calling `credential_epoch/1`.
  defp cached_credential_epoch(user_id) do
    case Cytale.Accounts.EpochCache.fetch(user_id, fn -> read_credential_epoch(user_id) end) do
      {:ok, epoch} -> epoch
      :error -> 0
    end
  end

  @doc """
  Bump the account's credential epoch by one. Called by
  `revoke_all_sessions/1`, which both password-reset completion and the
  "sign out everywhere" route go through — one home for the revocation, so a
  new revocation path cannot forget to move the epoch.

  Read-modify-write, not a Scylla counter: a counter column cannot share a
  table with the account's ordinary columns. Two simultaneous bumps can lose an
  increment, which is harmless — the epoch is a "did anything change since?"
  marker, not an audit count.
  """
  @spec bump_credential_epoch!(integer()) :: :ok
  def bump_credential_epoch!(user_id) when is_integer(user_id) do
    next = credential_epoch(user_id) + 1

    Cytale.Repo.execute!(
      "UPDATE {{K}}.users SET credential_epoch = ? WHERE user_id = ?"
      |> String.replace("{{K}}", Cytale.Repo.keyspace()),
      [{"int", next}, {"bigint", user_id}]
    )

    # Write-through AFTER the row: the per-request check refuses a token
    # behind `next` from the very next request (see EpochCache).
    :ok = Cytale.Accounts.EpochCache.put(user_id, next)
  end

  @doc """
  Whether an access token carrying `epoch` is still current for `user_id`.

  **Rollout posture: fail-open only for accounts the epoch never reached.**
  A `nil` epoch means the token was minted before the claim existed. It is
  accepted ONLY while the account has NO stored epoch (zero — never bumped,
  the pre-migration state): such an account has no revocation the claim could
  be behind of, and rejecting would have logged every live session out for up
  to one access-token lifetime on the deploy that introduced the epoch. Once
  an epoch row EXISTS (the account was bumped by a password reset or a
  revoke-all), a claim-less token is REFUSED: pre-migration tokens die at
  their own ≤15-minute TTL, and after a bump a missing claim can never be
  revocation-proof — accepting it would let an attacker downgrade any
  revocation by dropping the claim they cannot forge anyway.

  A token that DOES carry an epoch is refused the moment the account's epoch
  moves past it, which is what makes a revocation take effect on a live
  session; the bridge's mint is fail-closed against the same move for the SSH
  path. There is deliberately no grace window: the token TTL already bounds
  the drift for pre-claim tokens, and a dated knob would be one more thing to
  get wrong.
  """
  @spec epoch_current?(integer(), integer() | nil) :: boolean()
  def epoch_current?(user_id, nil), do: cached_credential_epoch(user_id) == 0

  def epoch_current?(user_id, epoch) when is_integer(epoch),
    do: cached_credential_epoch(user_id) <= epoch

  def epoch_current?(_user_id, _epoch), do: true

  @doc """
  Refuse an ACCESS TOKEN whose subject is a machine principal. JWTs are the
  human credential: a machine authenticates with its `cytbot_` token, which
  carries its kind, parent and access document into the claims. A JWT minted
  for a machine id (the session bridge could, before it refused them) would
  otherwise resolve as `kind: :human` — the machine acting with a human's
  full reach instead of its parent ∩ grant.

  Fail-open on a read error, like the epoch check (an outage must not 401
  everyone); fail-closed where tokens are MINTED.
  """
  @spec check_human_subject(map()) :: :ok | {:error, :machine_subject}
  def check_human_subject(%{user_id: user_id}) when is_integer(user_id) do
    read = fn ->
      try do
        {:ok, Cytale.Accounts.Principals.get(user_id) != nil}
      rescue
        _ -> :error
      end
    end

    case Cytale.Accounts.EpochCache.machine?(user_id, read) do
      {:ok, true} -> {:error, :machine_subject}
      _ -> :ok
    end
  end

  def check_human_subject(_claims), do: :ok

  @doc """
  The plug/gateway-facing form of `epoch_current?/2`: `:ok` or
  `{:error, :stale_epoch}`.
  """
  @spec check_epoch(access_claims() | map()) :: :ok | {:error, :stale_epoch}
  def check_epoch(%{user_id: user_id} = claims) do
    if epoch_current?(user_id, Map.get(claims, :epoch)),
      do: :ok,
      else: {:error, :stale_epoch}
  end

  # ---------------------------------------------------------------------------
  # Single-use verification / reset tokens (signed + stored hash, purpose-scoped)
  # ---------------------------------------------------------------------------

  @verify_email_ttl_ms 60 * 60 * 1000
  @password_reset_ttl_ms 30 * 60 * 1000

  @doc """
  Issue a signed single-use token for `purpose` (`verify_email` |
  `password_reset`). Returns `{raw_token, token_hash}`; the hash lands in the
  `verification_tokens` table with its TTL.
  """
  @spec issue_single_use_token(integer(), String.t()) ::
          {:ok, String.t(), String.t()} | {:error, :purpose}
  def issue_single_use_token(user_id, purpose) do
    with {:ok, raw, hash, expires_at, ^purpose} <- sign_single_use_token(user_id, purpose) do
      store_verification_token(hash, user_id, purpose, expires_at)
      {:ok, raw, hash}
    else
      {:error, :purpose} -> {:error, :purpose}
      _ -> {:error, :purpose}
    end
  end

  @doc """
  Pure part of single-use issuance: sign the token, return
  `{raw, sha256_hex, expires_at, purpose}` — no storage. Storage happens in
  `issue_single_use_token/2`; this function exists so token crypto is
  testable without a database.
  """
  @spec sign_single_use_token(integer(), String.t()) ::
          {:ok, String.t(), String.t(), DateTime.t(), String.t()} | {:error, :purpose}
  def sign_single_use_token(user_id, purpose) when purpose in ["verify_email", "password_reset"] do
    ttl_ms = if purpose == "verify_email", do: @verify_email_ttl_ms, else: @password_reset_ttl_ms
    expires_at = DateTime.add(DateTime.utc_now(), ttl_ms, :millisecond)
    jti = Base.url_encode64(:crypto.strong_rand_bytes(24), padding: false)

    claims = %{
      "typ" => purpose,
      "sub" => Integer.to_string(user_id),
      "purpose" => purpose,
      "jti" => jti,
      "exp" => DateTime.to_unix(expires_at)
    }

    {:ok, raw, _claims} = Joken.encode_and_sign(claims, signer())
    {:ok, raw, sha256_hex(raw), expires_at, purpose}
  end

  def sign_single_use_token(_user_id, _purpose), do: {:error, :purpose}

  @doc """
  Pure decode of a single-use token for `purpose` — signature + purpose + exp
  only (no storage). The consumption half (row fetch + delete) lives in
  `verify_single_use_token/2`.
  """
  @spec decode_single_use_token(String.t(), String.t()) ::
          {:ok, %{user_id: integer(), purpose: String.t(), jti: String.t()}}
          | {:error, :invalid | :purpose_mismatch}
  def decode_single_use_token(raw, purpose) when is_binary(raw) do
    case Joken.verify_and_validate(claims_def(), raw, signer()) do
      {:ok, claims} ->
        if claims["purpose"] == purpose and Map.get(claims, "typ", purpose) == purpose do
          {:ok, %{user_id: String.to_integer(claims["sub"]), purpose: purpose, jti: claims["jti"]}}
        else
          {:error, :purpose_mismatch}
        end

      _any_error ->
        {:error, :invalid}
    end
  end

  def decode_single_use_token(_, _), do: {:error, :invalid}

  @doc """
  Consume a single-use token for `purpose`. Single-use: the stored row is
  deleted as part of a successful verify (a second use finds no row → 410
  Gone-class `{:error, :consumed}`). Purpose mismatch also fails.
  """
  @spec verify_single_use_token(String.t(), String.t()) ::
          {:ok, integer()} | {:error, :malformed | :invalid | :consumed | :purpose_mismatch}
  def verify_single_use_token(raw, purpose) when is_binary(raw) do
    case decode_single_use_token(raw, purpose) do
      {:ok, _claims} ->
        hash = sha256_hex(raw)

        case fetch_verification_token(hash) do
          {:ok, %{user_id: user_id, purpose: ^purpose}} ->
            :ok = delete_verification_token(hash)
            {:ok, user_id}

          {:ok, %{user_id: _}} ->
            {:error, :purpose_mismatch}

          :error ->
            {:error, :consumed}
        end

      {:error, reason} ->
        {:error, reason}
    end
  end

  def verify_single_use_token(_, _), do: {:error, :malformed}

  # -- verification_tokens table access (private; hash-keyed, never raw) ------

  defp store_verification_token(hash, user_id, purpose, expires_at) do
    ttl_seconds = max(1, DateTime.diff(expires_at, DateTime.utc_now(), :second))

    Cytale.Repo.execute!(
      "INSERT INTO {{K}}.verification_tokens (token_hash, user_id, purpose, expires_at) VALUES (?, ?, ?, ?) USING TTL ?"
      |> String.replace("{{K}}", Cytale.Repo.keyspace()),
      [{"text", hash}, {"bigint", user_id}, {"text", purpose}, {"timestamp", expires_at}, {"int", ttl_seconds}]
    )

    :ok
  end

  defp fetch_verification_token(hash) do
    case Cytale.Repo.execute(
           "SELECT token_hash, user_id, purpose FROM {{K}}.verification_tokens WHERE token_hash = ?"
           |> String.replace("{{K}}", Cytale.Repo.keyspace()),
           [{"text", hash}]
         ) do
      {:ok, page} ->
        case Enum.to_list(page) do
          [%{"user_id" => user_id, "purpose" => purpose}] ->
            {:ok, %{user_id: user_id, purpose: purpose}}

          _ ->
            :error
        end

      {:error, _} ->
        :error
    end
  end

  defp delete_verification_token(hash) do
    Cytale.Repo.execute!(
      "DELETE FROM {{K}}.verification_tokens WHERE token_hash = ?"
      |> String.replace("{{K}}", Cytale.Repo.keyspace()),
      [{"text", hash}]
    )

    :ok
  end

  # -- internals ----------------------------------------------------------------

  defp sha256_hex(bin), do: Base.encode16(:crypto.hash(:sha256, bin), case: :lower)

  # Claim validation on verify: exp is validated by Joken (relative to
  # current time); sub must be a decimal string.
  defp claims_def do
    %{
      "exp" => %Joken.Claim{
        validate: fn val, _, _ -> is_integer(val) and val > System.system_time(:second) end
      }
    }
  end

  defp signer, do: Joken.Signer.create("HS256", jwt_secret())

  defp jwt_secret, do: fetch_auth_secret(:jwt_secret, "AUTH_JWT_SECRET")
  defp pepper, do: fetch_auth_secret(:refresh_pepper, "AUTH_REFRESH_PEPPER")

  defp fetch_auth_secret(key, _env_name) do
    auth = Application.get_env(:cytale, :auth, [])

    case Keyword.get(auth, key) do
      nil ->
        raise "auth secret missing: :cytale/:auth/#{key} (set fail-fast in config/runtime.exs; dev/test may default in config/{dev,test}.exs)"

      value ->
        value
    end
  end

  defp access_token_ttl_ms, do: Cytale.Config.access_token_ttl_ms()

  defp refresh_token_ttl_ms, do: Cytale.Config.refresh_token_ttl_ms()
end
