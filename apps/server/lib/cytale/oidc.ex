defmodule Cytale.OIDC do
  @moduledoc """
  Instance-level OIDC federated sign-in (ticket #12) — ONE provider per
  deployment, surfaced as a third sign-in path beside password and passkey.

  The flow is the authorization-code grant WITH PKCE, server-mediated (this
  app issues bearer tokens, not browser sessions, so the provider's browser
  redirect lands on the SPA, which hands `code` + `state` straight back):

    1. `start_ceremony/2` — the server mints a single-use transaction (state,
       nonce, PKCE verifier, validated `return_to` — `Transactions`), reads
       the provider's authorize endpoint from discovery (`Discovery`, cached
       per issuer), and returns the fully-formed authorize URL (client_id,
       scopes, redirect_uri, S256 challenge, state, nonce).
    2. The browser goes to the provider and comes back to
       `<external origin>/auth/oidc/callback?code=…&state=…` (a PATH, not a
       fragment — OAuth forbids fragment redirect URIs; the SPA fallback
       serves it and the SPA normalizes it into its hash router).
    3. `finish_ceremony/2` — consume the transaction atomically (single-use),
       exchange the code at the token endpoint (client secret + verifier stay
       server-side), validate the ID token outright (`IdToken`: JWKS
       signature, iss, aud, nonce, exp), and resolve the identity:

    **Identity resolution policy (decided, ticket #12)** — link by
    provider-asserted VERIFIED email, auto-link on match. An `email` claim
    with `email_verified: true` is required for BOTH branches; an unverified
    or missing email is a refusal, never a lookup key (that is the
    account-takeover surface). A match logs into the EXISTING account ONLY
    when that account has itself verified the address (`email_verified_at`
    set). A local account whose email was never verified is NOT linked
    (`{:error, :link_required}`): anyone can register a local account under
    an address they do not own, and the provider's assertion proves only
    that the PROVIDER user owns it — auto-linking there would hand the
    squatted account (or the squatter's planted state) across. The owner
    signs in with their password, verifies the address, and the next SSO
    sign-in links. No match:
    create-on-first-login ONLY while `registration_open?` is true (a closed
    instance gains no accidental door), the new account born verified (an
    OIDC verified-email claim MUST clear `require_verified_email?` or the
    write gate would lock it out of posting), no password (password_hash is
    the empty string — the password path can never answer for it). Everything
    else — soft-deleted account, creation failure — refuses.

    4. The caller mints the EXISTING access/refresh pair (identical claims,
       TTLs, rotation machinery — `AuthController.login`'s response shape);
       downstream nothing learns the session began at a provider.

  The uniform-refusal rule is enforced at the controller: every
  `finish_ceremony/2` failure — unknown state, replayed state, provider
  down, bad signature, closed registration, no account — is the SAME 401
  envelope, so a failed login never distinguishes "no account" from "bad
  token". The distinct `{:error, reason}` tuples below exist for the LOG,
  not for the wire.

  Break-glass: password login and the operator surface are untouched and
  always available; nothing here can disable them (that decision is ticket
  #12's open "password-login switch", NOT built).
  """

  require Logger

  alias Cytale.Accounts.User
  alias Cytale.OIDC.{Discovery, IdToken, Transactions}
  alias CytaleWeb.ExternalUrl

  @callback_path "/auth/oidc/callback"

  # ---------------------------------------------------------------------------
  # Config
  # ---------------------------------------------------------------------------

  @doc """
  Whether the OIDC surface is USABLE: the operator's `oidc.enabled` flag AND
  a complete configuration (issuer + client_id + client secret). Fails
  closed on a half-configured provider — the honest-absence posture (no
  button, no route answer) beats a broken one.
  """
  @spec enabled?() :: boolean()
  def enabled? do
    Cytale.Config.oidc_enabled_flag?() and issuer_url() != nil and client_id() != nil and
      client_secret() != nil
  end

  @doc "The sign-in screen button text (`oidc.button_label`)."
  @spec button_label() :: String.t()
  def button_label, do: Cytale.Config.oidc_button_label()

  defp issuer_url, do: Cytale.Config.oidc_issuer_url()
  defp client_id, do: Cytale.Config.oidc_client_id()

  # The ONLY read of the secret: ceremony time, server-side, never logged,
  # never in any client payload. secrets.json first, CYTALE_OIDC_CLIENT_SECRET
  # env fallback — the #121 secret pattern.
  defp client_secret, do: Cytale.ServerConfig.secret("oidc_client_secret")

  @doc "The redirect URI registered at the provider: <external origin><path>."
  @spec callback_redirect_uri(Plug.Conn.t()) :: String.t()
  def callback_redirect_uri(conn), do: ExternalUrl.build(conn, @callback_path)

  @doc "The SPA callback path (the provider redirect's target path)."
  @spec callback_path() :: String.t()
  def callback_path, do: @callback_path

  # ---------------------------------------------------------------------------
  # 1. POST /auth/oidc/start — build the authorize URL
  # ---------------------------------------------------------------------------

  @doc """
  Mint the ceremony and return `{:ok, authorize_url}`. `return_to` (the SPA's
  signed-out continuation, #114's pending-route seam) is sanitized — anything
  that is not a same-app relative path is dropped (an absolute URL here would
  make the login flow an open redirect).
  """
  @spec start_ceremony(Plug.Conn.t(), term()) :: {:ok, String.t()} | {:error, :disabled | :provider_unavailable}
  def start_ceremony(conn, return_to) do
    if enabled?() do
      issuer = issuer_url()

      with {:ok, provider} <- Discovery.provider_config(issuer),
           %{"authorization_endpoint" => authorize_endpoint} when is_binary(authorize_endpoint) <-
             provider,
           tx = %Transactions{} <- Transactions.new(callback_redirect_uri(conn), sanitize_return_to(return_to)) do
        {:ok, build_authorize_url(authorize_endpoint, tx)}
      else
        _ -> {:error, :provider_unavailable}
      end
    else
      {:error, :disabled}
    end
  end

  defp build_authorize_url(endpoint, tx) do
    params = %{
      "response_type" => "code",
      "client_id" => client_id(),
      "scope" => Cytale.Config.oidc_scopes(),
      "redirect_uri" => tx.redirect_uri,
      "state" => tx.state,
      "nonce" => tx.nonce,
      # PKCE is REQUIRED (not recommended): S256 only — the plain method is
      # never offered, so a verifier leak through a proxy log is useless
      # without the SHA-256 preimage.
      "code_challenge" => Transactions.s256_challenge(tx.verifier),
      "code_challenge_method" => "S256"
    }

    query = URI.encode_query(params)
    separator = if String.contains?(endpoint, "?"), do: "&", else: "?"
    endpoint <> separator <> query
  end

  # A same-app RELATIVE path only: starts with exactly one "/", never "//"
  # (protocol-relative), no backslashes or control characters, bounded length.
  # Invalid → nil (the flow proceeds; the continuation just lands at "/") — a
  # tampered return_to is a client bug, not a refusal-worthy offense.
  @doc false
  @spec sanitize_return_to(term()) :: String.t() | nil
  def sanitize_return_to(return_to) when is_binary(return_to) do
    len = String.length(return_to)

    if String.starts_with?(return_to, "/") and not String.starts_with?(return_to, "//") and
         not String.contains?(return_to, "\\") and len <= 512 and
         String.valid?(return_to) and return_to == String.trim(return_to) and
         not String.contains?(return_to, "\n") do
      return_to
    else
      nil
    end
  end

  def sanitize_return_to(_), do: nil

  # ---------------------------------------------------------------------------
  # 2. POST /auth/oidc/callback — exchange, validate, resolve
  # ---------------------------------------------------------------------------

  @doc """
  Finish the ceremony: `{:ok, user, return_to}` — the controller mints the
  standard pair around this — or `{:error, reason}` where reason ∈
  `:invalid_transaction | :exchange_failed | :invalid_token | :refused |
  :link_required`. The reasons are for the LOG; the wire gets one uniform
  refusal — except `:link_required`, which the controller answers with its
  own actionable error (the caller already proved, via the provider, that
  they control the address, so naming the next step leaks nothing new).
  """
  @spec finish_ceremony(String.t(), String.t()) ::
          {:ok, User.t(), String.t() | nil}
          | {:error, :invalid_transaction | :exchange_failed | :invalid_token | :refused | :link_required}
  def finish_ceremony(code, state) when is_binary(code) and is_binary(state) do
    with {:ok, tx} <- Transactions.consume(state),
         {:ok, id_token} <- exchange_code(code, tx),
         {:ok, claims} <- validate_id_token(id_token, tx) do
      resolve_identity(claims, tx)
    else
      {:error, reason} = err when reason in [:invalid_transaction, :exchange_failed, :invalid_token] ->
        err

      _ ->
        {:error, :invalid_transaction}
    end
  end

  def finish_ceremony(_code, _state), do: {:error, :invalid_transaction}

  # -- The code exchange (client secret + PKCE verifier never leave the server) --

  defp exchange_code(code, tx) do
    with {:ok, provider} <- Discovery.provider_config(issuer_url()),
         %{"token_endpoint" => token_endpoint} when is_binary(token_endpoint) <- provider,
         {:ok, %{"id_token" => id_token}} when is_binary(id_token) <- token_request(token_endpoint, code, tx) do
      {:ok, id_token}
    else
      {:error, reason} = err ->
        Logger.warning("oidc token exchange: failed (#{inspect(reason)})")
        err

      other ->
        Logger.warning("oidc token exchange: unexpected response shape (#{inspect(other)})")
        {:error, :exchange_failed}
    end
  end

  defp token_request(token_endpoint, code, tx) do
    body =
      URI.encode_query(%{
        "grant_type" => "authorization_code",
        "code" => code,
        "redirect_uri" => tx.redirect_uri,
        "client_id" => client_id(),
        "client_secret" => client_secret(),
        "code_verifier" => tx.verifier
      })

    request = Finch.build(:post, token_endpoint, [{"content-type", "application/x-www-form-urlencoded"}], body)

    case Finch.request(request, Cytale.OIDC.Finch, receive_timeout: 10_000) do
      {:ok, %Finch.Response{status: 200, body: resp_body}} ->
        Jason.decode(resp_body)

      {:ok, %Finch.Response{status: status}} ->
        {:error, {:http_status, status}}

      {:error, reason} ->
        {:error, reason}
    end
  end

  defp validate_id_token(id_token, tx) do
    case IdToken.validate(id_token, %{issuer: issuer_url(), client_id: client_id(), nonce: tx.nonce}) do
      {:ok, claims} -> {:ok, claims}
      {:error, _reason} -> {:error, :invalid_token}
    end
  end

  # ---------------------------------------------------------------------------
  # Identity resolution (see the moduledoc for the policy and why)
  # ---------------------------------------------------------------------------

  defp resolve_identity(claims, tx) do
    email = claims["email"]
    provider_verified? = claims["email_verified"] == true

    if is_binary(email) and email != "" and provider_verified? do
      case User.get_by_identifier(email) do
        # A live account with this email whose OWNER verified it locally:
        # both sides proved control of the address — log in as it.
        %{deleted_at: nil, email_verified_at: verified_at} = user when not is_nil(verified_at) ->
          {:ok, user}

        # A live account whose email was never verified locally: whoever
        # registered it never proved they own the address, so the provider's
        # assertion cannot be matched against it (account takeover / planted
        # account). Refuse with the distinct, actionable reason — the owner
        # signs in with their password and verifies, then SSO links.
        %{deleted_at: nil} ->
          {:error, :link_required}

        # Tombstoned: the handle is not reusable and the account is gone —
        # refuse (never resurrect, never leak).
        %{deleted_at: _} ->
          {:error, :refused}

        nil ->
          if Cytale.Config.registration_open?() do
            create_account(claims, email)
          else
            # No accidental door on a closed instance; same uniform refusal
            # as every other failure.
            {:error, :refused}
          end
      end
    else
      # No email / unverified email: nothing here is safe to match on. Refuse.
      {:error, :refused}
    end
    |> tap_result(tx)
  end

  # The transaction is spent either way; the tap only keeps the successful
  # return_to riding along with the result.
  defp tap_result(result, tx)
  defp tap_result({:ok, user}, tx), do: {:ok, user, tx.return_to}
  defp tap_result({:error, _} = err, _tx), do: err

  defp create_account(claims, email) do
    case User.create_federated(derive_username(claims, email), email) do
      {:ok, user} ->
        {:ok, user}

      {:error, reason} ->
        Logger.warning("oidc provisioning: account creation failed (#{inspect(reason)})")
        {:error, :refused}
    end
  end

  # Derive a usable username: the provider's preferred_username first, then
  # the email local-part, sanitized into the username grammar ([a-zA-Z0-9_.-],
  # 2..32, no @) and de-collided with a random suffix. A provider that asserts
  # nothing usable still gets a valid account, never a refusal — identity is
  # the verified email, the handle is cosmetic.
  @doc false
  @spec derive_username(map(), String.t()) :: String.t()
  def derive_username(claims, email) do
    preferred = claims["preferred_username"]
    local_part = email |> String.split("@") |> hd()

    base =
      sanitize_username(preferred) || sanitize_username(local_part) || "user"

    if User.username_taken?(base) do
      Enum.find_value(1..5, fn _ -> unique_username(base) end) ||
        "user-" <> Base.url_encode64(:crypto.strong_rand_bytes(9), padding: false)
    else
      base
    end
  end

  defp unique_username(base) do
    candidate =
      String.slice(base, 0, 25) <> "-" <> Base.url_encode64(:crypto.strong_rand_bytes(6), padding: false)

    if User.username_taken?(candidate), do: nil, else: candidate
  end

  defp sanitize_username(name) when is_binary(name) do
    cleaned =
      name
      |> String.replace(~r/[^a-zA-Z0-9_.-]/, "")
      |> String.slice(0, 32)

    if String.length(cleaned) >= 2, do: cleaned, else: nil
  end

  defp sanitize_username(_), do: nil
end
