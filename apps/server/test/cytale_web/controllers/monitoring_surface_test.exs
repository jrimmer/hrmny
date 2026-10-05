defmodule CytaleWeb.MonitoringSurfaceTest do
  @moduledoc """
  #87 — the two surfaces an operator's monitor talks to.

  Both halves are pinned here because both have a way of being useless while
  looking finished:

    * **readiness** must FAIL when a dependency is down. A deep probe that
      always answers 200 is a shallow probe with extra words, so the failure
      path is tested via the injectable check rather than by stopping ScyllaDB;
    * **the scrape surface** must be OFF when unconfigured. An open metrics
      endpoint leaks workspace ids and event names, so "no token" must mean 404,
      not "public" — that is the difference between a monitoring endpoint and an
      information-disclosure bug.
  """

  use Cytale.ScyllaCase, async: false

  import Phoenix.ConnTest
  import Plug.Conn, only: [put_req_header: 3, get_resp_header: 2]

  @endpoint CytaleWeb.Endpoint

  defp json(conn), do: Jason.decode!(conn.resp_body)

  describe "readiness (GET /health/ready)" do
    test "200 with the check named when the database answers" do
      old = Application.get_env(:cytale, :readiness_scylla_check)
      Application.put_env(:cytale, :readiness_scylla_check, fn -> :ok end)
      on_exit(fn -> restore(:readiness_scylla_check, old) end)

      conn = get(build_conn(), "/health/ready")

      assert conn.status == 200
      assert json(conn)["status"] == "ok"
      assert json(conn)["checks"]["scylla"]["status"] == "ok"
      # The liveness URL stays distinguishable and stays cheap.
      refute Map.has_key?(json(conn), "checks") and conn.request_path == "/health"
    end

    test "503 naming the failing check when the database is down" do
      old = Application.get_env(:cytale, :readiness_scylla_check)
      Application.put_env(:cytale, :readiness_scylla_check, fn -> {:error, :noproc} end)
      on_exit(fn -> restore(:readiness_scylla_check, old) end)

      conn = get(build_conn(), "/health/ready")

      # 503, not 500: the service is up and saying which dependency is not.
      assert conn.status == 503
      body = json(conn)
      assert body["status"] == "degraded"
      assert body["checks"]["scylla"]["status"] == "error"
      assert body["checks"]["scylla"]["error"] =~ "noproc"
    end

    test "the real check runs against ScyllaDB and answers" do
      # No injection: the default path, exercised for real (this suite has a
      # live keyspace, so a passing check is the honest signal).
      conn = get(build_conn(), "/health/ready")
      assert conn.status == 200
      assert json(conn)["checks"]["scylla"]["status"] == "ok"
    end

    test "liveness still consults nothing" do
      conn = get(build_conn(), "/health")
      assert conn.status == 200
      assert json(conn)["status"] == "ok"
      refute Map.has_key?(json(conn), "checks")
    end
  end

  describe "the scrape surface (GET /metrics)" do
    test "is OFF (404) when no token is configured" do
      old = Application.get_env(:cytale, :metrics_token)
      Application.delete_env(:cytale, :metrics_token)
      on_exit(fn -> restore(:metrics_token, old) end)

      conn = get(build_conn(), "/metrics")

      # Fail-closed: an unconfigured scrape surface is invisible, not public.
      assert conn.status == 404
      refute conn.resp_body =~ "cytale_"
    end

    test "401 without the bearer, 200 with it" do
      old = Application.get_env(:cytale, :metrics_token)
      Application.put_env(:cytale, :metrics_token, "scrape-me")
      on_exit(fn -> restore(:metrics_token, old) end)

      assert get(build_conn(), "/metrics").status == 401

      assert build_conn() |> put_req_header("authorization", "Bearer wrong") |> get("/metrics") |> Map.get(:status) ==
               401

      ok = build_conn() |> put_req_header("authorization", "Bearer scrape-me") |> get("/metrics")
      assert ok.status == 200
      assert get_resp_header(ok, "content-type") |> hd() =~ "text/plain"
      assert get_resp_header(ok, "cache-control") == ["no-store"]

      # Prometheus text exposition, not JSON: HELP/TYPE per family, and one
      # sample per aggregate (the ring's four numbers as a label, so the metric
      # name stays the truthful unit-carrying key).
      assert ok.resp_body =~ "# TYPE cytale_fanout_dispatch_ms gauge"
      assert ok.resp_body =~ ~r/^cytale_fanout_dispatch_ms\{stat="p99"\} \d/m
      assert ok.resp_body =~ ~r/^cytale_fanout_dispatch_ms\{stat="samples"\} \d/m
    end
  end

  defp restore(key, nil), do: Application.delete_env(:cytale, key)
  defp restore(key, value), do: Application.put_env(:cytale, key, value)
end
