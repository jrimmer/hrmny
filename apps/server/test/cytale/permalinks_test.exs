defmodule Cytale.PermalinksTest do
  @moduledoc """
  #118 — the opaque permalink token (`Cytale.Permalinks`), unit level.

  What is pinned here, in order of how much it would hurt to get wrong:

    * **A tampered token fails CLOSED.** A flipped bit in the payload and a
      flipped bit in the tag are separate cases, and the strongest form of the
      rule is asserted too: over EVERY single-character mutation of a real
      token, no mutation may resolve to a DIFFERENT message — the decode is
      either the original pair or nothing at all.
    * **The key is the authentication.** A token minted under one key decodes
      under no other, and the derived key is a function of the instance secret,
      so two installs never interoperate and rotating the secret orphans the
      links minted before it (deliberately — see the moduledoc).
    * **The alphabet is the CLIENT's.** `packages/domain`'s `B62_ALPHABET` is
      the one base62 alphabet in this repo; this suite reads that file and
      asserts the two literals are equal, which makes "do not invent a second
      one" a test rather than a comment.
    * **Shape**: one opaque segment with no route grammar in it, 29–30 base62
      characters for a realistic pair.

  Pure functions only — no database, no HTTP (the mint/resolve route behavior
  is `CytaleWeb.Controllers.PermalinkControllerTest`).
  """

  use ExUnit.Case, async: true

  import ExUnit.CaptureLog

  alias Cytale.Permalinks

  # A realistic pair: a channel and a message on the production instance, 17
  # decimal digits each (and the pair the module's own docs use).
  @channel 91_267_303_441_694_720
  @message 92_770_849_337_114_624
  @key "permalink-test-key"

  @alphabet "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"

  # 16 bytes of enciphered ids + 6 bytes of tag, per the moduledoc.
  @payload_bytes 16
  @token_bytes 22

  describe "the round trip" do
    test "mint → decode returns the same pair" do
      token = Permalinks.encode(@channel, @message, @key)
      assert {:ok, {@channel, @message}} = Permalinks.decode(token, @key)
    end

    test "it is deterministic: one message, one link" do
      assert Permalinks.encode(@channel, @message, @key) ==
               Permalinks.encode(@channel, @message, @key)
    end

    test "two messages in ONE channel share no prefix" do
      mine = Permalinks.encode(@channel, @message, @key)
      other = Permalinks.encode(@channel, @message + 1, @key)

      refute other == mine
      # The permutation covers the whole 16-byte block, so not even the first
      # four characters are shared between two messages of the same channel:
      # comparing two tokens tells an observer nothing.
      refute String.slice(other, 0, 4) == String.slice(mine, 0, 4)
    end

    test "a DM target is not a special case — the token carries no workspace" do
      # A DM channel has no workspace (its id is globally unique) and the token
      # never had a workspace to name: whatever channel the caller can address,
      # it can mint.
      dm_channel = 8_100_000_000_000_001
      token = Permalinks.encode(dm_channel, @message, @key)
      assert {:ok, {^dm_channel, @message}} = Permalinks.decode(token, @key)
    end

    test "the ends of the u64 range survive" do
      pairs = [
        {0, 0},
        {0, 1},
        {18_446_744_073_709_551_615, 1},
        {1, 18_446_744_073_709_551_615}
      ]

      for {channel_id, message_id} <- pairs do
        token = Permalinks.encode(channel_id, message_id, @key)
        assert {:ok, {^channel_id, ^message_id}} = Permalinks.decode(token, @key)
      end
    end

    test "a non-integer id is refused rather than raised on a request path" do
      assert {:error, :bad_id} = Permalinks.mint("9000", @message)
      assert {:error, :bad_id} = Permalinks.mint(@channel, -1)
      assert {:error, :bad_id} = Permalinks.mint(@channel, 18_446_744_073_709_551_616)
      assert {:ok, token} = Permalinks.mint(@channel, @message)
      assert {:ok, {@channel, @message}} = Permalinks.resolve(token)
    end
  end

  describe "the token's shape" do
    test "one opaque segment, 29–30 base62 characters for a realistic pair" do
      token = Permalinks.encode(@channel, @message, @key)

      assert token =~ ~r/\A[#{@alphabet}]+\z/
      assert String.length(token) in 29..30

      # None of the route grammar reaches the link, and no id is exposed.
      refute token =~ "workspace"
      refute token =~ "channel"
      refute token =~ "message"
      refute token =~ Integer.to_string(@channel)
      refute token =~ Integer.to_string(@message)
    end

    test "it is shorter than the #118 fragment spelling it replaces" do
      token = Permalinks.encode(@channel, @message, @key)

      legacy =
        "https://chat.example.com/#/workspace/#{@channel}/channel/#{@channel}/message/#{@message}"

      mine = "https://chat.example.com/m/#{token}"
      assert String.length(mine) < String.length(legacy)
      assert String.length(mine) < 60
    end

    test "the encoder uses the CLIENT's base62 alphabet, not a second one" do
      source =
        Path.expand("../../../../packages/domain/src/permalink.ts", __DIR__)
        |> File.read!()

      assert [_, literal] = Regex.run(~r/const B62_ALPHABET = '([^']+)'/, source)
      assert literal == @alphabet

      # …and the server really writes in it: the shared encoder agrees with the
      # alphabet's index order (0 ⇒ "a", 61 ⇒ "9", 62 ⇒ "ba").
      assert Permalinks.base62_encode(<<0>>) == "a"
      assert Permalinks.base62_encode(<<61>>) == "9"
      assert Permalinks.base62_encode(<<62>>) == "ba"
    end
  end

  describe "tampering fails closed" do
    setup do
      {:ok, token: Permalinks.encode(@channel, @message, @key)}
    end

    test "a bit flipped in the PAYLOAD is refused", %{token: token} do
      bytes = blob(token)
      mutated = put_byte(bytes, 3, Bitwise.bxor(:binary.at(bytes, 3), 1))

      assert byte_size(bytes) == @token_bytes
      refute Permalinks.base62_encode(mutated) == token
      assert :error = Permalinks.decode(Permalinks.base62_encode(mutated), @key)
    end

    test "a bit flipped in the TAG is refused", %{token: token} do
      bytes = blob(token)
      mutated = put_byte(bytes, @payload_bytes + 2, Bitwise.bxor(:binary.at(bytes, @payload_bytes + 2), 1))

      assert :error = Permalinks.decode(Permalinks.base62_encode(mutated), @key)
    end

    test "EVERY single-character mutation is either the same message or nothing", %{token: token} do
      # The property in its strongest form: no one-character edit of a link can
      # land the reader on a DIFFERENT message. This is the whole reason the tag
      # is in the token, and it is why a wrong tag is not something to log and
      # move past.
      chars = String.graphemes(token)

      mutations =
        for {char, index} <- Enum.with_index(chars),
            replacement <- String.graphemes(@alphabet),
            replacement != char do
          List.to_string(List.replace_at(chars, index, replacement))
        end

      # ~30 characters × 61 alternatives: the sweep is exhaustive, not a sample.
      assert length(mutations) > 1_500

      for mutated <- mutations do
        assert Permalinks.decode(mutated, @key) == :error,
               "a mutated token resolved instead of failing closed: #{mutated}"
      end
    end

    test "a token is not decodable under any other key", %{token: token} do
      assert :error = Permalinks.decode(token, "some-other-key")
      assert :error = Permalinks.decode(token, @key <> "x")
    end
  end

  describe "malformed input" do
    test "empty, non-string, non-alphabet and wrong-width tokens are refused" do
      for bad <- ["", "!!!!", "not a token at all", "zzzz", "a-b-c", nil, 12, :token] do
        assert :error = Permalinks.decode(bad, @key), "expected #{inspect(bad)} to be refused"
      end

      # Right length, wrong value: the tag is what rejects it.
      assert :error = Permalinks.decode(String.duplicate("a", 30), @key)
      # Out of the 22-byte address space entirely (62^30 > 2^176).
      assert :error = Permalinks.decode(String.duplicate("z", 31), @key)
      # A long `z`-run: settled by the width bound, never walked forever.
      assert :error = Permalinks.decode(String.duplicate("z", 40), @key)
    end
  end

  describe "the key" do
    test "the derivation is per-install, stable and not the secret itself" do
      assert Permalinks.derive_key("secret-a") == Permalinks.derive_key("secret-a")
      refute Permalinks.derive_key("secret-a") == Permalinks.derive_key("secret-b")
      refute Permalinks.derive_key("secret-a") == "secret-a"
    end

    test "two installs' derived keys do not interoperate" do
      here = Permalinks.encode(@channel, @message, Permalinks.derive_key("install-one"))
      assert Permalinks.decode(here, Permalinks.derive_key("install-one")) == {:ok, {@channel, @message}}
      assert :error = Permalinks.decode(here, Permalinks.derive_key("install-two"))
    end

    test "the boot line names the key source, and says what rotation costs" do
      log = capture_log(fn -> assert :ok = Permalinks.log_key_source() end)
      assert log =~ "CYTALE_PERMALINK_KEY"

      case Permalinks.key_source() do
        :derived ->
          assert log =~ "DERIVED"
          assert log =~ "invalidates"

        :environment ->
          assert log =~ "from the environment"
      end
    end
  end

  # -- helpers -------------------------------------------------------------------

  # The 22 raw bytes behind a token, decoded HERE rather than with the module's
  # own helpers: a test that aimed bytes through the code under test could agree
  # with a bug about where the payload ends.
  defp blob(token) do
    digits = String.graphemes(@alphabet)

    value =
      Enum.reduce(String.graphemes(token), 0, fn char, acc ->
        acc * 62 + Enum.find_index(digits, &(&1 == char))
      end)

    bytes = :binary.encode_unsigned(value)
    :binary.copy(<<0>>, @token_bytes - byte_size(bytes)) <> bytes
  end

  defp put_byte(bytes, at, byte) do
    binary_part(bytes, 0, at) <> <<byte>> <> binary_part(bytes, at + 1, @token_bytes - at - 1)
  end
end
