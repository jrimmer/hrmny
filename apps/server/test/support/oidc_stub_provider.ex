defmodule Cytale.OIDC.StubProvider do
  @moduledoc """
  A STUB OIDC provider for the ticket #12 suite — a REAL Bandit+Plug HTTP
  server speaking the endpoints the production flow consumes:

    * `GET /.well-known/openid-configuration` — real discovery;
    * `GET /jwks.json` — the REAL public half of a real ES256 key (JOSE), so
      discovery, JWKS fetch and signature validation are exercised over the
      wire, never mocked;
    * `GET /authorize` — validates what the server's authorize URL asserts
      (client_id, `response_type=code`, `code_challenge_method=S256`, state,
      nonce, redirect_uri) and issues a single-use code bound to
      {challenge, nonce, claims-override}, answering with a REAL provider
      redirect (`302` + `Location: {redirect_uri}?code=…&state=…` — the
      shape a browser follows);
    * `POST /token` — validates client credentials, the single-use code, the
      redirect_uri, AND PKCE for real (`sha256(code_verifier) == challenge`),
      then answers with a REAL signed JWT (ES256, `kid` in the JWKS).

  Per-test behaviour lives in an ETS config the suite writes: `claims`
  (merged over the default ID-token claims — that is how the expired /
  wrong-audience / nonce-mismatch / unverified-email refusals are produced
  with REAL tokens) and `sign_with: :rogue` (signs with a key NOT in the
  JWKS — the bad-signature refusal through the full rotation-refetch path).
  `rotate_key!/0` swaps the JWKS key, driving the validator's kid-miss →
  forced-refetch recovery for real.

  The suite drives the provider leg with `redeem_authorize_url/1` (GET the
  authorize URL, follow the 302's Location) exactly as a browser would.
  """

  use GenServer

  @table Cytale.OIDC.StubProvider.Config
  @kid "stub-signing-key-1"
  @rogue_kid "rogue-key-not-in-jwks"

  # -- Client API ----------------------------------------------------------------

  def start_link(opts) do
    GenServer.start_link(__MODULE__, opts, name: __MODULE__)
  end

  @doc "Replace the whole per-test config (credentials + claims override)."
  @spec reset(keyword()) :: :ok
  def reset(opts) do
    :ets.insert(
      table(),
      {:config,
       %{
         client_id: Keyword.fetch!(opts, :client_id),
         client_secret: Keyword.fetch!(opts, :client_secret),
         claims: Keyword.get(opts, :claims, %{}),
         sign_with: Keyword.get(opts, :sign_with, :registered)
       }}
    )

    :ok
  end

  @doc "Set the claims override carried into the NEXT issued code's ID token."
  @spec put_claims(map()) :: :ok
  def put_claims(overrides) when is_map(overrides) do
    :ets.update_element(table(), :config, {2, %{config() | claims: overrides}})
    :ok
  end

  @doc "Sign the next token with a key that is NOT in the JWKS (bad signature)."
  @spec sign_with_rogue_key() :: :ok
  def sign_with_rogue_key,
    do: :ets.update_element(table(), :config, {2, %{config() | sign_with: :rogue}})

  @doc """
  Provider key rotation: the JWKS's key is replaced (new key, new `kid`).
  Tokens minted BEFORE this stop verifying once the cache refetches; the
  validator's kid-miss → forced-refetch path is what recovers.
  """
  @spec rotate_key!() :: :ok
  def rotate_key! do
    :ets.insert(table(), {:signing_key, JOSE.JWK.generate_key({:ec, "P-256"})})
    :ok
  end

  @doc """
  Drive the provider leg of a ceremony the way a browser does: GET the
  authorize URL, follow the 302's Location, return `{"code" => …, "state" => …}`.
  Raises on anything unexpected — the happy path's redirect assertions live here.
  """
  @spec redeem_authorize_url(String.t()) :: %{required(String.t()) => String.t()}
  def redeem_authorize_url(authorize_url) do
    case Finch.request(Finch.build(:get, authorize_url), CytaleTest.Finch, receive_timeout: 10_000) do
      {:ok, %Finch.Response{status: 302, headers: headers}} ->
        {"location", location} =
          Enum.find(headers, fn {k, _v} -> String.downcase(k) == "location" end)

        params =
          location
          |> URI.parse()
          |> Map.get(:query)
          |> URI.decode_query()

        Enum.each(["code", "state"], fn key ->
          Map.has_key?(params, key) or raise "stub redirect missing #{key}: #{location}"
        end)

        params

      {:ok, %Finch.Response{status: status, body: body}} ->
        raise "stub /authorize answered #{status}: #{body}"

      {:error, reason} ->
        raise "stub /authorize unreachable: #{inspect(reason)}"
    end
  end

  # -- ETS readers (the Plug calls these; the suite drives reset/put_claims) ------

  @doc false
  def config do
    case :ets.lookup(table(), :config) do
      [{:config, config}] -> config
      [] -> raise "StubProvider not configured — call reset/1 in setup"
    end
  end

  @doc false
  def base_url do
    [{:base_url, base_url}] = :ets.lookup(table(), :base_url)
    base_url
  end

  @doc false
  def jwks_document do
    %{"keys" => [public_key_map(@kid, signing_key())]}
  end

  @doc false
  def mint_id_token(record) do
    cfg = config()
    {kid, key} = signing_pair(cfg.sign_with)
    now = System.system_time(:second)

    claims =
      Map.merge(
        %{
          "iss" => base_url(),
          "sub" => "stub-user-42",
          "aud" => cfg.client_id,
          "exp" => now + 300,
          "iat" => now,
          "nonce" => record.nonce
        },
        record.claims || %{}
      )

    {_, compact} =
      JOSE.JWS.sign(key, Jason.encode!(claims), %{"alg" => "ES256", "kid" => kid, "typ" => "JWT"})
      |> JOSE.JWS.compact()

    compact
  end

  @doc false
  def take_code(code) when is_binary(code) do
    case :ets.take(table(), {:code, code}) do
      [{{:code, ^code}, record}] -> {:code, record}
      [] -> :miss
    end
  end

  def take_code(_), do: :miss

  @doc false
  def issue_code(%{} = record) do
    code = Base.url_encode64(:crypto.strong_rand_bytes(24), padding: false)
    true = :ets.insert(table(), {{:code, code}, record})
    code
  end

  # -- Internals -------------------------------------------------------------------

  defp signing_key do
    [{:signing_key, key}] = :ets.lookup(table(), :signing_key)
    key
  end

  defp signing_pair(:rogue) do
    case :ets.lookup(table(), :rogue_key) do
      [{:rogue_key, key}] ->
        {@rogue_kid, key}

      [] ->
        key = JOSE.JWK.generate_key({:ec, "P-256"})
        :ets.insert(table(), {:rogue_key, key})
        {@rogue_kid, key}
    end
  end

  defp signing_pair(_), do: {@kid, signing_key()}

  defp public_key_map(kid, key) do
    # JOSE.JWK.to_map/1 returns {kty-module-map, fields-map}; the FIELDS map
    # is the JWK Set entry a real provider serves.
    key
    |> JOSE.JWK.to_public()
    |> JOSE.JWK.to_map()
    |> elem(1)
    |> Map.put("kid", kid)
    |> Map.put("alg", "ES256")
    |> Map.put("use", "sig")
  end

  defp table, do: @table

  # -- GenServer (owns the ETS config + the Bandit listener) ------------------------

  @impl true
  def init(opts) do
    base_url = Keyword.fetch!(opts, :base_url)

    :ets.new(table(), [:set, :public, :named_table, read_concurrency: true])
    :ets.insert(table(), {:base_url, base_url})
    :ets.insert(table(), {:signing_key, JOSE.JWK.generate_key({:ec, "P-256"})})

    {:ok, _} =
      Bandit.start_link(
        plug: Cytale.OIDC.StubProvider.Plug,
        scheme: :http,
        port: Keyword.fetch!(opts, :port),
        thousand_island_options: [read_timeout: 15_000]
      )

    {:ok, %{base_url: base_url}}
  end
