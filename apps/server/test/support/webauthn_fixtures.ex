defmodule Cytale.WebAuthnFixtures do
  @moduledoc """
  A minimal SOFTWARE authenticator for the #36 ceremony tests — the
  acceptance core: a register→login round trip with real WebAuthn bytes.

  Everything here is exactly what a browser platform authenticator emits
  under the attestation `"none"` policy:

    * real ES256 (P-256) key pairs (`:public_key.generate_key/1`);
    * real CBOR attestation objects (`fmt: "none"` — the same `cbor` hex
      package wax itself uses, as a test-only dependency);
    * real ECDSA-SHA256 assertion signatures over
      `authenticatorData <> SHA-256(clientDataJSON)` (the WebAuthn spec's
      assertionSignature input), made with `:crypto.sign/4`.

  The RP ID / origin strings MUST match `config :cytale, :webauthn` in
  config/test.exs — wax string-matches the client-data origin against the
  configured allowlist and the RP-ID hash against the derived RP ID, which
  is precisely what the wrong-origin / wrong-RP-ID refusal tests flip.
  """

  # Mirrors config/test.exs `:webauthn` (rp_id "localhost", origins [...4001]).
  @origin "http://localhost:4001"
  @rp_id "localhost"

  defstruct [:key, :credential_id_raw, :sign_count, :rp_id]

  @type t :: %__MODULE__{}

  # -- Authenticator lifecycle -----------------------------------------------------

  @doc "A fresh authenticator holding a new ES256 key and credential id."
  @spec new(String.t()) :: t()
  def new(rp_id \\ @rp_id) do
    %__MODULE__{
      key: :public_key.generate_key({:namedCurve, :secp256r1}),
      credential_id_raw: :crypto.strong_rand_bytes(32),
      sign_count: 0,
      rp_id: rp_id
    }
  end

  # -- Registration ceremony -------------------------------------------------------

  @doc """
  Produce the `navigator.credentials.create()` artifacts for `options` (the
  server's `public_key` map). Returns
  `{attestation_object_b64, client_data_json_b64}`.
  """
  @spec register_response(t(), map()) :: {String.t(), String.t()}
  def register_response(%__MODULE__{} = auth, %{"challenge" => challenge_b64} = options) do
    challenge = decode_b64url!(challenge_b64)
    # The rp id the challenge REQUESTS (the server's options) governs what a
    # real authenticator hashes into authData.
    rp_id = Map.get(options, "rp", %{}) |> Map.get("id", auth.rp_id)

    # flags 0x45 = UP | UV | AT (attested credential data present)
    auth_data =
      rp_id_hash(rp_id) <> <<0x45, 0::unsigned-big-integer-size(32)>> <> attested_credential_data(auth)

    attestation_object =
      CBOR.encode(%{"fmt" => "none", "attStmt" => %{}, "authData" => auth_data})

    client_data = client_data_json("webauthn.create", challenge)
    {encode_b64url(attestation_object), encode_b64url(client_data)}
  end

  # -- Authentication ceremony -----------------------------------------------------

  @doc """
  Produce the `navigator.credentials.get()` artifacts for `options` (the
  server's `public_key` map). Returns
  `{authenticator_data_b64, signature_b64, client_data_json_b64}`.

  `:counter` overrides the counter the authenticator reports (the clone-detection
  tests present a NON-monotonic one); `:origin` and `:rp_id` override what the
  ceremony is performed against (the wrong-origin / wrong-RP-ID refusals).
  """
  @spec assertion(t(), map(), keyword()) :: {String.t(), String.t(), String.t()}
  def assertion(%__MODULE__{} = auth, %{"challenge" => challenge_b64}, opts \\ []) do
    challenge = decode_b64url!(challenge_b64)
    origin = Keyword.get(opts, :origin, @origin)
    rp_id = Keyword.get(opts, :rp_id, auth.rp_id)
    counter = Keyword.get_lazy(opts, :counter, fn -> auth.sign_count + 1 end)

    auth_data = rp_id_hash(rp_id) <> <<0x05>> <> <<counter::unsigned-big-integer-size(32)>>

    client_data = client_data_json("webauthn.get", challenge, origin)

    message = auth_data <> :crypto.hash(:sha256, client_data)
    # :public_key.sign/3 (not :crypto.sign/4): it accepts the plain
    # :ECPrivateKey record generate_key/1 returns and hashes `message` itself.
    signature = :public_key.sign(message, :sha256, auth.key)

    {encode_b64url(auth_data), encode_b64url(signature), encode_b64url(client_data)}
  end

  @doc "Advance the authenticator's internal counter (mimics real use)."
  @spec bump(t(), non_neg_integer()) :: t()
  def bump(%__MODULE__{} = auth, by \\ 1), do: %{auth | sign_count: auth.sign_count + by}

  @doc "base64url (unpadded) of raw bytes — how credential ids ride the wire."
  def encode_b64url(bin) when is_binary(bin), do: Base.url_encode64(bin, padding: false)

  # -- Internals ---------------------------------------------------------------------

  # flags: UP (0x01) | UV (0x04) | BE (0x08) | BS (0x10) | AT (0x40)
  defp attested_credential_data(%__MODULE__{} = auth) do
    <<
      0::unsigned-big-integer-size(128),
      byte_size(auth.credential_id_raw)::unsigned-big-integer-size(16),
      auth.credential_id_raw::binary,
      cose_key(auth.key)::binary
    >>
  end

  # COSE_Key EC2 for ES256: kty(1)=2 EC2, alg(3)=-7 ES256, crv(-1)=1 P-256,
  # x(-2) and y(-3) = the uncompressed point's coordinates.
  defp cose_key(key) do
    <<0x04, x::binary-size(32), y::binary-size(32)>> = public_point(key)

    CBOR.encode(%{1 => 2, 3 => -7, -1 => 1, -2 => x, -3 => y})
  end

  defp public_point(key), do: elem(key, 4)

  defp rp_id_hash(rp_id), do: :crypto.hash(:sha256, rp_id)

  defp client_data_json(type, challenge, origin \\ @origin) do
    Jason.encode!(%{
      "type" => type,
      "challenge" => encode_b64url(challenge),
      "origin" => origin,
      "crossOrigin" => false
    })
  end

  defp decode_b64url!(b64), do: Base.url_decode64!(b64, padding: false)
end
