defmodule CytaleWeb.Compat.PipelineTest do
  @moduledoc """
  U6 (bots plan) — the compat pipeline contract: `Bot cytbot_`-only auth with
  the Discord 401 shape (R7), the full X-RateLimit-* header set on every
  response including 404/403 (KTD9), bucket stability across major params,
  and the 429 shape (retry_after float, Retry-After, Scope: user).
  """

  use Cytale.ScyllaCase, async: false

  import Phoenix.ConnTest

  alias Cytale.Accounts.{Auth, Principals, User}
  alias Cytale.Test.AgentGrants
  alias Cytale.Workspaces
  alias CytaleWeb.Compat.RateLimit

  @endpoint CytaleWeb.Endpoint
  @rate_table :cytale_compat_rate_limit

  defp run_unique(base) do
    # Collision-proof fixture nonce, unique WITHIN a run (monotonic unique)
    # and ACROSS runs (wall-clock ms — the persistent test keyspace keeps
    # rows from previous runs, so a per-VM counter alone collides).
    base <>
      Integer.to_string(
        :erlang.phash2({System.system_time(:millisecond), System.unique_integer([:positive])}, 1_000_000_000)
      )
  end

  defp conn_with(authorization) do
    Phoenix.ConnTest.build_conn()
    |> put_req_header("accept", "application/json")
    |> put_req_header("content-type", "application/json")
    |> put_req_header("authorization", authorization)
  end

  setup do
    {:ok, owner} = User.create(run_unique("pipe_owner"), run_unique("pipe_owner@example.com"), "password-123")
    {:ok, ws} = Workspaces.create_workspace(owner.user_id, run_unique("pipe-ws"))
    {:ok, ch} = Workspaces.create_channel(ws.workspace_id, "general")
    {:ok, other} = Workspaces.create_channel(ws.workspace_id, "random")
    {:ok, %{user_id: bot_id, token: token}} = AgentGrants.mint_all(owner.user_id, :bot, run_unique("Pipe Bot"))

    {:ok,
     owner: owner,
     ws_id: ws.workspace_id,
     ch_id: Integer.to_string(ch.channel_id),
     other_id: Integer.to_string(other.channel_id),
     bot_id: bot_id,
     token: token}
  end

  # ---------------------------------------------------------------------------
  # Auth scheme
  # ---------------------------------------------------------------------------

  describe "Bot-scheme-only auth (401 Discord shape)" do
    test "bad token → 401 {message: \"401: Unauthorized\", code: 0}" do
      conn = get(conn_with("Bot cytbot_totally-bogus"), "/api/v10/users/@me")
      assert conn.status == 401
      assert Jason.decode!(conn.resp_body) == %{"message" => "401: Unauthorized", "code" => 0}
    end

    test "missing authorization header → 401 code 0" do
      conn = Phoenix.ConnTest.build_conn() |> get("/api/v10/users/@me")
      assert conn.status == 401
      assert Jason.decode!(conn.resp_body)["code"] == 0
    end

    test "Bearer cytbot_ on compat → 401 (Bot scheme only)" do
      conn = get(conn_with("Bearer cytbot_whatever"), "/api/v10/users/@me")
      assert conn.status == 401
      assert Jason.decode!(conn.resp_body)["code"] == 0
    end

    test "Bot <JWT> → 401 (never a silent human fallback)" do
      {:ok, stranger} = User.create(run_unique("jwt_user"), run_unique("jwt_user@example.com"), "password-123")
      jwt = Auth.issue_access_token(stranger.user_id, stranger.username, true)
      conn = get(conn_with("Bot " <> jwt), "/api/v10/users/@me")
      assert conn.status == 401
      assert Jason.decode!(conn.resp_body)["code"] == 0
    end

    test "Bearer <JWT> (human) on compat → 401", %{owner: owner} do
      jwt = Auth.issue_access_token(owner.user_id, owner.username, true)
      conn = get(conn_with("Bearer " <> jwt), "/api/v10/users/@me")
      assert conn.status == 401
      assert Jason.decode!(conn.resp_body)["code"] == 0
    end

    test "revoked token → 401 (revoke is row delete)", %{token: token, bot_id: bot_id} do
      :ok = Principals.revoke(bot_id)
      conn = get(conn_with("Bot " <> token), "/api/v10/users/@me")
      assert conn.status == 401
    end
  end

  # ---------------------------------------------------------------------------
  # Compat JSON framing (#61 item 1)
  # ---------------------------------------------------------------------------

  describe "compat JSON framing" do
    # discord.py decides whether to parse a body as JSON by EXACT string
    # comparison (`discord/http.py`: `response.headers['content-type'] ==
    # 'application/json'`), and Phoenix's default rendering appends
    # `; charset=utf-8` — so every compat body arrived as raw text and login
    # died in the user parser (`TypeError: string indices must be integers`).
    defp assert_bare_json!(conn) do
      assert get_resp_header(conn, "content-type") == ["application/json"],
             "compat responses must carry EXACTLY application/json (no charset); " <>
               "got: #{inspect(get_resp_header(conn, "content-type"))}"
    end

    test "a 200 body is framed exactly `application/json`", %{token: token} do
      conn = get(conn_with("Bot " <> token), "/api/v10/users/@me")
      assert conn.status == 200
      assert_bare_json!(conn)
    end

    test "the bare /api prefix is framed the same way", %{token: token} do
      conn = get(conn_with("Bot " <> token), "/api/users/@me")
      assert conn.status == 200
      assert_bare_json!(conn)
    end

    test "an AUTH error is framed the same way (the 401 that broke login)" do
      conn = get(conn_with("Bot cytbot_totally-bogus"), "/api/v10/users/@me")
      assert conn.status == 401
      assert_bare_json!(conn)
    end

    test "a resource error is framed the same way", %{token: token} do
      conn = get(conn_with("Bot " <> token), "/api/v10/channels/999999999999999999")
      assert conn.status == 404
      assert_bare_json!(conn)
    end

    test "the NATIVE surface keeps Phoenix's charset default (the fix is compat-only)" do
      conn = Phoenix.ConnTest.build_conn() |> get("/api/v1/users/@me")
      assert conn.status == 401
      assert get_resp_header(conn, "content-type") == ["application/json; charset=utf-8"]
    end
  end

  # ---------------------------------------------------------------------------
  # Rate-limit header set (KTD9)
  # ---------------------------------------------------------------------------

  describe "X-RateLimit-* headers" do
    test "present on a 200 with sane values", %{token: token} do
      conn = get(conn_with("Bot " <> token), "/api/v10/users/@me")
      assert conn.status == 200

      assert [limit] = get_resp_header(conn, "x-ratelimit-limit")
      assert {limit_i, ""} = Integer.parse(limit)
      assert limit_i > 0

      assert [remaining] = get_resp_header(conn, "x-ratelimit-remaining")
      assert {rem_i, ""} = Integer.parse(remaining)
      assert rem_i >= 0 and rem_i <= limit_i

      # Reset is epoch seconds (>= now); Reset-After is a ms-precision decimal.
      assert [reset] = get_resp_header(conn, "x-ratelimit-reset")
      assert {reset_i, ""} = Integer.parse(reset)
      assert reset_i >= System.system_time(:second) - 1

      assert [reset_after] = get_resp_header(conn, "x-ratelimit-reset-after")
      assert Regex.match?(~r/^\d+\.\d+$/, reset_after)
      assert {ra, ""} = Float.parse(reset_after)
      assert ra > 0 and ra <= 10

      assert [bucket] = get_resp_header(conn, "x-ratelimit-bucket")
      assert byte_size(bucket) > 0
    end

    test "present on 404 (anti-enumeration) and 403 responses", %{
      token: token,
      ch_id: ch_id,
      owner: owner
    } do
      missing = get(conn_with("Bot " <> token), "/api/v10/channels/123456789012345678")
      assert missing.status == 404
      assert get_resp_header(missing, "x-ratelimit-limit") != []
      assert get_resp_header(missing, "x-ratelimit-bucket") != []

      # Post-restricted agent (read-only) POSTing → 403 with headers.
      {:ok, %{token: ro}} =
        AgentGrants.mint_all(owner.user_id, :agent, run_unique("ReadOnly"), %{
          "actions" => ["read"],
          "channels" => [ch_id]
        })

      denied =
        post(conn_with("Bot " <> ro), "/api/v10/channels/#{ch_id}/messages", %{"content" => "nope"})

      assert denied.status == 403
      assert get_resp_header(denied, "x-ratelimit-limit") != []
      assert get_resp_header(denied, "x-ratelimit-bucket") != []
    end

    test "bucket string identical across channel ids, prefixes, and stable per method", %{
      token: token,
      ch_id: ch_id,
      other_id: other_id
    } do
      a = get(conn_with("Bot " <> token), "/api/v10/channels/#{ch_id}/messages")
      b = get(conn_with("Bot " <> token), "/api/v10/channels/#{other_id}/messages")
      # The bare /api alias shares the route template → same bucket.
      c = get(conn_with("Bot " <> token), "/api/channels/#{ch_id}/messages")

      assert [bucket] = get_resp_header(a, "x-ratelimit-bucket")
      assert get_resp_header(b, "x-ratelimit-bucket") == [bucket]
      assert get_resp_header(c, "x-ratelimit-bucket") == [bucket]

      # A different method is a different bucket.
      d = post(conn_with("Bot " <> token), "/api/v10/channels/#{ch_id}/messages", %{"content" => "x"})
      assert get_resp_header(d, "x-ratelimit-bucket") != [bucket]
    end

    test "template masks numeric segments (major params) and the version prefix" do
      assert RateLimit.template("GET", ["api", "v10", "channels", "123", "messages"]) ==
               "GET:/channels/{id}/messages"

      assert RateLimit.template("GET", ["api", "channels", "123", "messages"]) ==
               "GET:/channels/{id}/messages"

      assert RateLimit.template("GET", ["api", "v10", "users", "@me"]) == "GET:/users/@me"

      assert RateLimit.template("PATCH", ["api", "v10", "channels", "1", "messages", "2"]) ==
               "PATCH:/channels/{id}/messages/{id}"
    end

    # C-2: route-CLASS limits — the template is still the bucket identity;
    # the LIMIT riding the header is the class's.
    test "route classes: reactions 10/5s, other mutations 25/10s, reads 50/10s; sends ride the send budget", %{
      token: token,
      ch_id: ch_id
    } do
      # Template classification (unit level).
      assert RateLimit.classify("POST:/channels/{id}/messages") == :message_write
      assert RateLimit.classify("PUT:/channels/{id}/messages/{id}/reactions/{emoji}/@me") == :message_write
      assert RateLimit.classify("DELETE:/channels/{id}/messages/{id}/reactions/{emoji}") == :message_write
      assert RateLimit.classify("DELETE:/channels/{id}/messages/{id}/reactions") == :message_write
      assert RateLimit.classify("GET:/channels/{id}/messages/{id}/reactions/{emoji}") == :read
      assert RateLimit.classify("PATCH:/channels/{id}/messages/{id}") == :mutation
      assert RateLimit.classify("POST:/channels/{id}/typing") == :mutation
      assert RateLimit.classify("POST:/users/@me/channels") == :mutation
      assert RateLimit.classify("GET:/users/@me") == :read

      # Live header values per class (one request each — nothing floods).
      conn = get(conn_with("Bot " <> token), "/api/v10/users/@me")
      assert get_resp_header(conn, "x-ratelimit-limit") == ["50"]

      # A SEND is not class-governed: the one send budget every send route
      # shares (`CytaleWeb.Plugs.SendBudget`) stamps its headers.
      conn = post(conn_with("Bot " <> token), "/api/v10/channels/#{ch_id}/messages", %{"content" => "class probe"})
      assert conn.status == 201
      {send_limit, _window} = Cytale.Config.send_budget().conversation
      assert get_resp_header(conn, "x-ratelimit-limit") == [Integer.to_string(send_limit)]

      conn = post(conn_with("Bot " <> token), "/api/v10/channels/#{ch_id}/typing")
      assert conn.status == 204
      assert get_resp_header(conn, "x-ratelimit-limit") == ["25"]
    end
  end

  # ---------------------------------------------------------------------------
  # 429 shape
  # ---------------------------------------------------------------------------

  describe "429 (deterministically seeded per-bot bucket)" do
    test "exhausted bucket → 429 with retry_after float + Retry-After + Scope: user", %{
      token: token,
      bot_id: bot_id,
      ch_id: ch_id
    } do
      ensure_rate_table()
      template = RateLimit.template("GET", ["api", "v10", "channels", ch_id, "messages"])
      limit = String.to_integer(hd(get_or_seed_limit(token)))

      :ets.insert(@rate_table, {
        {template, {:user, bot_id}},
        limit,
        System.system_time(:millisecond) + 10_000
      })

      conn = get(conn_with("Bot " <> token), "/api/v10/channels/#{ch_id}/messages")
      assert conn.status == 429

      assert %{
               "message" => message,
               "code" => 0,
               "retry_after" => retry_after,
               "global" => false
             } = Jason.decode!(conn.resp_body)

      assert is_binary(message)
      assert is_float(retry_after)
      assert retry_after > 0 and retry_after <= 10.0

      # #90: the message names the limit that tripped (this bot's account
      # bucket) and the retry hint, instead of a bare "slow down".
      assert message =~ "this account"
      assert message =~ "account limit is"
      assert message =~ "Try again in"

      assert [retry_after_hdr] = get_resp_header(conn, "retry-after")
      assert {ra_i, ""} = Integer.parse(retry_after_hdr)
      assert ra_i >= 1

      assert get_resp_header(conn, "x-ratelimit-scope") == ["user"]
      assert get_resp_header(conn, "x-ratelimit-remaining") == ["0"]

      # Cleanup: the seeded key must not poison other suites.
      :ets.delete(@rate_table, {template, {:user, bot_id}})
    end
  end

  # ---------------------------------------------------------------------------
  # Pre-auth IP dam (B2): the flood limiter in FRONT of BotAuth — failed auth
  # is never rate-limited by the per-principal buckets (no principal yet), so
  # an IP-keyed dam answers credential-guessing floods before the token read.
  # ---------------------------------------------------------------------------

  describe "pre-auth IP dam (B2)" do
    @preauth_table :cytale_compat_preauth_rate_limit
    @dam_ip {127, 0, 0, 1}

    test "an IP at its ceiling 429s BEFORE auth (the 401 never renders; Discord shape)" do
      ensure_preauth_table()
      limit = Cytale.Config.compat_preauth_ip_limit()

      # Seed the dam to its ceiling (the pipeline 429 pattern — deterministic
      # without a real 30-request flood through the shared test IP).
      :ets.insert(@preauth_table, {{:ip, @dam_ip}, limit, System.system_time(:millisecond) + 10_000})

      # Even a VALID credential is dammed pre-auth (the dam runs first); a
      # bogus one proves the auth check was never reached: 429, not 401.
      conn = get(conn_with("Bot cytbot_totally-bogus"), "/api/v10/users/@me")
      assert conn.status == 429

      assert %{"code" => 0, "retry_after" => retry_after, "global" => false} = Jason.decode!(conn.resp_body)
      assert is_float(retry_after) and retry_after > 0

      # #90: the dam's 429 says it is a SHARED PER-IP limit, not an account
      # problem — this is the surface where the message must not lie.
      assert %{"message" => message} = Jason.decode!(conn.resp_body)
      assert message =~ "this network"
      assert message =~ "shared by everyone behind this IP"

      assert get_resp_header(conn, "x-ratelimit-scope") == ["user"]
      assert get_resp_header(conn, "x-ratelimit-remaining") == ["0"]

      # Cleanup: the seeded key must not poison other suites.
      :ets.delete(@preauth_table, {:ip, @dam_ip})
    end

    test "under the ceiling the dam is invisible: a bad token still renders the 401 shape" do
      conn = get(conn_with("Bot cytbot_totally-bogus"), "/api/v10/users/@me")
      assert conn.status == 401
      assert Jason.decode!(conn.resp_body) == %{"message" => "401: Unauthorized", "code" => 0}
    end
  end

  # Read the effective limit off a live 200 (one request), so the test never
  # hardcodes the production constant.
  defp get_or_seed_limit(token) do
    probe = get(conn_with("Bot " <> token), "/api/v10/users/@me")
    get_resp_header(probe, "x-ratelimit-limit")
  end

  defp ensure_rate_table do
    if :ets.whereis(@rate_table) == :undefined do
      :ets.new(@rate_table, [:set, :named_table, :public, read_concurrency: true])
    end

    :ok
  end

  defp ensure_preauth_table do
    if :ets.whereis(@preauth_table) == :undefined do
      :ets.new(@preauth_table, [:set, :named_table, :public, read_concurrency: true])
    end

    :ok
  end
end
