defmodule CytaleWeb.AdminController do
  @moduledoc """
  U9 — admin tier (`/api/v1/admin/...`), ADMINISTRATOR-class operator
  surface. Audit reads are bucket/index health today; the deletion-cascade
  status fills in with U14.
  """

  use CytaleWeb, :controller

  alias Cytale.Repo
  alias Cytale.Workspaces
  import CytaleWeb.API.Params, only: [snowflake: 1]
  import CytaleWeb.API.Error, only: [error: 4]

  @doc "GET /admin/workspaces/:id/audit — storage shape summary for the workspace."
  def audit(conn, %{"workspace_id" => ws_id}) do
    with {:ok, workspace_id} <- snowflake(ws_id),
         ws when not is_nil(ws) <- Workspaces.get_workspace(workspace_id) do
      channel_count =
        Workspaces.list_channels(workspace_id)
        |> length()

      member_count =
        Workspaces.list_members(workspace_id, limit: 100)
        |> length()

      tables =
        Repo.execute!(
          "SELECT table_name FROM system_schema.tables WHERE keyspace_name = ?",
          [{"text", Repo.keyspace()}]
        )
        |> Enum.to_list()
        |> Enum.map(& &1["table_name"])
        |> Enum.sort()

      json(conn, %{
        "workspace" => %{"id" => Integer.to_string(ws.workspace_id), "name" => ws.name},
        "channel_count" => channel_count,
        "member_count" => member_count,
        "keyspace_tables" => tables
      })
    else
      _ -> error(conn, 404, "workspace_not_found", "No workspace with that id")
    end
  end

  @doc "GET /admin/workspaces/:id/deletion-cascade/:user_id — U14 cascade status."
  def deletion_cascade(conn, %{"workspace_id" => ws_id, "user_id" => uid}) do
    with {:ok, _workspace_id} <- snowflake(ws_id),
         {:ok, user_id} <- snowflake(uid) do
      rows =
        Repo.execute!(
          "SELECT message_id FROM {{K}}.author_messages WHERE author_id = ?",
          [{"bigint", user_id}]
        )
        |> Enum.to_list()

      json(conn, %{
        "user_id" => Integer.to_string(user_id),
        "authored_messages" => length(rows),
        "cascade" => %{
          "status" => "ready",
          "note" => "Deletion sweep executes in U14; this is the locator count."
        }
      })
    else
      _ -> error(conn, 400, "validation_failed", "ids must be snowflake strings")
    end
  end

  @doc "GET /admin/invites — cross-workspace invite governance (seam: per-workspace index is U12-era; returns the documented empty shape)."
  def invites(conn, _params) do
    json(conn, %{"invites" => [], "note" => "per-workspace invite index lands with the U12-era schema additions"})
  end

  @doc "GET /admin/metrics — hot-path latency aggregates (pillars budget surface)."
  def metrics(conn, _params) do
    json(conn, Cytale.Telemetry.Stats.snapshot())
  end

  @doc "POST /admin/metrics/reset — clear the rings (soak phase isolation)."
  def reset_metrics(conn, _params) do
    :ok = Cytale.Telemetry.Stats.reset()
    json(conn, %{"ok" => true})
  end

  # -- Search index maintenance (#89) --------------------------------------------
  #
  # The admin tier's first MUTATING operation, and deliberately not a
  # fire-and-forget one: a rebuild walks every message in a workspace, so it is
  # accepted here (202 + job id) and run by `Cytale.Search.RebuildRunner`, one
  # job at a time in total.
  #
  # The drift check comes FIRST because it is the cheaper half and it produces
  # the ids: an operator who sees 3 orphaned ids repairs 3 documents instead of
  # re-indexing a workspace. `search_status` is that check.

  @doc """
  GET /admin/workspaces/:workspace_id/search/status

  The drift report for one workspace: documents in the index vs messages in
  the table (exact counts), plus bounded samples of the ids behind the
  difference — `missing` (rows the index lacks) and `orphaned` (documents whose
  row is gone) — the index watermark against the workspace's latest message,
  and the last rebuild job. `?sample=N` widens the id sample (1..5000).
  """
  def search_status(conn, %{"workspace_id" => ws_id} = params) do
    with {:ok, workspace_id} <- snowflake(ws_id),
         ws when not is_nil(ws) <- Workspaces.get_workspace(workspace_id) do
      report =
        Cytale.Search.drift(workspace_id, sample_limit: sample_param(params["sample"]))

      json(conn, %{
        "workspace" => %{"id" => Integer.to_string(ws.workspace_id), "name" => ws.name},
        "drift" => drift_json(report),
        "last_rebuild" => job_json(Cytale.Search.RebuildRunner.latest_for(workspace_id))
      })
    else
      _ -> error(conn, 404, "workspace_not_found", "No workspace with that id")
    end
  end

  @doc """
  POST /admin/workspaces/:workspace_id/search/repair

  Unindex the given ids (body: `{"ids": ["..."]}`), or — with no ids — the
  orphans the drift check finds right now. Answers with the repaired ids and a
  fresh drift report, so the caller sees whether the repair was enough; a
  repair never rebuilds.
  """
  def search_repair(conn, %{"workspace_id" => ws_id} = params) do
    with {:ok, workspace_id} <- snowflake(ws_id),
         ws when not is_nil(ws) <- Workspaces.get_workspace(workspace_id),
         {:ok, ids} <- repair_ids(workspace_id, params) do
      %{unindexed: unindexed, ids: repaired} =
        Cytale.Search.repair_orphans(workspace_id, ids)

      json(conn, %{
        "workspace" => %{"id" => Integer.to_string(ws.workspace_id), "name" => ws.name},
        "unindexed" => unindexed,
        "ids" => Enum.map(repaired, &Integer.to_string/1),
        # Verification is part of the answer: "did that fix it" should not need
        # a second request to find out.
        "after" => drift_json(Cytale.Search.drift(workspace_id))
      })
    else
      {:error, :invalid_ids} ->
        error(conn, 400, "validation_failed", "\"ids\" must be a list of snowflake strings")

      _ ->
        error(conn, 404, "workspace_not_found", "No workspace with that id")
    end
  end

  @doc """
  POST /admin/workspaces/:workspace_id/search/rebuild

  202 + the job id when accepted; 409 + the RUNNING job when one is already
  running (the runner is single-flight in total, not per workspace), because a
  second concurrent rebuild on this box buys nothing and costs the database's
  memory headroom. The walk itself runs off the request.
  """
  def search_rebuild(conn, %{"workspace_id" => ws_id}) do
    with {:ok, workspace_id} <- snowflake(ws_id),
         ws when not is_nil(ws) <- Workspaces.get_workspace(workspace_id) do
      case Cytale.Search.RebuildRunner.request(workspace_id) do
        {:ok, job} ->
          conn
          |> put_status(202)
          |> json(%{
            "job" => job_json(job),
            "workspace" => %{"id" => Integer.to_string(ws.workspace_id), "name" => ws.name},
            "note" =>
              "Re-indexing from the messages table runs in the background; " <>
                "watch GET /api/v1/admin/search/rebuilds for progress."
          })

        {:error, {:in_progress, running}} ->
          conn
          |> put_status(409)
          |> json(%{
            "error" => %{
              "key" => "rebuild_in_progress",
              "code" => 40_901,
              "message" => "A search index rebuild is already running.",
              "job" => job_json(running)
            }
          })

        {:error, reason} ->
          error(conn, 500, "rebuild_not_started", "Rebuild could not start: #{inspect(reason)}")
      end
    else
      _ -> error(conn, 404, "workspace_not_found", "No workspace with that id")
    end
  end

  @doc """
  GET /admin/search/rebuilds

  Every retained rebuild job, newest first — status, workspace, pages/messages
  processed so far, and start/finish timestamps — so an operator can watch a
  long rebuild instead of guessing whether it hung. `?workspace_id=` narrows it
  to one workspace.
  """
  def search_rebuilds(conn, params) do
    case params["workspace_id"] do
      nil ->
        json(conn, rebuilds_json(Cytale.Search.RebuildRunner.list()))

      ws_id ->
        with {:ok, workspace_id} <- snowflake(ws_id) do
          json(conn, rebuilds_json(Cytale.Search.RebuildRunner.list(workspace_id: workspace_id)))
        else
          _ -> error(conn, 400, "validation_failed", "workspace_id must be a snowflake string")
        end
    end
  end

  # -- #89 shaping ----------------------------------------------------------------

  defp rebuilds_json(jobs) do
    %{
      "rebuilds" => Enum.map(jobs, &job_json/1),
      "running" => jobs |> Enum.find(&(&1.status == :running)) |> job_json()
    }
  end

  defp job_json(nil), do: nil

  defp job_json(job) do
    %{
      "id" => job.id,
      "workspace_id" => Integer.to_string(job.workspace_id),
      "status" => to_string(job.status),
      "pages" => job.pages,
      "messages" => job.messages,
      "started_at" => iso(job.started_at),
      "finished_at" => iso(job.finished_at),
      "duration_ms" => job.duration_ms,
      "error" => job.error
    }
  end

  defp drift_json(report) do
    %{
      "clean" => report.clean,
      "checked_at" => iso(report.checked_at),
      "documents" => %{
        "index" => report.documents.index,
        "messages" => report.documents.messages,
        "delta" => report.documents.delta
      },
      "missing" => id_set_json(report.missing),
      "orphaned" => id_set_json(report.orphaned),
      "content" => %{
        "mismatched_ids" => Enum.map(report.content.mismatched_ids, &Integer.to_string/1),
        "mismatched_count" => report.content.mismatched_count,
        "checked" => report.content.checked,
        "sample_limit" => report.content.sample_limit,
        "truncated" => report.content.truncated
      },
      "index_state" => %{
        "watermark" => id_or_nil(report.index_state.watermark),
        "latest_message_id" => id_or_nil(report.index_state.latest_message_id)
      }
    }
  end

  defp id_set_json(set) do
    %{
      "ids" => Enum.map(set.ids, &Integer.to_string/1),
      "count" => set.count,
      "sampled" => set.sampled,
      "sample_limit" => set.sample_limit,
      "truncated" => set.truncated,
      "order" => to_string(set.order)
    }
  end

  defp id_or_nil(nil), do: nil
  defp id_or_nil(id) when is_integer(id), do: Integer.to_string(id)

  defp iso(nil), do: nil
  defp iso(%DateTime{} = dt), do: DateTime.to_iso8601(dt)

  defp sample_param(nil), do: nil

  defp sample_param(raw) do
    case Integer.parse(to_string(raw)) do
      {n, ""} when n > 0 -> n
      _ -> nil
    end
  end

  # With explicit ids: exactly those. Without: the orphans a fresh check just
  # found (the drift report's ids ARE the repair's input).
  defp repair_ids(_workspace_id, %{"ids" => ids}) when is_list(ids) do
    parsed =
      Enum.map(ids, fn id ->
        case Integer.parse(to_string(id)) do
          {n, ""} when n > 0 -> n
          _ -> :error
        end
      end)

    if Enum.any?(parsed, &(&1 == :error)) do
      {:error, :invalid_ids}
    else
      {:ok, parsed}
    end
  end

  defp repair_ids(workspace_id, _params) do
    {:ok, Cytale.Search.drift(workspace_id).orphaned.ids}
  end
end
