defmodule Cytale.Permalinks do
  @moduledoc """
  Opaque message permalinks (#118, option B): ONE token that decodes back to
  a `(channel_id, message_id)` pair, with NO row behind it.

  ## Why not the readable route grammar

  #114 shipped correct permalinks and #118 first shortened them (base62 inside
  the existing grammar), but a copied link still spelled out the app's internal
  layout:

      …/#/workspace/91267263520309248/channel/91267303441694720/message/92770849337114624

  Three segments, three decodable ids, 100+ characters — the ids are also
  snowflakes, so the link disclosed *when* the channel and the message were
  created. This module is the replacement copied form:

      https://<origin>/m/3kQm9Xb2Qp7ZtR4vN8wY1cKdQ3

  One segment, no keywords, no structure: everything a reader can learn from
  the link is that it is a link.

  ## What the token is

  Two 64-bit ids, encrypted with a server key, plus a truncated tag:

      bytes 0..15   AES-256-ECB(channel_id :: u64, message_id :: u64)
      bytes 16..21  the first 6 bytes of HMAC-SHA256 over those 16 bytes
      base62        the whole 22-byte blob, in the SHARED alphabet

  The ids are NOT stored anywhere: `mint/2` is a pure function of the ids and
  the key, so the same message always mints the same token (two people sharing
  one message share one link) and there is nothing to garbage-collect, expire,
  or fail to replicate.

    * **AES-256-ECB over a single 16-byte block** is the permutation. A block
      cipher is a keyed bijection, so every token is decodable by the server and
      none is guessable by anyone else; one block is exactly the payload, so
      there is no block structure to preserve. ECB's well-known weakness (equal
      blocks leak equality) needs two blocks to exist — and the deliberate
      property here is the opposite one: an identical plaintext SHOULD mint an
      identical token.
    * **The truncated tag is what makes a tampered token fail closed.** Without
      it every one of the 2^176 byte strings would "decode" to *some* id pair,
      and a flipped character would silently resolve to a different message.
      6 bytes (48 bits) is the balance: a forgery needs ~2^48 successful
      authenticated guesses (the resolve route is the only oracle, and it is
      rate-limited per principal AND per client IP), while costing one character
      of link length. The comparison is `:crypto.hash_equals/2`, not `==` —
      a byte-at-a-time compare is a timing oracle for the tag.
    * **base62 in `packages/domain`'s alphabet, letters first** — the SAME
      alphabet the client parses ids with (`B62_ALPHABET` in
      `packages/domain/src/permalink.ts`). A second alphabet would be a second
      thing to get wrong; `Cytale.PermalinksTest` reads that file and asserts
      the two literals match.

  The result is 29–30 characters for a typical pair (22 bytes; 62^29 is just
  below 2^176, so the leading digit is usually present).

  ## Where the key comes from

  `CYTALE_PERMALINK_KEY` (the `:permalink_key` app env, or the environment
  variable of that name) when set; otherwise a key DERIVED, per install, from
  the instance's existing `secret_key_base`:

      sha256("cytale/permalink-key/v1" <> secret_key_base)

  The derivation is deliberate: a new REQUIRED env var turns a missing
  configuration into a boot failure on the deploy host, which is a far worse
  outcome than a derived key — and the derived key is per-install, stable, and
  unguessable (`secret_key_base` is the instance's own secret and is never
  optional: Phoenix will not boot without it). `log_key_source/0` says at boot
  which of the two is in use, because "which key is this instance using" is not
  a question an operator should have to read the code to answer.

  ## Rotation is a deliberate act

  **Rotating the key — setting `CYTALE_PERMALINK_KEY` on an instance that had
  been deriving one, changing it, or rotating `secret_key_base` — invalidates
  every permalink minted before the rotation.** There is no table to migrate and
  no old-key fallback: a link that was copied into somebody's notes stops
  resolving, which is exactly the failure a permalink may not have. Treat it as
  a break-glass operation, not a hygiene task.

  ## What is deliberately NOT here

  No token table, no expiry, no revocation, no click counting. Those are the
  things a stored shortlink buys, and they are **ticket #119** (`later`) — which
  exists precisely for what this design cannot do. Do not add a table or a TTL
  here by accident: a lifecycle turns minting into a write, makes the same
  message mint a different link on every click, and needs its own garbage
  collection. See #119 for the trade.
  """

  require Logger

  import Bitwise, only: [bsl: 2]

  # The SHARED base62 alphabet, byte-for-byte what `packages/domain/src/permalink.ts`
  # declares as `B62_ALPHABET` (the server parses that file's literal back in the
  # suite, so the two cannot drift). Letters first is load-bearing for the CLIENT
  # (it is what makes "all digits ⇒ legacy snowflake" a total rule); here it only
  # has to be the same.
  @alphabet "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"

  # Compile-time lookup for the decoder (an `Enum.at/2` per character would be a
  # linear scan per byte of every resolved token).
  @alphabet_index @alphabet |> String.to_charlist() |> Enum.with_index() |> Map.new()

  # `channel_id` and `message_id` are each a u64 — one AES block exactly.
  @id_bits 64
  @payload_bytes div(2 * @id_bits, 8)

  # See the moduledoc: 48 bits of authentication, at the cost of one character.
  @tag_bytes 6
  @token_bytes @payload_bytes + @tag_bytes

  # Domain separation: a key derived for permalinks must never be the raw secret
  # it came from, and the enciphering and tag keys must not be the same key (a
  # single AES key used as its own HMAC key is a known collision of roles).
  @context "cytale/permalink-key/v1"

  @typedoc "The ids a token carries, as the schema stores them (u64)."
  @type pair :: {non_neg_integer(), non_neg_integer()}

  @doc """
  Mint the token for a `(channel_id, message_id)` pair with the configured key.

  `{:error, :bad_id}` for anything that is not a u64 id — the caller renders
  that as the same 404 every other miss gets, never as a 500.
  """
  @spec mint(term(), term()) :: {:ok, String.t()} | {:error, :bad_id}
  def mint(channel_id, message_id) do
    if id?(channel_id) and id?(message_id) do
      {:ok, encode(channel_id, message_id)}
    else
      {:error, :bad_id}
    end
  end

  @doc """
  Read a token back with the configured key.

  `:error` for every failure that is not a pair of ours — a malformed token, a
  wrong length, a tag that does not match, and (for the caller to add) a channel
  the caller cannot see. All of them are ONE answer on purpose: the resolve
  route must not be an oracle that distinguishes "not a link" from "a link to
  something you may not have".
  """
  @spec resolve(term()) :: {:ok, pair()} | :error
  def resolve(token), do: decode(token)

  @doc """
  The keyed encode, with the key supplied (`nil` = the configured one).

  Pure and deterministic: same ids + same key ⇒ same token, every time, on every
  node. Exported for the tests, which need to tamper with a KNOWN key and to
  prove that a different key decodes nothing.
  """
  @spec encode(integer(), integer(), binary() | nil) :: String.t()
  def encode(channel_id, message_id, key \\ nil) do
    if id?(channel_id) and id?(message_id) do
      plaintext = <<channel_id::unsigned-big-size(@id_bits), message_id::unsigned-big-size(@id_bits)>>
      ciphertext = crypt(key_of(key), plaintext, true)
      base62_encode(ciphertext <> tag(key_of(key), ciphertext))
    else
      raise ArgumentError, "permalink ids must be u64 integers, got: #{inspect({channel_id, message_id})}"
    end
  end

  @doc "The keyed decode, with the key supplied (`nil` = the configured one)."
  @spec decode(term(), binary() | nil) :: {:ok, pair()} | :error
  def decode(token, key \\ nil)

  def decode(token, key) when is_binary(token) and byte_size(token) > 0 do
    with {:ok, bytes} <- base62_decode(token, @token_bytes),
         <<ciphertext::binary-size(@payload_bytes), presented::binary-size(@tag_bytes)>> <- bytes,
         true <- :crypto.hash_equals(presented, tag(key_of(key), ciphertext)),
         <<channel_id::unsigned-big-size(@id_bits), message_id::unsigned-big-size(@id_bits)>> <-
           crypt(key_of(key), ciphertext, false) do
      {:ok, {channel_id, message_id}}
    else
      _ -> :error
    end
  end

  def decode(_token, _key), do: :error

  @doc """
  Which key this instance mints with: `:environment` when
  `CYTALE_PERMALINK_KEY` is set, `:derived` otherwise.

  Public because it is an operational fact, not an internal one: it is what the
  boot line reports, and what tells an operator whether a rotation is about to
  invalidate links (`docs`: see the moduledoc).
  """
  @spec key_source :: :environment | :derived
  def key_source, do: if(configured_key(), do: :environment, else: :derived)

  @doc """
  Say at boot which key this instance mints with.

  Called from `Cytale.Application` — the derived case is the one an operator
  needs to know about (it means the key moves with `secret_key_base`), so it
  names the escape hatch and the cost of using it.
  """
  @spec log_key_source() :: :ok
  def log_key_source do
    case key_source() do
      :environment ->
        Logger.info("permalinks: minting with CYTALE_PERMALINK_KEY from the environment")

      :derived ->
        Logger.info(
          "permalinks: CYTALE_PERMALINK_KEY is not set — minting with a key DERIVED from " <>
            "this instance's secret_key_base (per-install, unguessable). Set CYTALE_PERMALINK_KEY " <>
            "to pin it; NOTE that setting or changing it, or rotating secret_key_base, invalidates " <>
            "every previously copied permalink."
        )
    end

    :ok
  end

  @doc """
  The derivation, as a pure function of the instance's secret — exposed so the
  suite can pin that it is per-install and that two instances never share a key.
  Production reaches it through `key_of/1`, which prefers the configured value.
  """
  @spec derive_key(String.t()) :: String.t()
  def derive_key(secret_key_base) when is_binary(secret_key_base) do
    @context <> "\0" <> secret_key_base
  end

  # -- the key -------------------------------------------------------------------

  # The app env wins so a release can translate the variable once (runtime.exs /
  # `config :cytale, :permalink_key`), and so a test can pin a known key; the raw
  # environment variable is read as the documented fallback, which is what keeps
  # `CYTALE_PERMALINK_KEY=x` a complete instruction.
  defp configured_key do
    case Application.get_env(:cytale, :permalink_key) do
      value when is_binary(value) and byte_size(value) > 0 -> value
      _ -> nil
    end ||
      case System.get_env("CYTALE_PERMALINK_KEY") do
        value when is_binary(value) and byte_size(value) > 0 -> value
        _ -> nil
      end
  end

  defp key_of(nil), do: configured_key() || derived_key()
  defp key_of(key) when is_binary(key), do: key

  # Per-install and stable: the instance's own secret, domain-separated. Not
  # cached — two sha256 calls over a short string are nothing next to the Scylla
  # read the caller is about to do, and a cache here would be a second place for
  # "which key is in use" to be wrong (see the boot line above).
  defp derived_key do
    case Application.get_env(:cytale, CytaleWeb.Endpoint, [])[:secret_key_base] do
      secret when is_binary(secret) and byte_size(secret) > 0 ->
        derive_key(secret)

      _ ->
        raise """
        Cytale.Permalinks cannot derive a key: this instance has no `secret_key_base` \
        (and CYTALE_PERMALINK_KEY is unset). Set CYTALE_PERMALINK_KEY, or configure the \
        endpoint's secret_key_base — Phoenix needs one to boot anyway.
        """
    end
  end

  # Domain separation per USE of the key material: the AES key and the tag key
  # are both derived, and neither is the configured value itself.
  defp subkey(key, purpose) do
    :crypto.hash(:sha256, key <> "\0" <> purpose)
  end

  defp crypt(key, block, encrypt?) do
    :crypto.crypto_one_time(:aes_256_ecb, subkey(key, "enc"), block, encrypt?)
  end

  # A TRUNCATED tag (see the moduledoc for why 6 bytes is the balance).
  defp tag(key, ciphertext) do
    :crypto.mac(:hmac, :sha256, subkey(key, "tag"), ciphertext)
    |> binary_part(0, @tag_bytes)
  end

  defp id?(id), do: is_integer(id) and id >= 0 and id < bsl(1, @id_bits)

  # -- base62 (the shared alphabet) ----------------------------------------------

  @doc """
  Encode bytes as base62 in the shared alphabet. Exported for the alphabet pin
  in the suite; nothing else should need it.
  """
  @spec base62_encode(binary()) :: String.t()
  def base62_encode(bytes) when is_binary(bytes) do
    bytes
    |> :binary.decode_unsigned()
    |> digits([])
    |> IO.iodata_to_binary()
  end

  # Value 0 still has a spelling (`ID_RE`-era `1001`→`qj` produced ids; a value
  # of 0 is reachable for ids, not for a 22-byte blob — but the rule stays total).
  defp digits(0, []), do: [:binary.at(@alphabet, 0)]
  defp digits(0, acc), do: acc

  defp digits(value, acc) do
    digits(div(value, 62), [:binary.at(@alphabet, rem(value, 62)) | acc])
  end

  # Decode to EXACTLY `size` bytes: fewer means the value cannot be a token of
  # that width (the encoding is a fixed-width integer, so a short token is a
  # malformed one, not a padded one — padding it by hand would accept a token
  # nobody minted).
  defp base62_decode(token, size) do
    Enum.reduce_while(:binary.bin_to_list(token), {:ok, 0}, fn char, {:ok, value} ->
      case Map.fetch(@alphabet_index, char) do
        {:ok, digit} -> {:cont, {:ok, value * 62 + digit}}
        :error -> {:halt, :error}
      end
    end)
    |> case do
      {:ok, value} when value < bsl(1, size * 8) ->
        bytes = :binary.encode_unsigned(value)
        padding = size - byte_size(bytes)

        if padding >= 0 do
          {:ok, :binary.copy(<<0>>, padding) <> bytes}
        else
          :error
        end

      _ ->
        :error
    end
  end
end
