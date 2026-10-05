defmodule Cytale.Search.StaleTextTest do
  @moduledoc """
  Tier 3 #3 — search must not keep text its author removed:

    * (a) an EDIT re-indexes: the workspace fan-out's `MessageUpdate` upserts
      the document, and a DM edit re-indexes both participants' DM indexes
      on the write seam — the old words stop matching, the new ones match;
    * (b) account deletion's DM leg (`Search.delete_by_author_dm/1`, a no-op
      stub before) removes the author's documents from every counterpart's
      DM index and drops the author's own DM index;
    * (c) omnisearch drops a hit whose author is tombstoned instead of 500ing
      on `Integer.to_string(nil)`.
  """

  use Cytale.ScyllaCase, async: false

  import Phoenix.ConnTest
  import Plug.Conn

  alias Cytale.Accounts.{Auth, User}
  alias Cytale.Search.{IndexWriter, Partition, Query, TantivyImpl}

  @endpoint CytaleWeb.Endpoint

  defp run_unique(base), do: base <> "st" <> Cytale.TestNonce.get()

  setup do
    tmp = Path.join(System.tmp_dir!(), "cytale_stale_search_#{System.unique_integer([:positive])}")
    original = Application.get_env(:cytale, Cytale.Config)
    Application.put_env(:cytale, Cytale.Config, Keyword.put(original || [], :search_index_root, tmp))

    # on_exit runs in ANOTHER process, so the started writers are recorded in
    # an unlinked Agent (a process dictionary would read back empty there and
    # leave the writers alive over a deleted directory).
    {:ok, keys} = Agent.start(fn -> [] end)
    Process.put(:index_keys_agent, keys)

    on_exit(fn ->
      for key <- Agent.get(keys, & &1) do
        case IndexWriter.whereis(key) do
          nil -> :ok
          pid -> DynamicSupervisor.terminate_child(Cytale.Search.IndexWriterSupervisor, pid)
        end
      end

      if original == nil,
        do: Application.delete_env(:cytale, Cytale.Config),
        else: Application.put_env(:cytale, Cytale.Config, original)

      Agent.stop(keys)
      # Tolerant: a stopped writer's native merge can still touch the dir.
      Cytale.Search.TestWriters.rm_rf(tmp)
    end)

    {conn, me} = user_conn("st_me")
    {:ok, conn: conn, me: me}
  end

  defp track(key), do: Agent.update(Process.get(:index_keys_agent), &[key | &1])

  defp user_conn(base) do
    {:ok, user} = User.create(run_unique(base), run_unique(base) <> "@example.com", "password-123")

    conn =
      Phoenix.ConnTest.build_conn()
      |> put_req_header("accept", "application/json")
      |> put_req_header("content-type", "application/json")
      |> put_req_header("authorization", "Bearer " <> Auth.issue_access_token(user.user_id, user.username, true))

    track({:dm_user, user.user_id})
    {conn, user}
  end

  defp send_message(conn, ch_id, content) do
    r = post(conn, "/api/v1/channels/#{ch_id}/messages", %{"content" => content})
    assert r.status == 201, "message create failed: #{r.resp_body}"
    Jason.decode!(r.resp_body)["message"]
  end

  # A new DM needs a shared workspace (Tier 3 B, 9a).
  defp open_dm(conn, me, other) do
    Cytale.Test.SharedWorkspace.share!(me.user_id, other.user_id)
    r = post(conn, "/api/v1/users/#{other.user_id}/channels", %{})
    assert r.status == 201
    Jason.decode!(r.resp_body)["channel"]["id"]
  end

  defp omni_ids(conn, q) do
    r = get(conn, "/api/v1/users/@me/omnisearch", q: q)
    assert r.status == 200, "omnisearch failed: #{r.status} #{r.resp_body}"
    Jason.decode!(r.resp_body)["results"] |> Enum.map(& &1["message_id"])
  end

  defp dm_hit_ids(user_id, channel_id, term) do
    TantivyImpl.query_dm(user_id, Query.parse(term), [String.to_integer(channel_id)])
    |> Enum.map(&Integer.to_string(&1.message_id))
  end

  defp workspace_with_channel(conn) do
    ws = post(conn, "/api/v1/workspaces", %{"name" => run_unique("St WS")})
    assert ws.status == 201
    ws_id = Jason.decode!(ws.resp_body)["workspace"]["id"]
    ch = post(conn, "/api/v1/workspaces/#{ws_id}/channels", %{"name" => "general"})
    assert ch.status == 201
    track({:workspace, String.to_integer(ws_id)})
    {String.to_integer(ws_id), Jason.decode!(ch.resp_body)["channel"]["id"]}
  end

  defp index_workspace_message(ws_id, message) do
    :ok =
      TantivyImpl.index(ws_id, %{
        id: String.to_integer(message["id"]),
        channel_id: String.to_integer(message["channel_id"]),
        author_id: String.to_integer(message["author_id"]),
        content: message["content"],
        thread_id: nil,
        created_at: DateTime.utc_now() |> DateTime.truncate(:millisecond)
      })

    :ok = IndexWriter.commit_now({:workspace, ws_id})
  end

  # Poll the index until `fun` holds (the fan-out → writer legs are casts).
  defp eventually(fun, tries \\ 50) do
    cond do
      fun.() ->
        :ok

      tries == 0 ->
        flunk("condition never held")

      true ->
        Process.sleep(50)
        eventually(fun, tries - 1)
    end
  end

  describe "(a) edits re-index" do
    test "workspace: the fan-out's MessageUpdate replaces the indexed text", %{conn: conn} do
      {ws_id, ch_id} = workspace_with_channel(conn)
      old = run_unique("oldword")
      new = run_unique("newword")

      msg = send_message(conn, ch_id, "draft says #{old}")
      index_workspace_message(ws_id, msg)
      assert msg["id"] in omni_ids(conn, old)

      edited = patch(conn, "/api/v1/channels/#{ch_id}/messages/#{msg["id"]}", %{"content" => "final says #{new}"})
      assert edited.status == 200, "edit failed: #{edited.resp_body}"
      updated = Jason.decode!(edited.resp_body)["message"] || Jason.decode!(edited.resp_body)

      # The :test publish impl is the logger; drive the production fan-out leg
      # the way Publish.WorkspaceProcess does.
      :ok = Cytale.Workspaces.Workspace.fan_out(ws_id, {"MessageUpdate", updated})

      eventually(fn ->
        :ok = IndexWriter.commit_now({:workspace, ws_id})
        msg["id"] in omni_ids(conn, new)
      end)

      refute msg["id"] in omni_ids(conn, old)
    end

    test "DM: an edit re-indexes both participants' DM indexes", %{conn: conn, me: me} do
      {_peer_conn, peer} = user_conn("st_peer")
      dm_id = open_dm(conn, me, peer)
      old = run_unique("olddm")
      new = run_unique("newdm")

      msg = send_message(conn, dm_id, "dm draft #{old}")
      :ok = IndexWriter.commit_now({:dm_user, me.user_id})
      :ok = IndexWriter.commit_now({:dm_user, peer.user_id})
      assert msg["id"] in dm_hit_ids(me.user_id, dm_id, old)
      assert msg["id"] in dm_hit_ids(peer.user_id, dm_id, old)

      edited = patch(conn, "/api/v1/channels/#{dm_id}/messages/#{msg["id"]}", %{"content" => "dm final #{new}"})
      assert edited.status == 200, "edit failed: #{edited.resp_body}"

      for user_id <- [me.user_id, peer.user_id] do
        :ok = IndexWriter.commit_now({:dm_user, user_id})
        refute msg["id"] in dm_hit_ids(user_id, dm_id, old)
        assert msg["id"] in dm_hit_ids(user_id, dm_id, new)
      end
    end
  end

  describe "(b) account deletion's DM leg" do
    test "delete_by_author_dm unindexes the author from counterparts and drops the author's own index", %{
      conn: conn,
      me: me
    } do
      {peer_conn, peer} = user_conn("st_gone")
      dm_id = open_dm(conn, me, peer)
      theirs = run_unique("theirs")
      mine = run_unique("mine")

      their_msg = send_message(peer_conn, dm_id, "peer wrote #{theirs}")
      my_msg = send_message(conn, dm_id, "i wrote #{mine}")
      :ok = IndexWriter.commit_now({:dm_user, me.user_id})
      :ok = IndexWriter.commit_now({:dm_user, peer.user_id})
      assert their_msg["id"] in dm_hit_ids(me.user_id, dm_id, theirs)

      # A counterpart whose writer is NOT running still gets cleaned (the
      # index on disk is what the next search opens).
      :ok =
        DynamicSupervisor.terminate_child(
          Cytale.Search.IndexWriterSupervisor,
          IndexWriter.whereis({:dm_user, me.user_id})
        )

      :ok = Cytale.Search.delete_by_author_dm(peer.user_id)

      refute their_msg["id"] in dm_hit_ids(me.user_id, dm_id, theirs)
      # The survivor's own messages stay searchable.
      assert my_msg["id"] in dm_hit_ids(me.user_id, dm_id, mine)

      # The deleted author's own DM index is gone from disk and memory.
      assert IndexWriter.whereis({:dm_user, peer.user_id}) == nil
      refute File.exists?(Partition.dir_for({:dm_user, peer.user_id}))
    end
  end

  describe "(c) omnisearch and tombstoned authors" do
    test "a hit whose author was tombstoned is dropped, not a 500", %{conn: conn} do
      {ws_id, ch_id} = workspace_with_channel(conn)
      marker = run_unique("orphaned")

      msg = send_message(conn, ch_id, "left behind #{marker}")
      index_workspace_message(ws_id, msg)
      assert msg["id"] in omni_ids(conn, marker)

      # The deletion cascade's tombstone: author_id NULL on the row.
      message_id = String.to_integer(msg["id"])
      channel_id = String.to_integer(ch_id)
      bucket = Cytale.Messages.bucket_for(Cytale.Snowflake.timestamp_ms(message_id))

      Cytale.Repo.execute!(
        "UPDATE {{K}}.messages SET author_id = NULL WHERE channel_id = ? AND bucket = ? AND message_id = ?",
        [{"bigint", channel_id}, {"int", bucket}, {"bigint", message_id}]
      )

      refute msg["id"] in omni_ids(conn, marker)
    end
  end
end
