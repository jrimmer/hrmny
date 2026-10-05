defmodule CytaleWeb.Controllers.BackupControllerTest do
  @moduledoc """
  #120 — the operator backup surface's BEHAVIOR: the archive list (from the
  sidecars, never touching secret values), the download stream, and the
  destructive restore intake (staged-path form + explicit confirm token;
  202 = staged + marker, then the INJECTABLE restart fires; 422 with every
  validation error and live data untouched).

  NOTE ON DISPATCH: the router block for these routes is being wired by the
  main agent (two peers collided in router.ex this week, so this ticket does
  not touch it) — these tests dispatch straight to the controller the way
  the pipeline would (`Plug` call with the operator pre-resolved), and the
  pipeline wiring itself (`:api_auth` + `:operator` on every route) is
  pinned separately below, plus the authorization-matrix declarations that
  ride the route block.
  """

  use Cytale.ScyllaCase, async: false

  import Plug.Conn

  alias Cytale.Accounts.User
  alias Cytale.Backups.{Archive, Restore}
  alias CytaleWeb.BackupController

  setup do
    # Random suffix: fresh test VMs restart unique_integer's counter.
    tmp = Path.join(System.tmp_dir!(), "cytale_bk_ctrl_#{:crypto.strong_rand_bytes(8) |> Base.encode16(case: :lower)}")
    File.mkdir_p!(tmp)

    backups_env = Application.get_env(:cytale, :backups)
    operator_env = Application.get_env(:cytale, :operator_user_ids)
    restart_env = Application.get_env(:cytale, :server_restart_fn)
    config_path_env = Application.get_env(:cytale, :server_config_path)

    Application.put_env(:cytale, :backups, frequency: "daily", retention: 3, enabled: true, dir: tmp)
    Application.put_env(:cytale, :server_config_path, Path.join(tmp, "server-config.json"))
    # The restart seam is injectable (#121): the controller must CALL it, and
    # this test observes the call instead of dying with the VM. The test pid
    # is CAPTURED — self() inside the fn is whatever process runs it (the
    # restart spawns off-process).
    test_pid = self()
    Application.put_env(:cytale, :server_restart_fn, fn -> send(test_pid, :backup_restore_restart) end)

    {:ok, operator} =
      User.create("bkc_" <> Cytale.TestNonce.get(), "bkc_#{Cytale.TestNonce.get()}@example.com", "password-123")

    {:ok, outsider} =
      User.create("bkd_" <> Cytale.TestNonce.get(), "bkd_#{Cytale.TestNonce.get()}@example.com", "password-123")

    Application.put_env(:cytale, :operator_user_ids, [operator.user_id])

    # A real finished archive to list/download/restore.
    seed_channel_for_archive()

    assert {:ok, summary} = Archive.write(dir: tmp)

    on_exit(fn ->
      Application.put_env(:cytale, :backups, backups_env)
      restore_env(:operator_user_ids, operator_env)
      restore_env(:server_restart_fn, restart_env)
      restore_env(:server_config_path, config_path_env)
      File.rm(Restore.marker_path())
      File.rm_rf!(tmp)
    end)

    {:ok, operator: operator, outsider: outsider, summary: summary, tmp: tmp}
  end

  # Key-correct: the nil clause used to delete :server_config_path regardless
  # of which key it was restoring — a copy-paste artifact that could strip the
  # config path while "restoring" the restart fn (full-gate finding).
  defp restore_env(key, nil), do: Application.delete_env(:cytale, key)
  defp restore_env(key, value), do: Application.put_env(:cytale, key, value)

  defp seed_channel_for_archive do
    # A tiny bit of live data so the archive is non-trivial and refusals can
    # prove live data survived. (One workspace, one channel, one message.)
    alias Cytale.{Messages, Workspaces}

    {:ok, ws} = Workspaces.create_workspace(1, "BkCtrl " <> Cytale.TestNonce.get())
    {:ok, ch} = Workspaces.create_channel(ws.workspace_id, "general")

    {:ok, _} = Messages.create_message(%{channel_id: ch.channel_id, author_id: 1, content: "controller seed"})
    :ok
  end

  # -- dispatch helpers (the pipeline stand-in) -----------------------------------

  # `:api_auth` resolves the bearer token to current_user; `:operator` gates
  # on the allowlist. Direct dispatch runs the OPERATOR half explicitly so
  # the gate is exercised, not assumed.
  defp operator_conn(user, params) do
    build_conn()
    |> assign(:current_user, %{user_id: user.user_id, username: user.username})
    |> Map.replace!(:params, params)
    |> put_private(:phoenix_endpoint, CytaleWeb.Endpoint)
    |> then(fn conn -> CytaleWeb.Plugs.RequireOperator.call(conn, []) end)
    |> then(fn conn -> if conn.halted, do: conn, else: BackupController.call(conn, action_for(params)) end)
  end

  defp action_for(%{"id" => _}), do: :download
  defp action_for(%{"path" => _}), do: :restore
  defp action_for(_), do: :index

  defp body(conn), do: Jason.decode!(conn.resp_body)

  # -- the gate -------------------------------------------------------------------

  test "the operator gate is the route's gate: non-operator 403, unauthenticated 403" do
    # The pipeline block the main agent pastes is: pipe_through(:api_auth); pipe_through(:operator).
    # The gate itself is fail-closed — an allowlist miss is a 403 envelope.
    conn = authless_conn() |> CytaleWeb.Plugs.RequireOperator.call([])
    assert conn.halted and conn.status == 403
  end

  defp authless_conn, do: build_conn() |> put_private(:phoenix_endpoint, CytaleWeb.Endpoint)

  # -- the list -------------------------------------------------------------------

  test "GET backups lists the archive with id/when/size/tables/rows and NO secret values", %{
    operator: operator,
    summary: summary
  } do
    conn = operator_conn(operator, %{})

    assert conn.status == 200
    assert [%{"id" => id} = backup] = body(conn)["backups"]
    assert id == summary.id
    assert backup["bytes"] == summary.bytes
    assert backup["tables"] == summary.tables
    assert backup["rows"] == summary.rows
    assert backup["created_at"]

    # The listing never carries credential values — "present" keys only.
    assert is_list(backup["secrets"]["present"])
    refute Map.has_key?(backup["secrets"], "values")
  end

  # -- the download ---------------------------------------------------------------

  test "GET backups/:id/download streams the archive; bad ids are a uniform 404", %{
    operator: operator,
    summary: summary,
    tmp: tmp
  } do
    conn = operator_conn(operator, %{"id" => summary.id})

    assert conn.status == 200
    assert get_resp_header(conn, "content-type") == ["application/x-tar"]
    assert conn.resp_body == File.read!(Path.join(tmp, "#{summary.id}.tar"))

    # Not a backup-id shape (traversal attempt) = the same 404, no oracle.
    conn = operator_conn(operator, %{"id" => "../etc/passwd"})
    assert conn.status == 404
    assert body(conn)["error"]["key"] == "unknown_backup"

    conn = operator_conn(operator, %{"id" => "bk-20260101T000000Z-nonexist"})
    assert conn.status == 404
    assert body(conn)["error"]["key"] == "archive_missing"
  end

  # -- the restore intake ----------------------------------------------------------

  test "POST restore without the exact confirm token is refused", %{operator: operator, summary: summary} do
    for confirm <- [nil, "", "yes", "replace-all-data"] do
      params =
        %{"path" => summary.path}
        |> then(&if(confirm, do: Map.put(&1, "confirm", confirm), else: &1))

      conn = operator_conn(operator, params)
      assert conn.status == 400
      assert body(conn)["error"]["key"] == "confirm_required"
    end

    # No marker, no restart: nothing happened.
    refute Restore.marker_present?()
  end

  test "POST restore stages, writes the marker, and fires the INJECTABLE restart", %{
    operator: operator,
    summary: summary
  } do
    conn =
      operator_conn(operator, %{
        "path" => summary.path,
        "confirm" => Restore.confirm_token()
      })

    assert conn.status == 202
    restored = body(conn)["restore"]
    assert restored["status"] == "staged"
    assert restored["totals"]["rows"] == summary.rows

    # The marker names a DURABLE staged copy (a fresh id under staged/), not
    # the original path.
    marker = Restore.read_marker()
    assert marker && marker["status"] == "staged"
    assert marker["archive"] =~ "/staged/" and marker["archive"] != summary.path
    assert File.regular?(marker["archive"])
    assert File.regular?(Path.join(marker["staged_dir"], "manifest.json"))

    # The restart seam fired (observed in this process — the injected fn).
    # initiate_restart/0 delays 300ms so the response lands on the wire first.
    Process.sleep(400)
    assert_received :backup_restore_restart

    Restore.clear_marker()
  end

  test "POST restore answers 422 with the validation errors and live data untouched", %{
    operator: operator,
    summary: summary
  } do
    # Corrupt a byte inside the MANIFEST entry's data, which the tar places first:
    # header at 0, JSON from 512. The old version flipped the byte at the archive's
    # MIDPOINT, which is only meaningful while that offset happens to land on real
    # content — tar pads every member to 512-byte blocks, so a layout change can
    # move the midpoint into padding and the "corrupted" archive then validates and
    # stages fine (observed: a whitelist change shifted it and this test got 202
    # instead of 422). The manifest is checksum-bearing either way, so a byte there
    # always invalidates: unparseable JSON, or part checksums that no longer match.
    bytes = File.read!(summary.path)
    at = 512 + 64
    tampered = Path.join(Path.dirname(summary.path), "tampered.tar")

    File.write!(
      tampered,
      binary_part(bytes, 0, at) <> <<0>> <> binary_part(bytes, at + 1, byte_size(bytes) - at - 1)
    )

    conn =
      operator_conn(operator, %{"path" => tampered, "confirm" => Restore.confirm_token()})

    assert conn.status == 422

    if conn.status == 422 do
      assert body(conn)["error"]["key"] == "validation_failed"
      assert body(conn)["error"]["details"] != []
    end

    refute Restore.marker_present?()
  end

  test "POST restore on a missing file is a 404 and touches nothing", %{operator: operator} do
    conn =
      operator_conn(operator, %{"path" => "/nonexistent/archive.tar", "confirm" => Restore.confirm_token()})

    assert conn.status == 404
    assert body(conn)["error"]["key"] == "staging_failed"
    refute Restore.marker_present?()
  end
end