end

defmodule Cytale.OIDC.StubProvider.Plug do
  @moduledoc """
  The wire half of the stub — thin over the parent module's ETS readers.
  Deliberately a SIBLING module (not nested inside StubProvider) so
  `Plug.Conn` / `Plug.Router` resolve to the real Plug library instead of
  this module's own namespace.
  """

  import Plug.Conn
  use Plug.Router

  alias Cytale.OIDC.StubProvider, as: Stub

  @token_ttl_s 300

  def init(opts), do: opts

  plug(:match)
  plug(Plug.Parsers, parsers: [:urlencoded], pass: ["*/*"])
  plug(:dispatch)

  get "/.well-known/openid-configuration" do
    issuer = Stub.base_url()

    json_resp(conn, %{
      "issuer" => issuer,
      "authorization_endpoint" => issuer <> "/authorize",
      "token_endpoint" => issuer <> "/token",
      "jwks_uri" => issuer <> "/jwks.json",
      "response_types_supported" => ["code"],
      "subject_types_supported" => ["public"],
      "id_token_signing_alg_values_supported" => ["ES256"],
      "scopes_supported" => ["openid", "email", "profile"]
    })
  end

  get "/jwks.json" do
    json_resp(conn, Stub.jwks_document())
  end

  get "/authorize" do
    conn = fetch_query_params(conn)
    cfg = Stub.config()
    q = conn.query_params

    cond do
      q["client_id"] != cfg.client_id ->
        bad(conn, 400, "unknown client_id")

      q["response_type"] != "code" ->
        bad(conn, 400, "response_type must be code")

      # PKCE S256 REQUIRED — the stub refuses anything else, so the happy
      # path itself proves the server sent a real S256 challenge.
      q["code_challenge_method"] != "S256" or blank?(q["code_challenge"]) ->
        bad(conn, 400, "PKCE S256 required")

      blank?(q["state"]) or blank?(q["nonce"]) or blank?(q["redirect_uri"]) or
          blank?(q["scope"]) ->
        bad(conn, 400, "state, nonce, redirect_uri and scope are required")

      true ->
        code =
          Stub.issue_code(%{
            challenge: q["code_challenge"],
            nonce: q["nonce"],
            redirect_uri: q["redirect_uri"],
            claims: Map.new(cfg.claims || %{})
          })

        location =
          q["redirect_uri"] <>
            "?code=" <> URI.encode_www_form(code) <> "&state=" <> URI.encode_www_form(q["state"])

        conn
        |> put_resp_header("location", location)
        |> send_resp(302, "")
    end
  end

  post "/token" do
    cfg = Stub.config()
    p = conn.body_params

    with {:code, record} <- Stub.take_code(p["code"]),
         true <- p["grant_type"] == "authorization_code",
         true <- p["client_id"] == cfg.client_id,
         true <- Plug.Crypto.secure_compare(p["client_secret"] || "", cfg.client_secret),
         true <- p["redirect_uri"] == record.redirect_uri,
         true <- pkce_ok?(p["code_verifier"], record.challenge) do
      json_resp(conn, %{
        "access_token" => Base.url_encode64(:crypto.strong_rand_bytes(24), padding: false),
        "token_type" => "Bearer",
        "expires_in" => @token_ttl_s,
        "id_token" => Stub.mint_id_token(record)
      })
    else
      _ ->
        bad(conn, 400, "invalid grant (code, credentials, redirect_uri or PKCE rejected)")
    end
  end

  match _ do
    bad(conn, 404, "not found")
  end

  # -- helpers --

  defp pkce_ok?(verifier, challenge) when is_binary(verifier) and is_binary(challenge) do
    Base.url_encode64(:crypto.hash(:sha256, verifier), padding: false) == challenge
  end

  defp pkce_ok?(_, _), do: false

  defp blank?(v), do: is_nil(v) or v == ""

  defp json_resp(conn, body) do
    conn
    |> put_resp_content_type("application/json")
    |> send_resp(200, Jason.encode!(body))
  end

  defp bad(conn, status, message) do
    conn
    |> put_resp_content_type("application/json")
    |> send_resp(status, Jason.encode!(%{"error" => message}))
  end
end
