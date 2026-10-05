defmodule Cytale.Accounts.DeletionTest do
  @moduledoc """
  U14 slice 1 — account-deletion cascade core (no Tantivy): soft-delete
  tombstone, message tombstoning via the author-locator sweep (no blind
  scans), membership + DM-access removal, ACCOUNT_DELETE emission, and the
  30-day hard-delete stub. The cascade is async and non-blocking.
  """

  use Cytale.ScyllaCase, async: false

  import ExUnit.CaptureLog
  import Phoenix.ConnTest
  import Plug.Conn

  alias Cytale.Accounts.{Auth, Deletion, User}
  alias Cytale.Messages
  alias Cytale.Messages.AuthorLocator
  alias Cytale.Search.{IndexWriter, TantivyImpl}
  alias Cytale.Workspaces

  @endpoint CytaleWeb.Endpoint

  defp run_nonce, do: "r" <> Cytale.TestNonce.get()
  defp run_unique(base), do: base <> run_nonce()

  # A user + a workspace they own + a channel + one authored message.
  # Returns %{user, workspace_id, channel_id, message_id}.
  defp seed_author do
    {:ok, user} = User.create(run_unique("del_author"), run_unique("del_author@example.com"), "password-123")
    {:ok, ws} = Workspaces.create_workspace(user.user_id, run_unique("Del WS"))
    {:ok, ch} = Workspaces.create_channel(ws.workspace_id, run_unique("del-ch"))

    {:ok, wire} =
      Messages.Message.send_message(%{
        channel_id: ch.channel_id,
        author_id: user.user_id,
        content: "to be deleted",
        thread_id: nil
      })

    %{
      user: user,
      workspace_id: ws.workspace_id,
      channel_id: ch.channel_id,
      message_id: String.to_integer(wire["id"])
    }
  end

  test "cascade: soft-delete → tombstone via locator sweep → memberships/DMs removed → ACCOUNT_DELETE emitted" do
    %{user: user, workspace_id: ws_id, channel_id: ch_id, message_id: mid} = seed_author()

    # A second member in the same workspace (their messages must survive).
    {:ok, partner} = User.create(run_unique("del_partner"), run_unique("del_partner@example.com"), "password-123")
    :ok = Workspaces.add_member(ws_id, partner.user_id, user.user_id, [])

    {:ok, _pw} =
      Messages.Message.send_message(%{
        channel_id: ch_id,
        author_id: partner.user_id,
        content: "partner message survives",
        thread_id: nil
      })

    # Locator has exactly one partition for the author.
    assert AuthorLocator.list_partitions(user.user_id) == [
             {ch_id, Messages.bucket_for(System.system_time(:millisecond))}
           ]

    # Run the cascade synchronously (sync: true runs the supervised sweep body
    # in the caller — deterministic under suite load; the async production
    # path is covered by the supervision tests below).
    log =
      capture_log(fn ->
        :ok = Deletion.delete_account(user.user_id, sync: true)
      end)

    # 1. Soft-delete tombstone set.
    assert %{deleted_at: %DateTime{}} = User.get(user.user_id)

    # 2. Author's message tombstoned; partner's message intact.
    history = Messages.history(ch_id, limit: 10)
    author_msg = Enum.find(history, &(&1.id == mid))
    assert author_msg.content == Deletion.tombstone_content()
    assert author_msg.author_id == nil

    partner_msg = Enum.find(history, &(&1.content == "partner message survives"))
    assert partner_msg.author_id == partner.user_id

    # 3. Membership removed.
    assert Workspaces.get_member(ws_id, user.user_id) == nil
    assert Workspaces.workspaces_of_user(user.user_id) == []

    # 4. ACCOUNT_DELETE emitted through the Publish seam.
    assert log =~ "ACCOUNT_DELETE"
    assert log =~ Integer.to_string(user.user_id)
  end

  test "DM partner's messages remain after the deleting user's DM access is removed" do
    %{user: user} = seed_author()
    {:ok, partner} = User.create(run_unique("dm_partner"), run_unique("dm_partner@example.com"), "password-123")

    {:ok, dm} = Workspaces.open_dm(user.user_id, partner.user_id)

    {:ok, _pw} =
      Messages.Message.send_message(%{
        channel_id: dm.channel_id,
        author_id: partner.user_id,
        content: "dm from partner",
        thread_id: nil
      })

    :ok = Deletion.run_sweep(user.user_id)

    # The DM row now lists only the partner (deleting user's access removed).
    # dms_of_user/1 is a documented U9 seam that returns [] (no user→dm
    # index); read the dm_channels row directly to observe the rewrite.
    dm_rows =
      Cytale.Repo.execute!(
        "SELECT channel_id, user_ids FROM #{Cytale.Repo.keyspace()}.dm_channels WHERE channel_id = ?",
        [{"bigint", dm.channel_id}]
      )
      |> Enum.to_list()

    assert [%{"user_ids" => remaining}] = dm_rows
    assert user.user_id not in remaining
    assert partner.user_id in remaining

    # The partner's DM message survives.
    history = Messages.history(dm.channel_id, limit: 10)
    assert Enum.any?(history, &(&1.content == "dm from partner"))
  end

  # The cascade removes everything that points at a member. A preference row
  # left behind is a row the notification decision still reads, so the deleting
  # member's layers must go even though nothing user-visible renders them.
  test "cascade removes the deleting member's notification preferences and subscriptions" do
    %{user: user, channel_id: ch_id} = seed_author()

    user_id = user.user_id
    :ok = Cytale.Notifications.Preferences.set_level(user_id, :account, 0, "mentions")
    :ok = Cytale.Notifications.Preferences.set_level(user_id, :channel, ch_id, "mute")
    assert map_size(Cytale.Notifications.Preferences.all(user_id)) == 2

    :ok =
      Cytale.Workspaces.put_push_subscription(
        user_id,
        "https://push.example.com/deletion-test",
        Jason.encode!(%{"p256dh" => "p", "auth" => "a"})
      )

    assert length(Cytale.Notifications.Subscriptions.list_for_user(user_id)) == 1

    :ok = Cytale.Notifications.Participations.record(user_id, ch_id)

    :ok = Deletion.run_sweep(user_id)

    assert Cytale.Notifications.Preferences.all(user_id) == %{}

    assert Cytale.Notifications.Subscriptions.list_for_user(user_id) == [],
           "a deleted account must not keep pushing to its former devices"

    assert Cytale.Notifications.Participations.channels_for_user(user_id) == [],
           "a deleted account's participation index must go with it"
  end

  test "cascade removes the deleting member's marks (#54) — and only theirs; the sweep then fires nothing" do
    %{user: user, workspace_id: ws_id, channel_id: ch_id, message_id: msg_id} = seed_author()
    {:ok, peer} = User.create(run_unique("del_peer"), run_unique("del_peer@example.com"), "password-123")
    :ok = Workspaces.add_member(ws_id, peer.user_id, user.user_id)

    target = %{id: msg_id, channel_id: ch_id, thread_id: nil}
    now = System.system_time(:millisecond)
    due = now + 60_000
    {:ok, _} = Cytale.Marks.set(user.user_id, "snooze", target, due, now)
    {:ok, _} = Cytale.Marks.set(peer.user_id, "snooze", target, due, now)

    :ok = Deletion.run_sweep(user.user_id)

    assert Cytale.Marks.get(user.user_id, "snooze", msg_id) == nil
    assert Cytale.Marks.list_pending(user.user_id) == []
    assert %{state: "pending"} = Cytale.Marks.get(peer.user_id, "snooze", msg_id)

    # The deleted account's index row is left to its TTL; the fence finds no
    # authoritative row behind it, so nothing fires for them.
    assert %{fired: 0} =
             Cytale.Marks.Sweeper.sweep(due + 1_000, scope: &(&1.user_id == user.user_id))
  end

  # -- the account's OWN sessions and credentials (#62) --------------------------
  #
  # The cascade is thorough about SUB-credentials (bots plan U4) and used to be
  # silent about the user's own: the tombstone landed while the principal kept a
  # live gateway socket AND a refresh token that kept rotating. Both halves are
  # pinned at the deletion seam here; the wire-level behaviour lives in
  # CytaleWeb.GatewayPrincipalTeardownTest.

  test "the tombstone tears down the account's OWN live gateway session (4004, record purged)" do
    %{user: user} = seed_author()

    session_id = "own-session-" <> Cytale.TestNonce.get()

    {:ok, _} =
      Cytale.Gateway.SessionStore.put(%Cytale.Gateway.Session{
        session_id: session_id,
        user: %{id: Integer.to_string(user.user_id), username: user.username}
      })

    parent = self()

    # A stand-in for the live socket: it registers itself as the principal's
    # live session exactly as the gateway socket does at Identify (the store
    # indexes the CALLING process), then waits for the teardown message the
    # real socket's handle_info/2 acts on.
    holder =
      spawn_link(fn ->
        :ok = Cytale.Gateway.SessionStore.track_principal(user.user_id, session_id)
        send(parent, :tracked)

        receive do
          {:cytale_principal_close, code} -> send(parent, {:own_session_closed, code})
        end
      end)

    assert_receive :tracked, 5_000
    assert [{^holder, ^session_id}] = Cytale.Gateway.SessionStore.principal_sessions(user.user_id)

    :ok = Deletion.delete_account(user.user_id, sync: true)

    # The account's own session is closed with the DOCUMENTED dead-credential
    # code — 4004, not an arbitrary 1000 — and its stored record is purged in
    # the same step, so Resume cannot resurrect it.
    assert_receive {:own_session_closed, 4004}, 5_000
    assert Cytale.Gateway.SessionStore.get(session_id) == nil
  end

  test "the tombstone is idempotent: deleting an account with no sessions does not raise" do
    %{user: user} = seed_author()

    assert :ok = Deletion.delete_account(user.user_id, sync: true)
    assert :ok = Deletion.delete_account(user.user_id, sync: true)
    assert %{deleted_at: %DateTime{}} = User.get(user.user_id)
  end

  test "the sweep revokes the account's OWN credential: a held refresh token stops rotating (#62)" do
    %{user: user} = seed_author()
    access = Auth.issue_access_token(user.user_id, user.username, true)

    # Control: this credential rotates through the PUBLIC surface today — what
    # makes the 401 below a revocation rather than a blanket refusal.
    {:ok, raw, _hash, _exp} = Auth.issue_refresh_token(user.user_id)
    assert refresh_request(raw, access).status == 200

    # A credential held across the deletion (what the account's browser has).
    {:ok, raw2, _hash2, _exp2} = Auth.issue_refresh_token(user.user_id)
    assert Auth.refresh_token_valid?(user.user_id, raw2)

    :ok = Deletion.delete_account(user.user_id, sync: true)

    # The stored hash is gone, so the token cannot rotate ...
    refute Auth.refresh_token_valid?(user.user_id, raw2)
    assert Auth.rotate_refresh_token(user.user_id, raw2) == {:error, :revoked}

    # ... and the same call on the wire is a 401, not a freshly minted pair:
    # a tombstoned account must not keep minting access tokens.
    denied = refresh_request(raw2, access)
    assert denied.status == 401
    assert %{"error" => %{"key" => "refresh_revoked"}} = Jason.decode!(denied.resp_body)
  end

  # POST /api/v1/auth/refresh as the account's own client presents it: the
  # refresh token plus an (expiry-ignored) access token.
  defp refresh_request(raw, access) do
    Phoenix.ConnTest.build_conn()
    |> put_req_header("accept", "application/json")
    |> put_req_header("content-type", "application/json")
    |> put_req_header("authorization", "Bearer " <> access)
    |> post("/api/v1/auth/refresh", %{"refresh_token" => raw})
  end

  test "cascade is async and non-blocking (delete_account returns :ok immediately)" do
    %{user: user} = seed_author()

    # delete_account marks deleted synchronously then spawns the sweep; it
    # returns :ok without waiting for the sweep to finish.
    {elapsed_us, :ok} = :timer.tc(fn -> Deletion.delete_account(user.user_id) end)

    # The call itself is fast (no sweep work in the caller).
    assert elapsed_us < 1_000_000
    assert %{deleted_at: %DateTime{}} = User.get(user.user_id)
  end

  test "a sweep that finishes clears its pending record (review #24)" do
    %{user: user} = seed_author()

    capture_log(fn -> :ok = Deletion.delete_account(user.user_id, sync: true) end)

    refute user.user_id in Deletion.pending()
  end

  test "a sweep interrupted before it finished is resumed from its pending record (review #24)" do
    %{user: user, channel_id: ch_id, message_id: mid} = seed_author()

    # The state a crash mid-sweep leaves: the account tombstoned, the pending
    # record written, the messages NOT yet swept.
    :ok = User.soft_delete!(user.user_id)

    Cytale.Repo.execute!(
      "INSERT INTO #{Cytale.Repo.keyspace()}.pending_account_sweeps (user_id, requested_at) VALUES (?, ?)",
      [{"bigint", user.user_id}, {"timestamp", DateTime.utc_now() |> DateTime.truncate(:millisecond)}]
    )

    assert %{content: "to be deleted"} = Messages.get_message(ch_id, mid)

    capture_log(fn -> assert Deletion.resume_pending() >= 1 end)

    assert Enum.any?(1..100, fn _ ->
             Process.sleep(50)

             user.user_id not in Deletion.pending() and
               match?(%{content: "[message deleted]"}, Messages.get_message(ch_id, mid))
           end),
           "the resumed sweep never ran to completion"
  end

  test "30-day hard-delete stub is a documented no-op (contract present)" do
    %{user: user} = seed_author()
    assert :ok = Deletion.hard_delete_after_grace(user.user_id)
  end

  # -- U14 slice 2: Tantivy deletion wiring -------------------------------------

  test "cascade removes the author's messages from the search index (workspace + DM segment)" do
    %{user: user, workspace_id: ws_id, channel_id: ch_id, message_id: mid} = seed_author()

    # Index the author's message into the workspace search index (the fan-out
    # hook would do this in production; here we drive the seam directly).
    :ok =
      TantivyImpl.index(ws_id, %{
        id: mid,
        channel_id: ch_id,
        author_id: user.user_id,
        content: "to be deleted",
        thread_id: nil,
        created_at: DateTime.utc_now()
      })

    :ok = IndexWriter.commit_now({:workspace, ws_id})

    # Confirm the message is searchable before deletion.
    q = Cytale.Search.Query.parse("deleted")
    assert [%{message_id: ^mid}] = TantivyImpl.query(ws_id, q, %{visible_channels: [ch_id], members: [], channels: []})

    # Run the cascade (synchronous sweep body for determinism).
    :ok = Deletion.run_sweep(user.user_id)

    # The message is no longer in the search index.
    assert TantivyImpl.query(ws_id, q, %{visible_channels: [ch_id], members: [], channels: []}) == []
  end

  test "Tantivy delete_by_author failure does not abort the cascade (best-effort, documented lag)" do
    %{user: user, workspace_id: ws_id, channel_id: ch_id, message_id: mid} = seed_author()

    # Point the search seam at a broken impl whose delete_by_author raises.
    # The cascade must still tombstone the message (best-effort search step).
    original = Application.get_env(:cytale, Cytale.Search)
    Application.put_env(:cytale, Cytale.Search, BrokenSearchImpl)

    try do
      :ok = Deletion.run_sweep(user.user_id)
    after
      if original == nil do
        Application.delete_env(:cytale, Cytale.Search)
      else
        Application.put_env(:cytale, Cytale.Search, original)
      end
    end

    # Tombstoning succeeded regardless of the search step.
    history = Messages.history(ch_id, limit: 10)
    author_msg = Enum.find(history, &(&1.id == mid))
    assert author_msg.content == Deletion.tombstone_content()
    assert author_msg.author_id == nil

    # Membership removal also completed (cascade did not abort).
    assert Workspaces.get_member(ws_id, user.user_id) == nil
  end

  # -- A6: the sweep runs SUPERVISED; a mid-sweep failure is logged + counted,

  test "the sweep runs under the Task.Supervisor; a failing step is logged and counted, never silent" do
    %{user: user, workspace_id: ws_id, channel_id: ch_id, message_id: mid} = seed_author()

    # Supervision shape: the sweeper is a named app-tree Task.Supervisor.
    assert Process.whereis(Deletion.sweep_supervisor()) |> is_pid()

    # Inject a failing step: the Publish seam raises at the ACCOUNT_DELETE
    # emission (step 5) — everything before it must still have completed.
    original = Application.get_env(:cytale, Cytale.Publish)
    Application.put_env(:cytale, Cytale.Publish, RaisingPublishImpl)

    :telemetry.attach(
      "deletion-sweep-failure-test",
      [:cytale, :accounts, :deletion_sweep_failure],
      fn _event, _measurements, _metadata, pid -> send(pid, :sweep_failed) end,
      self()
    )

    try do
      # A PRIOR test's async sweep can fire the shared telemetry event or
      # log into this capture window, so both assertions must match THIS
      # user's identity — the handler carries the metadata user id and the
      # log assertion matches this user's marker (logged within the
      # assert_receive deadline because the sweep logs before counting).
      :telemetry.detach("deletion-sweep-failure-test")

      :telemetry.attach(
        "deletion-sweep-failure-test",
        [:cytale, :accounts, :deletion_sweep_failure],
        fn _event, _measurements, metadata, pid ->
          send(pid, {:sweep_failed, metadata[:user_id]})
        end,
        self()
      )

      expected_user_id = user.user_id

      log =
        capture_log(fn ->
          :ok = Deletion.delete_account(user.user_id)
          assert_receive {:sweep_failed, ^expected_user_id}, 5_000
        end)

      assert log =~ "account-deletion sweep failed for user #{user.user_id}"

      # The steps before the failure completed (the sweep is not all-or-nothing:
      # partial progress is durable and observable).
      history = Messages.history(ch_id, limit: 10)
      author_msg = Enum.find(history, &(&1.id == mid))
      assert author_msg.content == Deletion.tombstone_content()
      assert Workspaces.get_member(ws_id, user.user_id) == nil
    after
      Application.put_env(:cytale, Cytale.Publish, original || Cytale.Publish.Log)
      :telemetry.detach("deletion-sweep-failure-test")
    end
  end

  # -- A12: webhook capability rows die with the parent account ------------------

  test "parent-account deletion deletes webhook rows: execute 404s (10015), rows gone" do
    %{user: user, channel_id: ch_id} = seed_author()

    {:ok, wh} = Cytale.Webhooks.create_webhook(ch_id, run_unique("Doomed Hook"), user.user_id)

    # Pre-condition: the capability URL executes (204, bare default).
    conn =
      Phoenix.ConnTest.build_conn()
      |> Plug.Conn.put_req_header("content-type", "application/json")
      |> Phoenix.ConnTest.post("/api/webhooks/#{wh.id}/#{wh.token}", %{"content" => "before"})

    assert conn.status == 204

    # The parent's account dies; the async sweep revokes sub-credentials AND
    # (A12) deletes the :webhook-kind principal's capability rows — the URL
    # token is the LIVE credential once the mint-time bot_token died.
    :ok = Deletion.delete_account(user.user_id)

    wait_until(fn ->
      Cytale.Webhooks.get_webhook(wh.id) == nil and
        Cytale.Webhooks.list_webhooks(ch_id) == []
    end)

    gone =
      Phoenix.ConnTest.build_conn()
      |> Plug.Conn.put_req_header("content-type", "application/json")
      |> Phoenix.ConnTest.post("/api/webhooks/#{wh.id}/#{wh.token}", %{"content" => "after"})

    assert gone.status == 404
    assert %{"code" => 10_015, "message" => "Unknown Webhook"} = Jason.decode!(gone.resp_body)
  end

  # Poll helper for the async sweep's observable effects.
  defp wait_until(fun, tries \\ 50)
  defp wait_until(_fun, 0), do: flunk("condition not met in time")

  defp wait_until(fun, tries) do
    if fun.(), do: :ok, else: Process.sleep(20) && wait_until(fun, tries - 1)
  end
