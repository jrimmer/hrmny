defmodule Cytale.OIDC.IdToken do
  @moduledoc """
  Full server-side ID-token validation (ticket #12's security floor): the SPA
  never decodes anything the server trusts, and "validate" means ALL of —

    * SIGNATURE against the provider's live JWKS (real keys, real crypto via
      JOSE — the same JWT stack joken builds on). The `alg` header must be in
      the fixed allowlist (`RS256`/`ES256`/`PS256` — no `none`, no symmetric
      confusion, no `alg` taken on faith); the `kid` selects the key from the
      JWKS, with ONE forced JWKS refetch on a kid miss (provider key
      rotation);
    * `iss` equals the CONFIGURED issuer (which is also where discovery and
      the JWKS were fetched from — the URLs cannot be split between the two);
    * `aud` equals the configured client_id (list-form audiences additionally
      require `azp` per the OIDC Core rules);
    * `nonce` equals the ceremony transaction's nonce (binds the token to
      THIS browser round trip — the replay protection for the authorization
      code flow);
    * `exp` not passed (30s leeway for clock drift, nothing more).

  Every failure is an error tuple with a log-safe reason; the controller
  collapses them all into the uniform login refusal (never distinguishable to
  the caller from "no such account").
  """

  require Logger

  @allowed_algs ~w(RS256 ES256 PS256)

  # Beyond this drift a token's exp is treated as passed. Generous for NTP-
  # disciplined machines, tiny against a 10-minute transaction TTL.
  @leeway_s 30

  @typedoc "Everything validation is pinned to (the ceremony transaction's view)."
  @type ctx :: %{issuer: String.t(), client_id: String.t(), nonce: String.t()}

  @spec validate(String.t() | nil, ctx()) :: {:ok, map()} | {:error, atom()}
  def validate(token, ctx)

  def validate(token, ctx) when is_binary(token) do
    with {:ok, header} <- peek_header(token),
         :ok <- alg_allowed?(header),
         {:ok, jwk} <- resolve_key(ctx, header),
         {:ok, payload} <- verify(token, jwk, header),
         {:ok, claims} <- decode_payload(payload),
         :ok <- check_claims(claims, ctx) do
      {:ok, claims}
    else
      {:error, reason} = err ->
        Logger.warning("oidc id_token: refused (#{reason})")
        err
    end
  end

  def validate(_token, _ctx), do: {:error, :invalid_token}

  # -- Header (UNTRUSTED — used only to pick a verification strategy) -------------

  defp peek_header(token) do
    case String.split(token, ".", parts: 3) do
      [protected, _payload, _sig] ->
        with {:ok, raw} <- Base.url_decode64(protected, padding: false),
             {:ok, %{} = header} <- Jason.decode(raw) do
          {:ok, header}
        else
          _ -> {:error, :malformed_token}
        end

      _ ->
        {:error, :malformed_token}
    end
  end

  defp alg_allowed?(%{"alg" => alg}) when alg in @allowed_algs, do: :ok
  defp alg_allowed?(_), do: {:error, :alg_not_allowed}

  # -- Key selection (JWKS; one forced refetch on a kid miss = rotation) -----------

  defp resolve_key(ctx, header) do
    case key_from_cache(ctx, header, _force? = false) do
      {:ok, jwk} ->
        {:ok, jwk}

      {:error, :kid_not_found} ->
        case key_from_cache(ctx, header, _force? = true) do
          {:ok, jwk} -> {:ok, jwk}
          _ -> {:error, :kid_not_found}
        end

      {:error, reason} ->
        {:error, reason}
    end
  end

  defp key_from_cache(ctx, header, force?) do
    with {:ok, jwks} <- Cytale.OIDC.Discovery.jwks(ctx.issuer, force: force?),
         keys when is_list(keys) <- Map.get(jwks, "keys", []) do
      select_key(keys, header)
    else
      _ -> {:error, :jwks_unavailable}
    end
  end

  # kid selects the key; the alg header constrains the key TYPE so an RSA
  # signature can never be checked against an attacker-supplied EC key with a
  # colliding kid. No kid (rare but legal) demands a single unambiguous key.
  defp select_key(keys, %{"kid" => kid} = header) when is_binary(kid) do
    keys
    |> Enum.filter(&key_matches?(&1, header))
    |> Enum.find(&(&1["kid"] == kid))
    |> case do
      nil -> {:error, :kid_not_found}
      key -> {:ok, JOSE.JWK.from(key)}
    end
  end

  defp select_key(keys, header) do
    candidates = Enum.filter(keys, &key_matches?(&1, header))

    case candidates do
      [key] -> {:ok, JOSE.JWK.from(key)}
      _ -> {:error, :kid_not_found}
    end
  end

  defp key_matches?(%{"kty" => "RSA"}, %{"alg" => alg}) when alg in ~w(RS256 PS256), do: true
  defp key_matches?(%{"kty" => "EC", "crv" => "P-256"}, %{"alg" => "ES256"}), do: true
  defp key_matches?(_key, _header), do: false

  # -- Signature -------------------------------------------------------------------

  defp verify(token, jwk, %{"alg" => alg}) do
    case JOSE.JWS.verify_strict(jwk, [alg], token) do
      {true, payload, _jws} -> {:ok, payload}
      _ -> {:error, :bad_signature}
    end
  rescue
    _ -> {:error, :bad_signature}
  end

  # -- Claims ----------------------------------------------------------------------

  defp decode_payload(payload) when is_binary(payload) do
    case Jason.decode(payload) do
      {:ok, claims} when is_map(claims) -> {:ok, claims}
      _ -> {:error, :malformed_token}
    end
  end

  defp decode_payload(_), do: {:error, :malformed_token}

  defp check_claims(claims, ctx) do
    with :ok <- issuer_ok?(claims, ctx),
         :ok <- audience_ok?(claims, ctx),
         :ok <- nonce_ok?(claims, ctx),
         :ok <- exp_ok?(claims) do
      :ok
    end
  end

  defp issuer_ok?(%{"iss" => iss}, %{issuer: issuer}) when is_binary(iss),
    do: if(iss == issuer, do: :ok, else: {:error, :issuer_mismatch})

  defp issuer_ok?(_, _), do: {:error, :issuer_mismatch}

  # OIDC Core §3.1.3.7: aud is the client_id, or a list containing it — and a
  # multi-audience token must say azp == client_id (who the token was issued
  # FOR) or it could be spent against a different client.
  defp audience_ok?(%{"aud" => aud, "azp" => azp}, %{client_id: client_id}) when is_list(aud) do
    if client_id in aud and (length(aud) == 1 or azp == client_id) do
      :ok
    else
      {:error, :audience_mismatch}
    end
  end

  defp audience_ok?(%{"aud" => aud}, %{client_id: client_id}) when is_binary(aud) do
    if aud == client_id, do: :ok, else: {:error, :audience_mismatch}
  end

  defp audience_ok?(_, _), do: {:error, :audience_mismatch}

  defp nonce_ok?(%{"nonce" => nonce}, %{nonce: nonce}), do: :ok
  defp nonce_ok?(_, _), do: {:error, :nonce_mismatch}

  defp exp_ok?(%{"exp" => exp}) when is_integer(exp) do
    if exp > System.system_time(:second) - @leeway_s, do: :ok, else: {:error, :token_expired}
  end

  defp exp_ok?(_), do: {:error, :token_expired}
end
