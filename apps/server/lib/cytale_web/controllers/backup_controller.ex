defmodule CytaleWeb.BackupController do
  @moduledoc """
  The server backup surface (#120), on the OPERATOR tier like the rest of
  `/api/v1/admin` — an archive contains live credentials (owner decision
  2026-09-14), so even the LIST is a privileged read.

    * `GET  /admin/backups` — the finished archives (id, when, size, table/row
      totals, which secrets ride in them). Served from the listing sidecars,
      which carry NO secret values by construction.
    * `GET  /admin/backups/:id/download` — the archive streamed from disk.
      0600 on the backups volume; operator-gated here; still handle with care.
    * `POST /admin/backups/restore` — the DESTRUCTIVE intake. v1 takes a
      staged-path form (`{"path": ..., "confirm": "..."}` — an archive already
      on the host; an in-request upload would buffer a restore-sized body in
      the VM). Exhaustive validation + staging happen first; live data is
      never touched. On success the response answers and THEN
      `Cytale.ServerConfig.initiate_restart/0` stops the node into RESTORE
      MODE — the next boot applies the staged archive before serving.
  """

  use CytaleWeb, :controller

  alias Cytale.Backups.{Archive, Restore}
  import CytaleWeb.API.Error, only: [error: 4]

  @doc "GET /admin/backups — the archive list, newest first."
  def index(conn, _params) do
    json(conn, %{"backups" => Archive.list()})
  end

  @doc "GET /admin/backups/:id/download — stream the archive from disk."
  def download(conn, %{"id" => id}) do
    if Archive.valid_id?(id) do
      path = Path.join(Archive.resolve_dir(nil), "#{id}.tar")

      if File.regular?(path) do
        conn
        |> put_resp_content_type("application/x-tar", nil)
        |> put_resp_header("content-disposition", ~s(attachment; filename="cytale-backup-#{id}.tar"))
        |> send_file(200, path)
      else
        error(conn, 404, "archive_missing", "No archive file for that id on this node")
      end
    else
      # Not a backup-id shape = not a name this surface ever wrote; the same
      # 404 keeps it a non-oracle.
      error(conn, 404, "unknown_backup", "No backup with that id")
    end
  end

  def download(conn, _params), do: error(conn, 404, "unknown_backup", "No backup with that id")

  @doc """
  POST /admin/backups/restore — body `{"path": "<archive on the host>",
  "confirm": "<Restore.confirm_token()>"}`.

  202 + the marker summary when staged clean (the node restarts into restore
  mode moments after the response is on the wire); 400 for a missing confirm
  token; 404/413 for a bad/oversized path; 422 carrying every validation
  error — with live data UNTOUCHED in every refusal case.
  """
  def restore(conn, %{"path" => path, "confirm" => confirm} = _params) when is_binary(path) do
    if Plug.Crypto.secure_compare(confirm, Restore.confirm_token()) do
      case Restore.stage(path) do
        {:ok, marker} ->
          :ok = Cytale.ServerConfig.initiate_restart()

          conn
          |> put_status(202)
          |> json(%{
            "ok" => true,
            "restore" => %{
              "status" => marker["status"],
              "archive" => marker["archive"],
              "totals" => marker["totals"],
              "message" =>
                "Staged and validated. The node is restarting into RESTORE MODE: the archive " <>
                  "applies BEFORE the endpoint serves. Poll /health until it answers."
            }
          })

        {:error, {:staging, errors}} ->
          errors(conn, 404, "staging_failed", errors)

        {:error, {:validation, errors}} ->
          errors(conn, 422, "validation_failed", errors)
      end
    else
      error(
        conn,
        400,
        "confirm_required",
        "This endpoint replaces ALL live data on restart. Retry with \"confirm\": " <>
          "\"#{Restore.confirm_token()}\" to proceed."
      )
    end
  end

  def restore(conn, _params) do
    error(
      conn,
      400,
      "confirm_required",
      "Expected {\"path\": \"<archive on the host>\", \"confirm\": \"#{Restore.confirm_token()}\"}. " <>
        "This endpoint replaces ALL live data on restart."
    )
  end

  # -- shaping ----------------------------------------------------------------

  defp errors(conn, status, key, check_errors) do
    details = Enum.map(check_errors, fn e -> %{"check" => e.check, "message" => e.message} end)

    conn
    |> put_status(status)
    |> json(%{
      "error" => %{
        "key" => key,
        "code" => status * 100 + 1,
        "message" =>
          "Restore refused — live data is untouched. " <>
            Enum.map_join(check_errors, "; ", fn e -> "[#{e.check}] #{e.message}" end),
        "details" => details
      }
    })
  end
end
