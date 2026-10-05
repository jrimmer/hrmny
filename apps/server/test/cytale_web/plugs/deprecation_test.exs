defmodule CytaleWeb.Plugs.DeprecationTest do
  @moduledoc """
  U29 — Deprecation/Sunset header middleware. The registry is empty at
  launch; these tests declare a deprecation, run a request through a minimal
  plug pipeline, and assert the IETF headers land exactly as documented in
  `docs/protocol/versioning.md`.
  """

  use ExUnit.Case, async: false

  import Plug.Conn
  import Phoenix.ConnTest

  @endpoint __MODULE__.NoEndpoint

  defp call_with_registry(path, registry) do
    Application.put_env(:cytale, :deprecated_routes, registry, persistent: false)

    conn =
      Plug.Test.conn(:get, path)
      |> put_private(:cytale_deprecation_test, true)

    CytaleWeb.Plugs.Deprecation.call(conn, [])
  end

  defp sunset_dt, do: ~U[2028-12-31 23:59:59Z]

  test "deprecated path prefix gets Deprecation + Sunset headers" do
    conn =
      call_with_registry("/api/v1/example", [
        {"/api/v1/example", sunset: sunset_dt(), api_version: "v1"}
      ])

    assert get_resp_header(conn, "deprecation") == [~s(version="v1")]
    assert get_resp_header(conn, "sunset") == ["Sun, 31 Dec 2028 23:59:59 GMT"]
  end

  test "non-deprecated path gets no headers" do
    conn =
      call_with_registry("/api/v1/fresh", [
        {"/api/v1/example", sunset: sunset_dt()}
      ])

    assert get_resp_header(conn, "deprecation") == []
    assert get_resp_header(conn, "sunset") == []
  end

  test "longest matching prefix wins" do
    conn =
      call_with_registry("/api/v1/example/deep", [
        {"/api/v1", sunset: sunset_dt()},
        {"/api/v1/example", sunset: ~U[2027-06-30 12:00:00Z], api_version: "v1"}
      ])

    assert get_resp_header(conn, "deprecation") == [~s(version="v1")]
    assert get_resp_header(conn, "sunset") == ["Wed, 30 Jun 2027 12:00:00 GMT"]
  end

  test "empty registry (launch state) never adds headers" do
    conn = call_with_registry("/api/v1/anything", [])
    assert get_resp_header(conn, "deprecation") == []
    assert get_resp_header(conn, "sunset") == []
  end

  @tag :deprecation_registry_cleanup
  setup do
    on_exit(fn -> Application.delete_env(:cytale, :deprecated_routes) end)
    :ok
  end
end
