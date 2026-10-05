defmodule Cytale.Calls.ICETest do
  # async: false — the runtime fail-fast cases mutate process env (the
  # application_test.exs pattern for System.put_env-based cases).
  use ExUnit.Case, async: false

  alias Cytale.Calls.ICE

  describe "config/0 (ex_webrtc compile-smoke)" do
    test "returns a stable ICE config map (loopback dev/test: no STUN/TURN)" do
      assert %{ice_servers: servers, media_udp_port_range: {first, last}} = ICE.config()

      # Dev/test configure loopback-only ICE: host candidates over the local
      # network, zero STUN/TURN egress from the VM.
      assert servers == []

      # The default range matches the span the app container publishes (KTD2).
      assert {first, last} == {50_000, 50_999}
      assert is_integer(first) and first >= 1
      assert is_integer(last) and last >= first and last <= 65_535
    end

    test "ex_webrtc and its NIF chain are loaded in the test VM" do
      # ICE.config/0 pattern-matches Code.ensure_loaded/1 on each anchor, so
      # merely calling it (above) proves loading — pin the anchors explicitly
      # so a future config/0 rewrite cannot silently drop the smoke.
      for module <- [ExWebRTC.PeerConnection, ExDTLS.Native.Nif, ExLibSRTP.Native.Nif] do
        assert {:module, ^module} = Code.ensure_loaded(module),
               "expected #{inspect(module)} to load (broken ex_webrtc NIF build?)"
      end

      assert %{} = ICE.config()
    end

    test "absent TURN env → loopback-only ICE servers, no crash" do
      # The boot under test already ran runtime.exs with no CYTALE_TURN_* set
      # (hermetic runner); pin that the frozen value is the loopback default.
      assert Cytale.Config.calls_ice_servers() == []
      assert CytaleRuntime.turn_servers!(nil, nil, nil) == []
    end
  end

  describe "runtime fail-fast: TURN trio" do
    test "a complete CYTALE_TURN_* trio yields one TURN entry in ex_webrtc shape" do
      assert [%{urls: "turn:turn.cytale.test:3478", username: "u", credential: "c"}] =
               CytaleRuntime.turn_servers!("turn:turn.cytale.test:3478", "u", "c")
    end

    test "whitespace-only values count as absent; fully-blank trio stays loopback" do
      assert [] = CytaleRuntime.turn_servers!("  ", "", nil)
    end

    test "blank-but-set alongside real values is still a partial trio (raises)" do
      assert_raise ArgumentError, ~r/must be set together/, fn ->
        CytaleRuntime.turn_servers!("  ", "u", nil)
      end
    end

    test "a partially-set trio raises at boot (never unauthenticated TURN)" do
      assert_raise ArgumentError, ~r/CYTALE_TURN_URL .* must be set together/, fn ->
        CytaleRuntime.turn_servers!("turn:turn.cytale.test:3478", "u", nil)
      end
    end

    test "the raise redacts credential material to set/unset markers" do
      err =
        assert_raise ArgumentError, fn ->
          CytaleRuntime.turn_servers!("turn:turn.cytale.test:3478", "super-secret-user", nil)
        end

      message = Exception.message(err)
      assert message =~ "username: set"
      assert message =~ "credential: unset"
      refute message =~ "super-secret-user"

      err =
        assert_raise ArgumentError, fn ->
          CytaleRuntime.turn_servers!("  ", "u", "hunter2-cred")
        end

      message = Exception.message(err)
      assert message =~ "username: set"
      assert message =~ "credential: set"
      # The values themselves NEVER ride the exception message.
      refute message =~ "hunter2-cred"
    end
  end

  describe "ephemeral TURN minting (U12, eturnal REST-auth)" do
    @frozen_now 1_800_000_000
    @secret "test-turn-secret-with-plenty-of-length"
    @url "turn:turn.cytale.test:3478"

    setup do
      original = Application.get_env(:cytale, :calls)
      Application.put_env(:cytale, :calls, turn: %{url: @url, secret: @secret})
      on_exit(fn -> Application.put_env(:cytale, :calls, original) end)
      :ok
    end

    test "mint derivation is deterministic given a frozen timestamp" do
      assert [%{urls: @url, username: username, credential: credential}] =
               Cytale.Config.calls_ice_servers(@frozen_now)

      # draft-uberti-behave-turn-rest: username = expiry unix timestamp,
      # credential = Base64(HMAC-SHA1(secret, username)).
      assert username == Integer.to_string(@frozen_now + 3_600)
      assert credential == Base.encode64(:crypto.mac(:hmac, :sha, @secret, username))
      # 20 SHA1 bytes, base64-padded
      assert byte_size(credential) == 28
    end

    test "expiry window is sane: 1h from the read, refreshed on every read" do
      [entry] = Cytale.Config.calls_ice_servers(@frozen_now)
      assert String.to_integer(entry.username) - @frozen_now == 3_600

      # Mint-on-read: consecutive reads at later timestamps mint later windows.
      [later] = Cytale.Config.calls_ice_servers(@frozen_now + 60)
      assert String.to_integer(later.username) > String.to_integer(entry.username)
      assert later.credential != entry.credential
    end

    test "the static secret NEVER appears in the client-visible map" do
      [entry] = Cytale.Config.calls_ice_servers(@frozen_now)

      assert Map.keys(entry) |> MapSet.new() == MapSet.new([:urls, :username, :credential])
      refute entry[:secret]
      refute entry.credential =~ @secret
      # Deep inspection of the full rendered JSON a client would receive.
      json = Jason.encode!(%{ice_servers: [entry]})
      refute json =~ @secret
    end

    test "secret mode takes precedence: static ice_servers stay empty (runtime sets [])" do
      Application.put_env(:cytale, :calls, turn: %{url: @url, secret: @secret}, ice_servers: [%{urls: "turn:stale"}])

      assert [%{urls: @url}] = Cytale.Config.calls_ice_servers(@frozen_now)
    after
      Application.put_env(:cytale, :calls, turn: %{url: @url, secret: @secret})
    end
  end

  describe "runtime fail-fast: TURN secret mode (turn_auth!/4)" do
    test "absent everything → nil (no TURN, loopback default)" do
      assert CytaleRuntime.turn_auth!(nil, nil, nil, nil) == nil
      assert CytaleRuntime.turn_auth!(" ", "", "  ", "") == nil
    end

    test "URL + secret → the secret-mode map" do
      secret = String.duplicate("s", 32)

      assert %{url: "turn:t:3478", secret: ^secret} =
               CytaleRuntime.turn_auth!("turn:t:3478", secret, nil, nil)
    end

    test "a secret under 32 characters fails the boot, without echoing it" do
      error =
        assert_raise ArgumentError, ~r/must be at least 32 characters/, fn ->
          CytaleRuntime.turn_auth!("turn:t:3478", "short-turn-secret", nil, nil)
        end

      refute error.message =~ "short-turn-secret"
    end

    test "secret without URL raises (nothing to allocate on)" do
      assert_raise ArgumentError, ~r/CYTALE_TURN_SECRET requires CYTALE_TURN_URL/, fn ->
        CytaleRuntime.turn_auth!(nil, "s", nil, nil)
      end
    end

    test "secret mixed with the static trio raises (ambiguous mode)" do
      assert_raise ArgumentError, ~r/must NOT be combined with/, fn ->
        CytaleRuntime.turn_auth!("turn:t:3478", "s", "u", "c")
      end

      assert_raise ArgumentError, ~r/must NOT be combined with/, fn ->
        CytaleRuntime.turn_auth!("turn:t:3478", "s", nil, "c")
      end
    end

    test "secret unset → nil regardless of the static trio (its own validation applies)" do
      assert CytaleRuntime.turn_auth!("turn:t:3478", nil, "u", "c") == nil
      assert CytaleRuntime.turn_auth!("turn:t:3478", nil, "u", nil) == nil
    end
  end

  describe "runtime fail-fast: media UDP port range" do
    test "absent env keeps the default span" do
      original = System.get_env("CYTALE_MEDIA_UDP_PORT_RANGE")

      System.delete_env("CYTALE_MEDIA_UDP_PORT_RANGE")
      assert CytaleRuntime.parse_port_range!("CYTALE_MEDIA_UDP_PORT_RANGE", {50_000, 50_999}) == {50_000, 50_999}

      restore_env("CYTALE_MEDIA_UDP_PORT_RANGE", original)
    end

    test "FIRST-LAST parses" do
      original = System.get_env("CYTALE_MEDIA_UDP_PORT_RANGE")

      System.put_env("CYTALE_MEDIA_UDP_PORT_RANGE", "51000-51500")
      assert CytaleRuntime.parse_port_range!("CYTALE_MEDIA_UDP_PORT_RANGE", {50_000, 50_999}) == {51_000, 51_500}

      restore_env("CYTALE_MEDIA_UDP_PORT_RANGE", original)
    end

    test "garbage and inverted ranges raise" do
      original = System.get_env("CYTALE_MEDIA_UDP_PORT_RANGE")

      for bad <- ["50000", "a-b", "50000-", "60000-50000", "0-50000", "1-70000", "50000-50999-1"] do
        System.put_env("CYTALE_MEDIA_UDP_PORT_RANGE", bad)

        assert_raise ArgumentError, ~r/must be a port range/, fn ->
          CytaleRuntime.parse_port_range!("CYTALE_MEDIA_UDP_PORT_RANGE", {50_000, 50_999})
        end
      end

      restore_env("CYTALE_MEDIA_UDP_PORT_RANGE", original)
    end
  end

  # Restore on EXIT, not at the end of the body. An assertion failing midway
  # left the variable set to whatever this test had put there, and a later file
  # that boots runtime.exs in a subprocess inherited it — surfacing as an
  # unrelated file's failure naming a value only this test ever writes. The nil
  # clause used to be a silent no-op, so a test that DELETED the variable never
  # restored it at all.
  defp restore_env(key, value) do
    on_exit(fn ->
      if value === nil do
        System.delete_env(key)
      else
        System.put_env(key, value)
      end
    end)

    :ok
  end
end
