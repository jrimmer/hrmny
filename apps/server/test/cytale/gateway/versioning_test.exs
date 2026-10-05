defmodule Cytale.Gateway.VersioningTest do
  @moduledoc """
  U29 — gateway version-negotiation contract (R11).

  Identify REQUIRES `v`; the server accepts exactly the version Hello
  advertises (v=1 at launch) and closes with 4012 Invalid API Version on any
  other declared version. Docs: docs/protocol/versioning.md,
  docs/protocol/gateway.md.
  """

  use Cytale.GatewayCase, async: false

  setup do
    port = start_gateway!()
    %{port: port}
  end

  defp identify_d(token, v) do
    %{
      "token" => token,
      "v" => v,
      "compress" => nil,
      "properties" => %{"os" => "test", "browser" => "versioning_test", "device" => "test"}
    }
  end

  describe "version negotiation" do
    test "Hello advertises exactly the accepted version (1)", %{port: port} do
      conn = connect!(port)

      assert conn.hello["op"] == 10
      assert conn.hello["d"]["v"] == 1
    end

    test "Identify with the Hello-advertised version reaches Ready", %{port: port} do
      conn = connect!(port)
      hello_v = conn.hello["d"]["v"]

      send_frame!(conn, 2, identify_d(valid_token(), hello_v))

      ready = next_json!(conn, 5_000)
      assert ready["op"] == 0 and ready["t"] == "Ready"
    end

    test "Identify with a higher declared version → close 4012 + InvalidSession false", %{port: port} do
      conn = connect!(port)
      send_frame!(conn, 2, identify_d(valid_token(), 2))

      code = assert_closed!(conn, 5_000, [%{"op" => 9, "d" => false}])
      assert code == 4012
    end

    test "Identify with a fractional version → close 4001 (not an integer at all)", %{port: port} do
      conn = connect!(port)
      send_frame!(conn, 2, identify_d(valid_token(), 1.5))

      code = assert_closed!(conn, 5_000, [%{"op" => 9, "d" => false}])
      assert code in [4001, 4012]
    end

    test "Identify with a string version → close 4001 (type contract, not a version)", %{port: port} do
      conn = connect!(port)
      send_frame!(conn, 2, identify_d(valid_token(), "1"))

      code = assert_closed!(conn, 5_000, [%{"op" => 9, "d" => false}])
      assert code in [4001, 4012]
    end

    test "missing v → close 4001 decode error (the field is required)", %{port: port} do
      conn = connect!(port)
      send_frame!(conn, 2, %{"token" => valid_token(), "compress" => nil})

      assert assert_closed!(conn, 5_000) == 4001
    end

    test "far-future version (v=99) → close 4012, client negotiates by updating", %{port: port} do
      conn = connect!(port)
      send_frame!(conn, 2, identify_d(valid_token(), 99))

      code = assert_closed!(conn, 5_000, [%{"op" => 9, "d" => false}])
      assert code == 4012
    end
  end

  describe "compression mode parsing (U7 compat forms)" do
    test "Discord spellings parse: zlib-stream dash form and booleans" do
      assert Cytale.Gateway.Compression.parse_mode("zlib-stream") == {:ok, :zlib_stream}
      assert Cytale.Gateway.Compression.parse_mode("zlib_stream") == {:ok, :zlib_stream}
      assert Cytale.Gateway.Compression.parse_mode(false) == {:ok, :none}
      assert Cytale.Gateway.Compression.parse_mode(true) == {:ok, :zlib_stream}
      assert Cytale.Gateway.Compression.parse_mode(nil) == {:ok, :none}
      assert Cytale.Gateway.Compression.parse_mode("brotli") == :error
    end
  end
end
