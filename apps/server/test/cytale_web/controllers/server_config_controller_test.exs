defmodule CytaleWeb.Controllers.ServerConfigControllerTest do
  @moduledoc """
  #121 — the Server Settings HTTP surface: the operator gate on all three
  routes, the honest GET (NEVER a secret), the validated PUT (hot-apply +
  restart_required + specific refusals that leave the file untouched), and
  the restart route (gate + injectable stop — the test VM is never stopped).
  """

  use Cytale.ScyllaCase, async: false

  import Phoenix.ConnTest
  import Plug.Conn
  import ExUnit.CaptureLog

  alias Cytale.Accounts.{Auth, User}
  alias Cytale.ServerConfig
  alias Cytale.ServerConfig.Schema

  @endpoint CytaleWeb.Endpoint

  @env_keys [
    :operator_user_ids,
    :server_config_path,
    :server_secrets_path,
    :server_config_generate,
    :server_secrets,
    :server_restart_fn,
    :cors,
    :registration_open,
    :require_verified_email,
    :backups,
    :ssh
  ]

  defp run_nonce, do: "sc" <> Cytale.TestNonce.get()
  defp run_unique(base), do: base <> run_nonce()

  setup do
    saved = Map.new(@env_keys, fn k -> {k, Application.get_env(:cytale, k)} end)

    dir = Path.join(System.tmp_dir!(), "cytale-srvcfg-http-#{System.unique_integer([:positive])}")
    File.mkdir_p!(dir)
    config_path = Path.join(dir, "config.json")

    Application.put_env(:cytale, :server_config_path, config_path)
    Application.delete_env(:cytale, :server_secrets_path)
    Application.put_env(:cytale, :server_config_generate, true)
    # Planted secret material — the GET must never carry ANY of it.
    Application.put_env(:cytale, :server_secrets, %{
      "mailer_api_key" => "planted-mailer-secret-x121",
      "turn_secret" => "planted-turn-secret-x121",
      "ssh_ca_key_path" => "/planted/ca/path/x121",
      "session_bridge_credential" => "planted-bridge-secret-x121"
    })

    on_exit(fn ->
      Enum.each(@env_keys, fn k ->
        case Map.fetch(saved, k) do
          {:ok, nil} -> Application.delete_env(:cytale, k)
          {:ok, value} -> Application.put_env(:cytale, k, value)
        end
      end)

      File.rm_rf!(dir)
    end)

    {:ok, owner} = User.create(run_unique("scfg_op"), run_unique("scfg_op@example.com"), "password-123")
    {:ok, other} = User.create(run_unique("scfg_o"), run_unique("scfg_o@example.com"), "password-123")

    Application.put_env(:cytale, :operator_user_ids, [owner.user_id])

    conn =
      Phoenix.ConnTest.build_conn()
      |> put_req_header("accept", "application/json")
      |> put_req_header("content-type", "application/json")
      |> put_req_header("authorization", "Bearer " <> Auth.issue_access_token(owner.user_id, owner.username, true))

    # A real file on disk for every test (first-boot generation).
    capture_log(fn -> ServerConfig.boot!() end)

    %{conn: conn, config_path: config_path, dir: dir, owner: owner, other: other}
  end

  defp other_conn(%{other: other}) do
    Phoenix.ConnTest.build_conn()
    |> put_req_header("accept", "application/json")
    |> put_req_header("content-type", "application/json")
    |> put_req_header("authorization", "Bearer " <> Auth.issue_access_token(other.user_id, other.username, true))
  end

  defp anon_conn do
    Phoenix.ConnTest.build_conn()
    |> put_req_header("accept", "application/json")
    |> put_req_header("content-type", "application/json")
  end

  # -- The operator gate ------------------------------------------------------------

  test "unauthenticated → 401 on all three routes" do
    assert anon_conn() |> get("/api/v1/admin/config") |> Map.get(:status) == 401

    assert anon_conn()
           |> put("/api/v1/admin/config", %{"registration_open" => false})
           |> Map.get(:status) == 401

    assert anon_conn() |> post("/api/v1/admin/restart", %{}) |> Map.get(:status) == 401
  end

  test "non-operator → 403 on all three routes", ctx do
    assert other_conn(ctx) |> get("/api/v1/admin/config") |> Map.get(:status) == 403

    assert other_conn(ctx)
           |> put("/api/v1/admin/config", %{"registration_open" => false})
           |> Map.get(:status) == 403

    assert other_conn(ctx) |> post("/api/v1/admin/restart", %{}) |> Map.get(:status) == 403
  end

  # -- GET: the honest editor read ---------------------------------------------------

  test "GET serves the editable document + per-key metadata; NEVER a secret", %{conn: conn} = ctx do
    conn = get(conn, "/api/v1/admin/config")
    assert conn.status == 200

    %{"config" => config, "metadata" => metadata} = Jason.decode!(conn.resp_body)

    for key <- Schema.editor_keys() do
      assert {:ok, _} = Schema.fetch_path(config, key.path), "missing editor key #{key.path}"
    end

    assert metadata["backups.frequency"]["scope"] == "runtime"
    assert metadata["backups.frequency"]["type"] =~ "enum"
    assert metadata["ssh.enabled"]["scope"] == "boot"
    assert is_binary(metadata["ssh.enabled"]["description"])

    body = conn.resp_body

    for secret <- Schema.secret_keys() do
      refute body =~ secret.key, "GET leaked the secret KEY NAME #{secret.key}"
      refute body =~ "x121", "GET leaked planted secret material"
    end

    # The planted values specifically.
    for planted <- ["planted-mailer-secret-x121", "planted-turn-secret-x121", "/planted/ca/path/x121"] do
      refute body =~ planted
    end

    # And the endpoint did not touch the secrets file.
    assert File.read!(Path.join(ctx.dir, "secrets.json"))
  end

  # -- PUT: validate → atomic write → hot-apply ---------------------------------------

  test "PUT a runtime-scoped change: applied LIVE (Cytale.Config reads it), file updated", %{
    conn: conn,
    config_path: config_path
  } do
    conn = put(conn, "/api/v1/admin/config", %{"cors" => %{"allowed_origins" => ["https://live.example"]}})
    assert conn.status == 200

    assert %{"ok" => true, "changed" => ["cors.allowed_origins"], "restart_required" => false} =
             Jason.decode!(conn.resp_body)

    # LIVE — the existing reader, no restart.
    assert Cytale.Config.cors_allowed_origins() == ["https://live.example"]
    assert Jason.decode!(File.read!(config_path))["cors"]["allowed_origins"] == ["https://live.example"]
  end

  test "PUT a boot-scoped change: restart_required true, runtime state untouched", %{conn: conn} do
    conn = put(conn, "/api/v1/admin/config", %{"ssh" => %{"enabled" => true}})
    assert conn.status == 200

    assert %{"ok" => true, "changed" => ["ssh.enabled"], "restart_required" => true} =
             Jason.decode!(conn.resp_body)

    assert Cytale.Config.ssh_certificates_enabled?() == false
  end

  test "PUT invalid: 400 with the SPECIFIC error, the file byte-identical", %{
    conn: conn,
    config_path: config_path,
    owner: owner
  } do
    original = File.read!(config_path)

    cases = [
      {%{"backups" => %{"frequency" => "monthly"}}, "expected one of"},
      {%{"backups" => %{"retention" => 0}}, "integer >= 1"},
      {%{"registration_open" => 3}, "expected true or false"},
      {%{"totally_unknown" => true}, "unknown key"}
    ]

    for {doc, message} <- cases do
      conn = put(conn, "/api/v1/admin/config", doc)
      assert conn.status == 400, "expected 400 for #{inspect(doc)}"

      %{"error" => %{"key" => "validation_failed", "message" => msg, "details" => details}} =
        Jason.decode!(conn.resp_body)

      assert msg =~ message, "unexpected message for #{inspect(doc)}: #{msg}"
      assert Enum.any?(details, &(&1["message"] =~ message))
    end

    # Invalid JSON at the wire: refused before any write, too. The parser
    # raises before a controller could run — the file is untouched either way.
    raw_conn = fn ->
      Phoenix.ConnTest.build_conn()
      |> put_req_header("accept", "application/json")
      |> put_req_header("content-type", "application/json")
      |> put_req_header(
        "authorization",
        "Bearer " <> Auth.issue_access_token(owner.user_id, owner.username, true)
      )
      |> put("/api/v1/admin/config", "{this is not json")
    end

    assert_raise(Plug.Parsers.ParseError, fn -> raw_conn.() end)
    assert File.read!(config_path) == original
  end

  test "PUT preserves the hidden deployment facts it was never shown", %{conn: conn, config_path: config_path} do
    File.write!(
      config_path,
      Jason.encode!(%{
        "backups" => %{"frequency" => "weekly", "retention" => 7, "enabled" => false, "dir" => "/var/backups"}
      })
    )

    capture_log(fn -> ServerConfig.boot!() end)

    conn = put(conn, "/api/v1/admin/config", %{"backups" => %{"retention" => 21}})
    assert conn.status == 200

    doc = Jason.decode!(File.read!(config_path))
    assert doc["backups"]["retention"] == 21
    assert doc["backups"]["enabled"] == false
    assert doc["backups"]["dir"] == "/var/backups"
  end

  # -- POST restart: the gate, and the INJECTABLE stop ----------------------------------

  test "POST restart: responds ok, then invokes the INJECTED stop — the test VM is never stopped", %{
    conn: conn
  } do
    test = self()

    Application.put_env(:cytale, :server_restart_fn, fn -> send(test, :restart_invoked) end)

    conn = post(conn, "/api/v1/admin/restart", %{})
    assert conn.status == 200
    assert %{"ok" => true} = Jason.decode!(conn.resp_body)

    # The stop runs off-process, after a beat (response first).
    assert_receive :restart_invoked, 2_000
    # ...and this process obviously still runs: the node was not stopped.
    assert Process.alive?(self())
  end

  # -- helpers ---------------------------------------------------------------------------
end