end

# A publish impl that raises — injects a mid-sweep failure for the A6
# supervision/observability pin (step 5 of the cascade).
defmodule RaisingPublishImpl do
  @behaviour Cytale.Publish

  @impl true
  def publish(_channel_id, _event), do: raise("publish boom")

  @impl true
  def publish_user_update(_user_id, _event), do: raise("publish boom")
end

# A search impl whose delete_by_author raises — exercises the cascade's
# best-effort search step (tombstoning must still succeed).
defmodule BrokenSearchImpl do
  @behaviour Cytale.Search.Behaviour

  @impl true
  def index(_ws, _msg), do: :ok
  @impl true
  def query(_ws, _q, _f), do: []
  @impl true
  def delete_by_author(_ws, _author), do: raise("search delete failed")
  @impl true
  def reconcile(_ws), do: {:ok, 0}

  # #89 added these to the contract; this double exists for the cascade suite,
  # which never calls them. Loud rather than silently wrong if it ever does.
  @impl true
  def delete_message(_ws, _message_id), do: raise("search delete failed")
  @impl true
  def drift(_ws, _opts), do: raise("search drift not used in this suite")
  @impl true
  def repair_orphans(_ws, _ids), do: raise("search repair not used in this suite")
  @impl true
  def rebuild(_ws, _opts), do: raise("search rebuild not used in this suite")
end
