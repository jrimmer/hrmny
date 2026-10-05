defmodule CytaleWeb.ServerConfigController do
  @moduledoc """
  #121 — the operator's Server Settings surface (`/api/v1/admin/config` +
  `/api/v1/admin/restart`), behind the same OPERATOR gate as the rest of the
  admin tier (`CytaleWeb.Plugs.RequireOperator`, fail-closed).

    * `GET  /admin/config` — the current EDITABLE document plus per-key
      metadata (type, scope, description) so the editor renders help text.
      NEVER contains a secret: secrets live in secrets.json, which this
      surface does not know how to serve.
    * `PUT  /admin/config` — validate against
      `Cytale.ServerConfig.Schema` → atomic write (temp → fsync → rename,
      `config.last-good.json` refreshed) → hot-apply the changed
      RUNTIME-scoped keys. Answers `{ok, changed, restart_required}` —
      `restart_required` is true when any BOOT-scoped key changed.
    * `POST /admin/restart` — graceful `System.stop(0)` (the compose policy
      or dev watchdog brings the node back). The response is SENT first; the
      stop runs off-process after a short delay, so the operator's client
      always gets its answer before the node goes down.
  """

  use CytaleWeb, :controller
  import CytaleWeb.API.Error, only: [error: 4]

  @doc "GET /admin/config — the editable document + schema metadata."
  def show(conn, _params) do
    json(conn, %{
      "config" => Cytale.ServerConfig.effective_document(),
      "metadata" => Cytale.ServerConfig.metadata()
    })
  end

  @doc "PUT /admin/config — body IS the (partial) editor document."
  def update(conn, params) do
    case Cytale.ServerConfig.save(params) do
      {:ok, %{changed: changed, restart_required: restart_required?}} ->
        json(conn, %{
          "ok" => true,
          "changed" => changed,
          "restart_required" => restart_required?
        })

      {:error, {:io, reason}} ->
        error(conn, 500, "config_write_failed", "The config file could not be written: #{inspect(reason)}")

      {:error, errors} when is_list(errors) ->
        conn
        |> put_status(400)
        |> json(%{
          "error" => %{
            "key" => "validation_failed",
            "code" => 400_001,
            "message" => Enum.map_join(errors, "; ", fn {path, message} -> "#{path}: #{message}" end),
            "details" => Enum.map(errors, fn {path, message} -> %{"path" => path, "message" => message} end)
          }
        })

      {:error, other} ->
        error(conn, 400, "validation_failed", "Invalid document: #{inspect(other)}")
    end
  end

  @doc "POST /admin/restart — respond, THEN stop (graceful; the policy restarts us)."
  def restart(conn, _params) do
    :ok = Cytale.ServerConfig.initiate_restart()

    json(conn, %{
      "ok" => true,
      "message" =>
        "Restarting. Poll /health until it answers, then reload — boot-scoped config " <>
          "changes take effect on the new boot."
    })
  end
end
