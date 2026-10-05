defmodule CytaleWeb.Controllers.WebhookControllerTest do
  @moduledoc """
  U11 (bots plan) — webhook REST over raw HTTP (no auth header on execute:
  the URL token IS the credential) plus native management via ConnTest.

  Written anti-enumeration-first (the security core): every execute miss —
  unknown id, wrong token, deleted webhook, deleted channel — renders the
  byte-identical Discord 404 `{code: 10015, message: "Unknown Webhook"}`;
  no oracle may distinguish them. The per-webhook rate bucket (5 / 2s) is
  independent per {webhook_id, token} and NOT the global api bucket.

  KD8 pin: execute is a CAPABILITY — the creating admin leaving the
  workspace does not kill the webhook (no resolver at execute).
  """

  use Cytale.ScyllaCase, async: false

  import Phoenix.ConnTest
  import Plug.Conn

  alias Cytale.Accounts.{Auth, Principals, User}
  alias Cytale.Test.AgentGrants
  alias Cytale.Webhooks
  alias Cytale.Workspaces

  @endpoint CytaleWeb.Endpoint

  # Collision-proof fixture nonce (rest_flow shape): unique within a run
  # (unique_integer) AND across runs (wall clock) — a same-millisecond
  # phash2({node, time}) collision took out User.create with email_taken.
  defp run_nonce,
    do:
      "r" <>
        Integer.to_string(
          :erlang.phash2({System.system_time(:millisecond), System.unique_integer([:positive])}, 1_000_000_000)
        )

  defp run_unique(base), do: base <> run_nonce()

  defp base_url do
    port = Application.fetch_env!(:cytale, CytaleWeb.Endpoint)[:http][:port]
    "http://127.0.0.1:#{port}"
  end

  # Raw HTTP: webhook execute is the unauthenticated surface — exercise it
  # exactly as an external poster does (Finch, no Authorization header).
  defp post_json(path, body) do
    req =
      Finch.build(:post, base_url() <> path, [{"content-type", "application/json"}], Jason.encode!(body))

    {:ok, %Finch.Response{status: status, headers: headers, body: resp_body}} =
      Finch.request(req, finch())

    resp = if resp_body == "", do: nil, else: Jason.decode!(resp_body)
    {status, Map.new(headers, fn {k, v} -> {String.downcase(k), v} end), resp, resp_body}
  end

  defp post_json(path, body, extra_headers) do
    req =
      Finch.build(
        :post,
        base_url() <> path,
        [{"content-type", "application/json"} | extra_headers],
        Jason.encode!(body)
      )

    {:ok, %Finch.Response{status: status, headers: headers, body: resp_body}} =
      Finch.request(req, finch())

    resp = if resp_body == "", do: nil, else: Jason.decode!(resp_body)
    {status, Map.new(headers, fn {k, v} -> {String.downcase(k), v} end), resp, resp_body}
  end

  defp finch, do: CytaleTest.FinchWebhook

  defp ensure_finch! do
    unless Process.whereis(CytaleTest.FinchWebhook) do
      {:ok, _} = Finch.start_link(name: CytaleTest.FinchWebhook)
    end

    :ok
  end

  defp auth_conn(authorization) when is_binary(authorization) do
    Phoenix.ConnTest.build_conn()
    |> put_req_header("accept", "application/json")
    |> put_req_header("content-type", "application/json")
    |> put_req_header("authorization", authorization)
  end

  defp conn_for(user) when is_map(user),
    do: auth_conn("Bearer " <> Auth.issue_access_token(user.user_id, user.username, true))

  setup do
    {:ok, owner} = User.create(run_unique("wh_owner"), run_unique("wh_owner@example.com"), "password-123")
    {:ok, ws} = Workspaces.create_workspace(owner.user_id, run_unique("wh-ws"))
    {:ok, ch} = Workspaces.create_channel(ws.workspace_id, "alerts")

    :ok = ensure_finch!()

    {:ok, conn: conn_for(owner), owner: owner, ws_id: ws.workspace_id, ch: ch}
  end

  defp mint_hook!(ch_id, owner_id, name \\ "Hooky") do
    {:ok, webhook} = Webhooks.create_webhook(ch_id, name, owner_id)
    webhook
  end

  defp execute_path(webhook, suffix \\ ""), do: "/api/webhooks/#{webhook.id}/#{webhook.token}#{suffix}"

  defp native_history(conn, ch_id) do
    conn = get(conn, "/api/v1/channels/#{ch_id}/messages")
    Jason.decode!(conn.resp_body)["messages"]
  end

  # ---------------------------------------------------------------------------
  # Anti-enumeration miss-matrix (the security core — written FIRST, watched red)
  # ---------------------------------------------------------------------------

  test "anti-enumeration: unknown id, wrong token, deleted webhook, and deleted channel are the byte-identical 404 10015",
       %{ch: ch, owner: owner} do
    wh = mint_hook!(ch.channel_id, owner.user_id)

    # Deleted webhook: the management DELETE does exactly this.
    deleted = mint_hook!(ch.channel_id, owner.user_id)
    :ok = Webhooks.delete_webhook(deleted.id)

    # Deleted channel: the cascade removes the rows; the channel-existence
    # backstop covers any drift.
    {:ok, ws2} = Workspaces.create_workspace(owner.user_id, run_unique("wh-ws2"))
    {:ok, ch2} = Workspaces.create_channel(ws2.workspace_id, "dying")
    orphan = mint_hook!(ch2.channel_id, owner.user_id)
    :ok = Workspaces.delete_channel(ch2.channel_id)

    misses = %{
      "unknown id" => "/api/webhooks/#{Cytale.Snowflake.next()}/totally-wrong-token",
      "wrong token" => "/api/webhooks/#{wh.id}/not-the-token",
      "deleted webhook" => execute_path(deleted),
      "deleted channel" => execute_path(orphan)
    }

    results =
      Map.new(misses, fn {label, path} ->
        {status, headers, resp, raw} = post_json(path, %{"content" => "hi"})
        assert status == 404, "#{label}: expected 404, got #{status}"
        assert headers["content-type"] =~ "application/json", "#{label}: JSON body expected"
        {label, {resp, raw}}
      end)

    bodies = results |> Map.values() |> Enum.map(fn {resp, _} -> resp end) |> MapSet.new()
    assert MapSet.size(bodies) == 1, "the four misses must render ONE identical body"
    {resp, raw} = results |> Map.values() |> hd()

    assert resp == %{"code" => 10_015, "message" => "Unknown Webhook"}
    assert raw == Jason.encode!(%{"code" => 10_015, "message" => "Unknown Webhook"})

    # The GOOD path in the same breath: a hit is distinguishable from all
    # misses (that is the point — validity, not enumeration).
    {status, _headers, _resp, _raw} = post_json(execute_path(wh), %{"content" => "hi"})
    assert status == 204

    # GET info misses the same way (Discord token-fetch parity).
    {:ok, %Finch.Response{status: get_status, body: get_body}} =
      Finch.request(Finch.build(:get, base_url() <> "/api/webhooks/#{wh.id}/not-the-token"), finch())

    assert get_status == 404
    assert get_body == Jason.encode!(%{"code" => 10_015, "message" => "Unknown Webhook"})
  end

  # ---------------------------------------------------------------------------
  # Per-webhook rate bucket
  # ---------------------------------------------------------------------------

  test "per-webhook rate bucket: the 6th concurrent request 429s with float retry_after; other webhooks unaffected",
       %{ch: ch, owner: owner} do
    wh = mint_hook!(ch.channel_id, owner.user_id)
    path = execute_path(wh)

    # 6 CONCURRENT posts (a webhook burst): exactly five fit the 5/2s bucket.
    tasks =
      for _ <- 1..6 do
        Task.async(fn -> post_json(path, %{"content" => "burst"}) end)
      end

    results = Task.await_many(tasks, 30_000)
    statuses = Enum.map(results, fn {s, _, _, _} -> s end) |> Enum.sort()
    assert statuses == [204, 204, 204, 204, 204, 429], "expected five 204s and one 429, got: #{inspect(statuses)}"

    {429, headers, body, _raw} = Enum.find(results, fn {s, _, _, _} -> s == 429 end)

    assert is_float(body["retry_after"])
    assert body["retry_after"] > 0
    assert body["code"] == 0
    assert body["global"] == false
    assert is_binary(headers["retry-after"])
    assert headers["x-ratelimit-limit"] == "5"
    assert headers["x-ratelimit-remaining"] == "0"

    # A DIFFERENT webhook's bucket is independent.
    other = mint_hook!(ch.channel_id, owner.user_id, "Other Hook")
    {status, _h, _b, _r} = post_json(execute_path(other), %{"content" => "unaffected"})
    assert status == 204
  end

  # ---------------------------------------------------------------------------
  # Miss-path dam (B2): forged pairs are 404s and each forger mints a FRESH
  # {id, token} — the per-pair bucket never fills. The per-IP miss bucket is
  # the only thing that can stop enumeration at full request rate.
  # ---------------------------------------------------------------------------

  test "miss-path dam: a flood of forged pairs from one IP 429s after the IP ceiling; valid webhooks unaffected",
       %{ch: ch, owner: owner} do
    wh = mint_hook!(ch.channel_id, owner.user_id)
    table = CytaleWeb.Compat.RateTables.webhook_table()
    miss_key = {:miss, {127, 0, 0, 1}}

    # Clean slate — module-mates' misses share the test IP's bucket.
    :ets.delete(table, miss_key)

    # DISTINCT forged pairs: only the IP dam accumulates.
    results =
      for i <- 1..31 do
        path = "/api/webhooks/#{Cytale.Snowflake.next()}/forged-token-#{i}"
        post_json(path, %{"content" => "x"})
      end

    statuses = Enum.map(results, fn {s, _, _, _} -> s end)
    assert Enum.count(statuses, &(&1 == 404)) == 30, "expected 30 dammed-past 404s, got: #{inspect(statuses)}"
    assert Enum.count(statuses, &(&1 == 429)) == 1

    {429, headers, body, _raw} = Enum.find(results, fn {s, _, _, _} -> s == 429 end)
    assert body["code"] == 0
    assert body["global"] == false
    assert is_float(body["retry_after"]) and body["retry_after"] > 0
    assert is_binary(headers["retry-after"])
    assert headers["x-ratelimit-remaining"] == "0"

    # VALID traffic never touches the miss bucket: even with the IP's dam
    # tripped, the real webhook still executes (its own 5/2s pair bucket is
    # its only limit).
    {status, _h, _b, _r} = post_json(execute_path(wh), %{"content" => "valid amid the flood"})
    assert status == 204

    # Cleanup: the flood count must not poison module-mates' miss paths.
    :ets.delete(table, miss_key)
  end

  # ---------------------------------------------------------------------------
  # Management (native envelope)
  # ---------------------------------------------------------------------------

  describe "management" do
    test "create → 201 %{id, url}; the channel read does NOT re-view the token", %{
      conn: conn,
      ch: ch,
      owner: owner
    } do
      conn = post(conn, "/api/v1/channels/#{ch.channel_id}/webhooks", %{"name" => "Deploy Hook"})
      assert conn.status == 201

      assert %{"id" => id, "url" => url} = Jason.decode!(conn.resp_body)
      {:ok, webhook_id} = snowflake(id)
      # ConnTest dispatches with host www.example.com — the URL is built from
      # the request's own host/scheme (port 80 suppressed).
      assert url == "http://www.example.com/api/webhooks/#{id}/#{Webhooks.get_webhook(webhook_id).token}"

      # A :webhook principal backs it (attribution), with NO gateway
      # credential (the URL token is the only capability — the mint-time
      # cytbot_ token was revoked, zero bot_tokens rows remain).
      principal = Principals.get(webhook_id)
      assert principal.kind == :webhook
      assert principal.parent_user_id == owner.user_id

      token_rows =
        Cytale.Repo.execute!(
          "SELECT token_hash FROM #{Cytale.Repo.keyspace()}.bot_tokens WHERE principal_id = ? ALLOW FILTERING",
          [{"bigint", webhook_id}]
        )
        |> Enum.to_list()

      assert token_rows == []

      # The channel's own read is the DESTINATION's governance surface, and its
      # reader is a manager who is usually not the creator — so it carries no
      # token. This replaced a "token re-viewable, Discord parity" pin:
      # re-viewability meant any manager could take a colleague's URL and post
      # as it, and keep doing so after that colleague lost access. `url` above
      # came from CREATE, which still hands it to its creator once.
      list = get(conn, "/api/v1/channels/#{ch.channel_id}/webhooks")
      assert list.status == 200

      assert [%{"id" => ^id, "name" => "Deploy Hook", "channel_id" => ch_id_str}] =
               Jason.decode!(list.resp_body)["webhooks"]

      assert ch_id_str == Integer.to_string(ch.channel_id)

      token = Webhooks.get_webhook(webhook_id).token

      refute list.resp_body =~ token,
             "the capability token must not appear anywhere in the destination's read"

      refute list.resp_body =~ "/api/webhooks/"
    end

    # B6g: the per-channel webhook budget renders the native webhook_cap key.
    test "create past the channel cap → 400 with the webhook_cap native key", %{conn: conn, ch: ch, owner: owner} do
      cap = Webhooks.channel_webhook_cap()

      for i <- 1..(cap - 1) do
        assert {:ok, _} = Webhooks.create_webhook(ch.channel_id, "Seed #{i}", owner.user_id)
      end

      # The cap-th create still fits (201)...
      last = post(conn, "/api/v1/channels/#{ch.channel_id}/webhooks", %{"name" => "The Last"})
      assert last.status == 201

      # ...the next one is the 400 cap with the native error key.
      over = post(conn, "/api/v1/channels/#{ch.channel_id}/webhooks", %{"name" => "One Too Many"})
      assert over.status == 400
      assert Jason.decode!(over.resp_body)["error"]["key"] == "webhook_cap"
    end

    test "create gates: missing name 400; unknown channel 404; member without manage_channels 403; non-member 404 (no oracle)",
         %{conn: conn, ch: ch, ws_id: ws_id, owner: owner} do
      assert conn |> post("/api/v1/channels/#{ch.channel_id}/webhooks", %{}) |> then(& &1.status) == 400

      unknown = post(conn, "/api/v1/channels/#{Cytale.Snowflake.next()}/webhooks", %{"name" => "X"})
      assert unknown.status == 404
      assert Jason.decode!(unknown.resp_body)["error"]["key"] == "channel_not_found"

      # A plain member (no roles): @everyone grants view+send only.
      {:ok, member} = User.create(run_unique("wh_member"), run_unique("wh_member@example.com"), "password-123")
      :ok = Workspaces.add_member(ws_id, member.user_id, owner.user_id)

      member_conn = conn_for(member)
      denied = post(member_conn, "/api/v1/channels/#{ch.channel_id}/webhooks", %{"name" => "X"})
      assert denied.status == 403
      assert Jason.decode!(denied.resp_body)["error"]["key"] == "forbidden"

      # A manager of a DIFFERENT workspace is not a member here: the SAME 404
      # as the unknown-channel leg above (Tier 3 B, 11 — the old 403 confirmed
      # the channel existed).
      {:ok, outsider} = User.create(run_unique("wh_out"), run_unique("wh_out@example.com"), "password-123")
      {:ok, _other_ws} = Workspaces.create_workspace(outsider.user_id, run_unique("wh-out-ws"))

      outsider_conn = conn_for(outsider)
      outsider_resp = post(outsider_conn, "/api/v1/channels/#{ch.channel_id}/webhooks", %{"name" => "X"})
      assert outsider_resp.status == 404
      assert Jason.decode!(outsider_resp.resp_body)["error"]["key"] == "channel_not_found"

      # Machine principals cannot mint (R1 depth-1) — even one whose parent
      # holds full rights here.
      {:ok, bot} = AgentGrants.mint_all(owner.user_id, :bot, run_unique("Minty"))
      bot_conn = auth_conn("Bot " <> bot.token)
      bot_resp = post(bot_conn, "/api/v1/channels/#{ch.channel_id}/webhooks", %{"name" => "X"})
      assert bot_resp.status == 403
    end

    test "PATCH renames (info reflects it); DELETE 204s and execute 404s", %{
      conn: conn,
      ch: ch,
      owner: owner
    } do
      wh = mint_hook!(ch.channel_id, owner.user_id)

      patched = patch(conn, "/api/v1/channels/#{ch.channel_id}/webhooks/#{wh.id}", %{"name" => "Renamed"})
      assert patched.status == 200
      assert Jason.decode!(patched.resp_body)["webhook"]["name"] == "Renamed"

      # The unauthenticated info surface renders the new label.
      {:ok, %Finch.Response{status: 200, body: info_body}} =
        Finch.request(Finch.build(:get, base_url() <> execute_path(wh)), finch())

      assert Jason.decode!(info_body) == %{
               "id" => Integer.to_string(wh.id),
               "name" => "Renamed",
               "channel_id" => Integer.to_string(ch.channel_id),
               "type" => 1
             }

      deleted = delete(conn, "/api/v1/channels/#{ch.channel_id}/webhooks/#{wh.id}")
      assert deleted.status == 204

      {status, _h, body, _raw} = post_json(execute_path(wh), %{"content" => "zombie?"})
      assert status == 404
      assert body == %{"code" => 10_015, "message" => "Unknown Webhook"}
    end
  end

  # ---------------------------------------------------------------------------
  # Ownership (KD2/KD3): a webhook belongs to the user who created it
  # ---------------------------------------------------------------------------

  describe "ownership" do
    test "the creator's own list carries the url and the destination", %{
      ch: ch,
      owner: owner,
      ws_id: ws_id
    } do
      wh = mint_hook!(ch.channel_id, owner.user_id, "Deploy Hook")

      list = get(conn_for(owner), "/api/v1/users/@me/webhooks")
      assert list.status == 200

      assert [row] = Jason.decode!(list.resp_body)["webhooks"]
      assert row["id"] == Integer.to_string(wh.id)
      assert row["name"] == "Deploy Hook"
      assert row["url"] == "http://www.example.com/api/webhooks/#{wh.id}/#{wh.token}"

      # The destination is NAMED, so the list is readable without the caller
      # knowing any workspace id.
      assert row["destination"]["channel_id"] == Integer.to_string(ch.channel_id)
      assert row["destination"]["channel_name"] == ch.name
      assert row["destination"]["workspace_id"] == Integer.to_string(ws_id)
      assert is_binary(row["destination"]["workspace_name"])
    end

    test "another user's webhook is not in my list, and their id is not mutatable", %{
      ch: ch,
      conn: owner_conn
    } do
      {:ok, other} = User.create(run_unique("wh_other"), run_unique("wh_other@example.com"), "password-123")
      theirs = mint_hook!(ch.channel_id, other.user_id, "Theirs")

      # Isolation: my list is mine.
      mine = get(conn_for(other), "/api/v1/users/@me/webhooks")
      assert [%{"id" => their_id}] = Jason.decode!(mine.resp_body)["webhooks"]
      assert their_id == Integer.to_string(theirs.id)

      assert Jason.decode!(get(owner_conn, "/api/v1/users/@me/webhooks").resp_body)["webhooks"] == []

      # Not-the-owner is the SAME answer as unknown: the id space is not an
      # oracle. (A 403 would confirm the webhook exists.)
      assert patch(owner_conn, "/api/v1/webhooks/#{theirs.id}", %{"name" => "Hijacked"}).status == 404
      assert delete(owner_conn, "/api/v1/webhooks/#{theirs.id}").status == 404
      assert Webhooks.get_webhook(theirs.id).name == "Theirs"
      assert patch(owner_conn, "/api/v1/webhooks/999999999999999999", %{"name" => "Nope"}).status == 404
    end

    test "the owner can manage their webhook with NO channel rights at all", %{
      ch: ch,
      owner: owner
    } do
      {:ok, outsider} =
        User.create(run_unique("wh_out"), run_unique("wh_out@example.com"), "password-123")

      # A webhook this user minted into a channel they were never a member of:
      # the point of KD2 is that the channel gate cannot strand it. The create
      # ROUTE is gated; the context is not, which is exactly why the owner
      # routes must not ride `can_manage_channels`.
      wh = mint_hook!(ch.channel_id, outsider.user_id, "Stranded")

      conn = conn_for(outsider)
      assert [%{"id" => id}] = Jason.decode!(get(conn, "/api/v1/users/@me/webhooks").resp_body)["webhooks"]
      assert id == Integer.to_string(wh.id)

      renamed = patch(conn, "/api/v1/webhooks/#{wh.id}", %{"name" => "Rescued"})
      assert renamed.status == 200
      assert Webhooks.get_webhook(wh.id).name == "Rescued"

      assert delete(conn, "/api/v1/webhooks/#{wh.id}").status == 204
      assert Webhooks.get_webhook(wh.id) == nil
      assert Jason.decode!(get(conn, "/api/v1/users/@me/webhooks").resp_body)["webhooks"] == []
    end

    test "a revoked webhook leaves no zombie row in the owner's list", %{ch: ch, owner: owner} do
      wh = mint_hook!(ch.channel_id, owner.user_id)
      assert length(Jason.decode!(get(conn_for(owner), "/api/v1/users/@me/webhooks").resp_body)["webhooks"]) == 1

      # Revoking drops the capability row; `list_by_parent` still answers (the
      # PROVENANCE survives for attribution), so the owner read must drop it
      # rather than render a URL that cannot post.
      :ok = Webhooks.delete_webhook(wh.id)
      assert Jason.decode!(get(conn_for(owner), "/api/v1/users/@me/webhooks").resp_body)["webhooks"] == []

      # Idempotent, and still the uniform not-found afterwards.
      assert delete(conn_for(owner), "/api/v1/webhooks/#{wh.id}").status == 404
    end

    test "unauthenticated → 401 on every ownership route" do
      anon =
        Phoenix.ConnTest.build_conn()
        |> put_req_header("accept", "application/json")

      assert get(anon, "/api/v1/users/@me/webhooks").status == 401
      assert patch(anon, "/api/v1/webhooks/1", %{"name" => "x"}).status == 401
      assert delete(anon, "/api/v1/webhooks/1").status == 401
    end
  end

  # ---------------------------------------------------------------------------
  # Execute: bare Discord semantics
  # ---------------------------------------------------------------------------

  describe "execute (bare)" do
    test "204 default with NO body; the message lands authored by the webhook principal", %{
      ch: ch,
      owner: owner,
      conn: conn
    } do
      wh = mint_hook!(ch.channel_id, owner.user_id)

      {status, _headers, resp, raw} = post_json(execute_path(wh), %{"content" => "deploy done"})
      assert status == 204
      assert raw == ""
      assert resp == nil

      # The native read path joins it: author_id is the webhook PRINCIPAL,
      # attribution intact; no override row → no author_override key.
      [%{"author_id" => author_id, "content" => "deploy done"}] = native_history(conn, ch.channel_id)
      assert author_id == Integer.to_string(wh.id)
      assert Webhooks.get_webhook(wh.id).id == wh.id
    end

    test "wait=true returns the Discord message object; override name renders (override ∥ display name)",
         %{ch: ch, owner: owner} do
      wh = mint_hook!(ch.channel_id, owner.user_id, "CI Hook")

      # Default rendering: no override → the webhook's display label.
      {200, _, msg, _} = post_json(execute_path(wh) <> "?wait=true", %{"content" => "no override"})
      assert msg["author"]["username"] == "CI Hook"
      assert msg["author"]["bot"] == true
      assert msg["webhook_id"] == Integer.to_string(wh.id)
      assert msg["content"] == "no override"
      assert msg["channel_id"] == Integer.to_string(ch.channel_id)

      # Override rendering: per-message username wins on the author object;
      # author_id/webhook_id stay the principal's.
      {200, _, over, _} =
        post_json(execute_path(wh) <> "?wait=true", %{
          "content" => "with override",
          "username" => "Dep Roy",
          "avatar_url" => "https://cdn.example.com/a.png",
          # accepted and ignored:
          "tts" => true,
          "allowed_mentions" => %{"parse" => ["users"]}
        })

      assert over["author"]["username"] == "Dep Roy"
      assert over["author"]["global_name"] == "Dep Roy"
      assert over["webhook_id"] == Integer.to_string(wh.id)

      # Native history carries the optional author_override key ONLY where an
      # override row exists (additive growth, KTD12).
      [no_override, with_override | _] = native_history(owner_conn(owner), ch.channel_id) |> Enum.reverse()
      refute Map.has_key?(no_override, "author_override")

      assert with_override["author_override"] == %{
               "username" => "Dep Roy",
               "avatar_url" => "https://cdn.example.com/a.png",
               "kind" => "webhook"
             }
    end

    test "embed-only execute stores embeds (U10 storage); interactive components rejected (R6)", %{
      ch: ch,
      owner: owner
    } do
      wh = mint_hook!(ch.channel_id, owner.user_id)

      embed = %{
        "title" => "Deploy OK",
        "description" => "prod is green",
        "fields" => [%{"name" => "commit", "value" => "abc123"}]
      }

      # An interactive component (custom button) on a webhook → 400 50035:
      # webhook principals have no gateway session to receive clicks.
      {status, _h, body, _} =
        post_json(execute_path(wh) <> "?wait=true", %{
          "embeds" => [embed],
          "components" => [
            %{
              "type" => 1,
              "components" => [%{"type" => 2, "style" => 1, "label" => "B", "custom_id" => "b"}]
            }
          ]
        })

      assert status == 400
      assert body == %{"code" => 50_035, "message" => "Invalid Form Body"}

      # Nothing was persisted by the rejected execute.
      assert native_history(owner_conn(owner), ch.channel_id) == []

      # Without the interactive component the embed-only shape still works.
      {200, _, msg, _} = post_json(execute_path(wh) <> "?wait=true", %{"embeds" => [embed]})
      assert msg["content"] == ""
      assert msg["embeds"] == [embed]
      refute Map.has_key?(msg, "components")
    end

    test "style-5-only link rows are the scoped allowance: stored, rendered, ride native reads (R6)", %{
      ch: ch,
      owner: owner,
      conn: conn
    } do
      wh = mint_hook!(ch.channel_id, owner.user_id)

      link_rows = [
        %{
          "type" => 1,
          "components" => [
            %{"type" => 2, "style" => 5, "label" => "View diff", "url" => "https://git.example.com/c/1"}
          ]
        }
      ]

      # Bare execute (no wait): 204, stored.
      {status, _h, _body, raw} = post_json(execute_path(wh), %{"content" => "ci passed", "components" => link_rows})
      assert status == 204
      assert raw == ""

      # wait=true renders the Discord message object carrying the rows.
      {200, _, msg, _} =
        post_json(execute_path(wh) <> "?wait=true", %{"content" => "ci passed again", "components" => link_rows})

      assert msg["components"] == link_rows

      # Native history carries the optional components key (store-and-forward).
      history = native_history(conn, ch.channel_id)
      assert hd(history)["components"] == link_rows
    end

    test "errors: empty payload (no content, no embeds) → 400 50035; oversize embed → 400 50035", %{
      ch: ch,
      owner: owner
    } do
      wh = mint_hook!(ch.channel_id, owner.user_id)

      {status, _h, body, _} = post_json(execute_path(wh), %{"tts" => true})
      assert status == 400
      assert body == %{"code" => 50_035, "message" => "Invalid Form Body"}

      {status, _h, body, _} =
        post_json(execute_path(wh), %{"embeds" => [%{"description" => String.duplicate("x", 9_000)}]})

      assert status == 400
      assert body == %{"code" => 50_035, "message" => "Invalid Form Body"}
    end
  end

  # ---------------------------------------------------------------------------
  # Transformers: /slack + /github
  # ---------------------------------------------------------------------------

  describe "execute via transformers" do
    test "/slack {text} posts with wait DEFAULT TRUE → message object; ?wait=false → 204",
         %{ch: ch, owner: owner} do
      wh = mint_hook!(ch.channel_id, owner.user_id)

      {status, _h, msg, _} =
        post_json(execute_path(wh, "/slack"), %{"text" => "hello from slack", "username" => "Slack Bot"})

      assert status == 200
      assert msg["content"] == "hello from slack"
      assert msg["author"]["username"] == "Slack Bot"
      assert msg["webhook_id"] == Integer.to_string(wh.id)

      {status, _h, resp, raw} = post_json(execute_path(wh, "/slack") <> "?wait=false", %{"text" => "quiet"})
      assert status == 204
      assert raw == ""
      assert resp == nil
    end

    test "/github push event renders content + embed card; generic events get the one-liner",
         %{ch: ch, owner: owner} do
      wh = mint_hook!(ch.channel_id, owner.user_id)

      push = %{
        "ref" => "refs/heads/main",
        "compare" => "https://github.com/acme/app/compare/a...b",
        "pusher" => %{"name" => "jordan"},
        "repository" => %{"full_name" => "acme/app"},
        "commits" => [
          %{"id" => "c0ffee1234567890", "message" => "fix: the widget\n\nlong body"},
          %{"id" => "deadbeef", "message" => "feat: widget v2"}
        ]
      }

      {200, _, msg, _} = post_json(execute_path(wh, "/github"), push, [{"x-github-event", "push"}])

      assert msg["content"] =~ "acme/app"
      assert msg["content"] =~ "jordan pushed 2 commits to main"
      assert msg["content"] =~ "fix: the widget"

      assert [embed] = msg["embeds"]
      assert embed["title"] =~ "acme/app"
      assert embed["title"] =~ "2 new commits to main"
      assert embed["url"] == "https://github.com/acme/app/compare/a...b"
      assert embed["description"] =~ "c0ffee1: fix: the widget"
      assert embed["description"] =~ "deadbee: feat: widget v2"
      assert msg["webhook_id"] == Integer.to_string(wh.id)

      # Uncovered events: the generic line, no card.
      {200, _, generic, _} =
        post_json(execute_path(wh, "/github"), %{"repository" => %{"full_name" => "acme/app"}}, [
          {"x-github-event", "release"}
        ])

      assert generic["content"] == "GitHub release event received"
      assert generic["embeds"] == []
    end
  end

  # ---------------------------------------------------------------------------
  # Multipart execute (Discord's files[n] + payload_json file model)
  # ---------------------------------------------------------------------------

  describe "multipart execute" do
    test "files[0] + payload_json → wait=true returns the message with a stored attachment object",
         %{ch: ch, owner: owner} do
      wh = mint_hook!(ch.channel_id, owner.user_id)
      blob = <<0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 9, 9, 9>>

      {body, ct} =
        multipart_body([
          {:field, "payload_json", Jason.encode!(%{"content" => "multipart hello", "username" => "File Hook"})},
          {:file, "files[0]", "compat-pixel.png", "image/png", blob}
        ])

      conn =
        build_conn()
        |> put_req_header("accept", "application/json")
        |> put_req_header("content-type", ct)
        |> post(execute_path(wh) <> "?wait=true", body)

      assert conn.status == 200
      msg = Jason.decode!(conn.resp_body)
      assert msg["content"] == "multipart hello"
      assert msg["webhook_id"] == Integer.to_string(wh.id)

      # The Discord attachment object: fresh snowflake id, ABSOLUTE url
      # (conn-derived origin — the same builder webhook capability URLs use),
      # part filename/type/byte size.
      assert [
               %{
                 "id" => att_id,
                 "url" => url,
                 "filename" => "compat-pixel.png",
                 "content_type" => "image/png",
                 "size" => size
               }
             ] =
               msg["attachments"]

      assert match?({int, ""} when int > 0, Integer.parse(att_id))
      assert size == byte_size(blob)
      hash = Cytale.Attachments.Store.hash(blob)
      # Rendered SIGNED (Tier 2 #4); the canonical part is the content URL.
      assert Cytale.Attachments.SignedUrl.canonical(url) == "http://www.example.com/api/v1/attachments/#{hash}"
      assert url =~ "?e="

      # The blob serves back with the stored type and inline disposition.
      %URI{path: path, query: query} = URI.parse(url)
      served = get(build_conn() |> put_req_header("accept", "application/json"), path <> "?" <> query)
      assert served.status == 200
      assert served.resp_body == blob
      assert get_resp_header(served, "content-type") == ["image/png"]
      assert get_resp_header(served, "content-disposition") == ["inline; filename=\"compat-pixel.png\""]

      # Native history carries the descriptor and the webhook attribution.
      [landed] = Enum.filter(native_history(owner_conn(owner), ch.channel_id), &(&1["content"] == "multipart hello"))
      assert landed["author_id"] == Integer.to_string(wh.id)
      assert [%{"filename" => "compat-pixel.png", "url" => ^url}] = landed["attachments"]
    end

    test "JSON bodies keep working byte-identically; attachments metadata WITHOUT files is tolerated", %{
      ch: ch,
      owner: owner
    } do
      wh = mint_hook!(ch.channel_id, owner.user_id)

      {200, _, msg, _} =
        post_json(execute_path(wh) <> "?wait=true", %{
          "content" => "metadata only",
          "attachments" => [
            %{
              "url" => "https://cdn.example.com/cat.png",
              "filename" => "cat.png",
              "content_type" => "image/png",
              "size" => 12
            }
          ]
        })

      assert msg["content"] == "metadata only"
      assert [%{"url" => "https://cdn.example.com/cat.png", "filename" => "cat.png"}] = msg["attachments"]
      refute Map.has_key?(msg, "files")
    end

    test "missing payload_json → 400 50035; disallowed mime → 400 50035; over-cap → 400 50035", %{
      ch: ch,
      owner: owner
    } do
      wh = mint_hook!(ch.channel_id, owner.user_id)

      # Only a file part, no payload_json.
      {body, ct} = multipart_body([{:file, "files[0]", "a.png", "image/png", <<1, 2, 3>>}])

      conn =
        build_conn()
        |> put_req_header("accept", "application/json")
        |> put_req_header("content-type", ct)
        |> post(execute_path(wh), body)

      assert conn.status == 400
      assert Jason.decode!(conn.resp_body) == %{"code" => 50_035, "message" => "Invalid Form Body"}

      # Disallowed mime (the fixed allowlist).
      {bad_mime_body, bad_mime_ct} =
        multipart_body([
          {:field, "payload_json", Jason.encode!(%{"content" => "sh payload"})},
          {:file, "files[0]", "evil.sh", "application/x-sh", "#!/bin/sh\nrm -rf /"}
        ])

      conn =
        build_conn()
        |> put_req_header("accept", "application/json")
        |> put_req_header("content-type", bad_mime_ct)
        |> post(execute_path(wh), bad_mime_body)

      assert conn.status == 400
      assert Jason.decode!(conn.resp_body) == %{"code" => 50_035, "message" => "Invalid Form Body"}

      # Over-cap (26 MB blob — under the endpoint's 30 MB parser cap).
      {big_body, big_ct} =
        multipart_body([
          {:field, "payload_json", Jason.encode!(%{"content" => "big payload"})},
          {:file, "files[0]", "big.bin", "text/plain", :binary.copy(<<0>>, 26 * 1024 * 1024)}
        ])

      conn =
        build_conn()
        |> put_req_header("accept", "application/json")
        |> put_req_header("content-type", big_ct)
        |> post(execute_path(wh), big_body)

      assert conn.status == 400
      assert Jason.decode!(conn.resp_body) == %{"code" => 50_035, "message" => "Invalid Form Body"}

      # Nothing landed.
      history = native_history(owner_conn(owner), ch.channel_id)
      refute Enum.any?(history, &(&1["content"] in ["sh payload", "big payload"]))
    end
  end

  # ---------------------------------------------------------------------------
  # KD8 + cascade
  # ---------------------------------------------------------------------------

  test "KD8: the creating admin leaving the workspace does NOT kill the webhook", %{
    ch: ch,
    owner: owner,
    ws_id: ws_id,
    conn: conn
  } do
    wh = mint_hook!(ch.channel_id, owner.user_id)

    # The owner-admin leaves (or is kicked): no membership row remains.
    :ok = Workspaces.remove_member(ws_id, owner.user_id)

    {status, _h, _resp, _raw} = post_json(execute_path(wh), %{"content" => "still alive"})
    assert status == 204

    [%{"author_id" => author_id, "content" => "still alive"}] = native_history(conn, ch.channel_id)
    assert author_id == Integer.to_string(wh.id)
  end

  test "channel delete cascades: rows gone, execute 404s, list empty", %{
    ch: ch,
    owner: owner,
    conn: conn
  } do
    wh = mint_hook!(ch.channel_id, owner.user_id)

    :ok = Workspaces.delete_channel(ch.channel_id)

    assert Webhooks.get_webhook(wh.id) == nil
    assert Webhooks.list_webhooks(ch.channel_id) == []

    {status, _h, body, _} = post_json(execute_path(wh), %{"content" => "gone?"})
    assert status == 404
    assert body == %{"code" => 10_015, "message" => "Unknown Webhook"}

    list = get(conn, "/api/v1/channels/#{ch.channel_id}/webhooks")
    assert list.status == 404
  end

  # ---------------------------------------------------------------------------
  # Helpers
  # ---------------------------------------------------------------------------

  defp owner_conn(owner), do: conn_for(owner)

  # Build a real multipart/form-data body: `{:field, name, value}` string
  # parts and `{:file, name, filename, content_type, blob}` file parts
  # (file parts are what Plug parses into %Plug.Upload{}).
  defp multipart_body(parts) do
    boundary = "cytale-multipart-#{System.unique_integer([:positive])}"

    body =
      Enum.map_join(parts, "", fn
        {:field, name, value} ->
          "--#{boundary}\r\n" <>
            "Content-Disposition: form-data; name=\"#{name}\"\r\n\r\n" <>
            value <> "\r\n"

        {:file, name, filename, content_type, blob} ->
          "--#{boundary}\r\n" <>
            "Content-Disposition: form-data; name=\"#{name}\"; filename=\"#{filename}\"\r\n" <>
            "Content-Type: #{content_type}\r\n\r\n" <>
            blob <> "\r\n"
      end) <> "--#{boundary}--\r\n"

    {body, "multipart/form-data; boundary=#{boundary}"}
  end

  defp snowflake(bin) when is_binary(bin) do
    case Integer.parse(bin) do
      {int, ""} when int > 0 -> {:ok, int}
      _ -> :error
    end
  end
end
