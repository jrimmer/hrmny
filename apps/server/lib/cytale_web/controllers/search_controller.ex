defmodule CytaleWeb.SearchController do
  @moduledoc """
  U13 — search route handlers (workspace + DM segments). Fills the U9 route
  contract: parses the query, computes the member's visible channels via the
  U7 permission engine, and runs the search through the `Cytale.Search.Behaviour`
  seam. When the search implementation is unavailable (NIF down), answers 501
  with the stable `search_not_available` key so clients feature-detect.
  """

  use CytaleWeb, :controller

  alias Cytale.Search.{Query, TantivyImpl}
  alias CytaleWeb.Compat.GatewayDialect
  alias Cytale.Workspaces
  import CytaleWeb.API.Params, only: [snowflake: 1]
  import CytaleWeb.API.Error, only: [error: 4]

  @doc "GET /workspaces/:id/search?q=&from=&in=&after=&before="
  def workspace(conn, %{"workspace_id" => ws_id} = params) do
    %{user_id: user_id} = conn.assigns.current_user

    with {:ok, workspace_id} <- snowflake(ws_id),
         true <- Workspaces.get_workspace(workspace_id) != nil,
         true <- Workspaces.get_member(workspace_id, user_id) != nil do
      query = Query.parse(params["q"] || "")
      channels = Workspaces.list_channels(workspace_id)
      visible = visible_channels(workspace_id, conn.assigns.current_user, channels)
      members = Workspaces.list_members(workspace_id, limit: 100)

      filters = %{
        visible_channels: visible,
        members: members,
        channels: channels
      }

      results = TantivyImpl.query(workspace_id, query, filters)

      json(conn, %{
        "results" => Enum.map(results, &result_json/1),
        "next_before" => nil
      })
    else
      _ -> error(conn, 404, "workspace_not_found", "No workspace with that id")
    end
  end

  @doc "GET /users/@me/omnisearch?q="
  def omnisearch(conn, params) do
    q = String.trim(params["q"] || "")

    if byte_size(q) < 2 do
      json(conn, %{"results" => [], "total" => 0})
    else
      json(conn, %{"results" => omnisearch_results(conn.assigns.current_user, q), "total" => nil})
    end
  end

  # -- omnisearch (Cmd-K) -------------------------------------------------------

  # One query, two segments, both permission-honoring by construction:
  #
  #   * WORKSPACE messages — the member's own workspaces, each searched through
  #     the same visible_channels gate the per-workspace route uses (owner sees
  #     all; otherwise the U7 engine's VIEW_CHANNEL per channel). Hits come out
  #     of the Tantivy index scored; the index can lag a delete, so every hit is
  #     hydrated from the messages table and a miss DROPS the row (drift
  #     self-heals instead of rendering a dead link).
  #   * DIRECT messages — the caller's own PER-USER Tantivy index (one index
  #     per participant under priv/search/_dmu/), written at the message seam
  #     for both participants, so participation IS the authorization by
  #     partition. Brought current on first query (bounded idempotent
  #     backfill), then maintained by the write hook.
  #
  # Both segments return hydrated rows (content/author/created_at) because a
  # palette row that showed only ids would be unusable; the client groups by
  # `kind`, orders within a group by the order here, and builds permalinks from
  # `workspace_id` + ids.
  @omni_workspace_cap 30
  @omni_dm_cap 20

  defp omnisearch_results(claims, q) do
    workspace_hits = workspace_segment(claims, q)
    dm_hits = dm_segment(claims.user_id, q)

    workspace_hits
    |> Enum.take(@omni_workspace_cap)
    |> Enum.concat(Enum.take(dm_hits, @omni_dm_cap))
    |> Enum.map(&omni_row_json/1)
  end

  # Scored Tantivy hits across every workspace the member belongs to, hydrated
  # and de-drifted. An index that is down (NIF failure) reads as no hits for
  # that workspace rather than failing the whole palette — the DM segment still
  # answers.
  defp workspace_segment(claims, q) do
    claims.user_id
    |> Workspaces.workspaces_of_user()
    |> Enum.flat_map(fn ws ->
      workspace_id = ws.workspace_id
      query = Query.parse(q)
      # ONE channels read feeds both the visibility computation and the
      # Tantivy filters (it was listed twice per workspace).
      channels = Workspaces.list_channels(workspace_id)
      visible = visible_channels(workspace_id, claims, channels)

      members = Workspaces.list_members(workspace_id, limit: 100)

      filters = %{visible_channels: visible, members: members, channels: channels}

      hits =
        try do
          TantivyImpl.query(workspace_id, query, filters)
        rescue
          _ -> []
        end

      # Bounded hydration: ONE batch for the workspace's hits, not four reads
      # per hit (hardening plan 5.9).
      rows = Cytale.Messages.get_many(Enum.map(hits, &{&1.channel_id, &1.message_id}))

      Enum.map(hits, fn hit ->
        # A tombstoned author (account deleted: author_id NULL) drops the
        # row — it has no author to render, and rendering it 500'd the
        # whole palette on Integer.to_string(nil).
        with %{author_id: author_id, content: content, created_at: created_at} when is_integer(author_id) <-
               Map.get(rows, {hit.channel_id, hit.message_id}) do
          %{
            kind: :workspace,
            workspace_id: workspace_id,
            channel_id: hit.channel_id,
            message_id: hit.message_id,
            thread_id: hit.thread_id,
            author_id: author_id,
            content: content,
            created_at: created_at,
            score: hit.score
          }
        else
          _ -> nil
        end
      end)
      |> Enum.reject(&is_nil/1)
    end)
    |> Enum.sort_by(&{-&1.score, -&1.message_id})
  end

  # The caller's own DM index — permission is the partition (the index holds
  # only conversations the user participates in), brought current on first
  # use (a bounded, idempotent backfill over the watermark; see
  # TantivyImpl.ensure_dm_current) and queried with the CURRENT DM channel
  # ids as the visible set, so a stale row from an unresolvable conversation
  # cannot surface. Hydrated and recency-ordered.
  defp dm_segment(user_id, q) do
    {:ok, _indexed} = TantivyImpl.ensure_dm_current(user_id)

    dms = Workspaces.dms_of_user(user_id)
    channel_ids = Enum.map(dms, & &1.channel_id)

    TantivyImpl.query_dm(user_id, Query.parse(q), channel_ids)
    |> Enum.map(fn hit ->
      # Tombstoned author → dropped (see workspace_segment).
      with %{author_id: author_id, content: content, created_at: created_at} when is_integer(author_id) <-
             Cytale.Messages.get_message(hit.channel_id, hit.message_id) do
        %{
          kind: :dm,
          workspace_id: nil,
          channel_id: hit.channel_id,
          message_id: hit.message_id,
          thread_id: hit.thread_id,
          author_id: author_id,
          content: content,
          created_at: created_at,
          score: nil
        }
      else
        _ -> nil
      end
    end)
    |> Enum.reject(&is_nil/1)
    |> Enum.sort_by(&(-&1.message_id))
  end

  defp omni_row_json(row) do
    %{
      "kind" => Atom.to_string(row.kind),
      "message_id" => Integer.to_string(row.message_id),
      "channel_id" => Integer.to_string(row.channel_id),
      "thread_id" => row.thread_id && Integer.to_string(row.thread_id),
      "workspace_id" => row.workspace_id && Integer.to_string(row.workspace_id),
      "author_id" => Integer.to_string(row.author_id),
      "content" => String.slice(row.content || "", 0, 240),
      "created_at" => DateTime.to_iso8601(row.created_at),
      "score" => row.score
    }
  end

  @doc "GET /dm/search?q="
  def dm(conn, _params) do
    # DM search rides the DM index segment (U13); the per-user-pair writer is
    # fed by the same fan-out hook. Until the DM segment is wired end-to-end,
    # answer the stable 501 so clients feature-detect rather than guess.
    not_available(conn)
  end

  # -- permission-filtered visible channels -------------------------------------

  # Compute the member's visible channel ids: for each channel in the
  # workspace, evaluate the U7 permission engine (member roles + channel
  # overwrites) and keep channels where VIEW_CHANNEL is set. The workspace
  # owner sees everything.
  # The visible channel ids for `claims` in one workspace — the SHARED
  # computation (`GatewayDialect.visible_channel_ids/3`, hardening plan 5.9):
  # the member roles load once and the whole channel set's overwrites load in ONE
  # `IN ?` read. The local shape this replaces resolved the member's roles, then
  # read the channel's OVERWRITES once PER CHANNEL (a 50-channel workspace: 50
  # reads), and listed the channels twice over.
  defp visible_channels(workspace_id, claims, channels) do
    workspace_id
    |> GatewayDialect.visible_channel_ids(claims, channels)
    |> MapSet.to_list()
  end

  # -- helpers ------------------------------------------------------------------

  defp result_json(r) do
    %{
      "message_id" => Integer.to_string(r.message_id),
      "channel_id" => Integer.to_string(r.channel_id),
      "thread_id" => r.thread_id && Integer.to_string(r.thread_id),
      "score" => r.score
    }
  end

  defp not_available(conn) do
    conn
    |> put_status(501)
    |> json(%{
      "error" => %{
        "key" => "search_not_available",
        "code" => 50_101,
        "message" => "Search indexing is unavailable; the route contract is stable."
      }
    })
  end
end
