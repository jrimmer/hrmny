defmodule Cytale.Gateway.AuthenticatorTest do
  @moduledoc """
  U2 (bots plan) — the composite gateway authenticator's identity contract:

    * `cytbot_` credentials resolve real machine principals into grown
      identities carrying `{kind, parent_id, restrictions}` (KTD2);
    * `cytale_` credentials keep the byte-identical Stub synthetic identity
      (the whole gateway_case corpus rides on this);
    * `Session.new/2` accepts both the old `%{id, username}` shape and the
      grown shape, and the grown record survives a SessionStore round trip
      plus a wire-level Resume with the same token.

  All verification goes through `Cytale.Gateway.Authenticator.verify_token/1`
  — the exact facade the gateway socket calls — so these tests exercise the
  configured composite (test.exs wires impl: Principal, human_impl: Stub)
  rather than any module directly.
  """

  use Cytale.ScyllaCase, async: false
  use Cytale.GatewayCase, async: false

  alias Cytale.Accounts.{Principals, User}
  alias Cytale.Test.AgentGrants
  alias Cytale.Gateway.{Authenticator, Session, SessionStore}
  alias Cytale.Repo

  defp run_unique(base), do: base <> Integer.to_string(System.unique_integer([:positive]))

  # ---------------------------------------------------------------------------
  # Fixtures
  # ---------------------------------------------------------------------------

  defp run_nonce, do: "r" <> Cytale.TestNonce.get()

  defp make_parent(prefix \\ "authtest") do
    {:ok, user} = User.create(run_nonce() <> prefix, run_nonce() <> prefix <> "@example.com", "password-123")
    user
  end

  defp wait_until(fun, tries \\ 50)

  defp wait_until(fun, 0), do: ExUnit.Assertions.flunk("condition not met in time")

  defp wait_until(fun, tries) do
    if fun.(),
      do: :ok,
      else:
        (
          Process.sleep(20)
          wait_until(fun, tries - 1)
        )
  end

  # Xandra execute spans forwarded to the test process — lets the malformed
  # tests assert ZERO storage access for garbage shapes.
  @query_tag :__module_xandra_query__

  setup do
    port = start_gateway!()

    handler_id = {__MODULE__, self()}

    :telemetry.attach_many(
      handler_id,
      [
        [:xandra, :execute_query, :start],
        [:xandra, :prepare_query, :start]
      ],
      &__MODULE__.forward_query_telemetry/4,
      {self(), @query_tag}
    )

    on_exit(fn -> :telemetry.detach(handler_id) end)

    %{port: port}
  end

  def forward_query_telemetry(_event, _measurements, metadata, {pid, tag}) do
    # Isolation (was flaky): Xandra telemetry is VM-global, so a 200ms
    # collect window used to count OTHER modules' concurrent queries. The
    # zero-storage property being pinned is about the AUTH path only, so
    # forward just SELECTs against bot_tokens — the one statement shape
    # Principals.get_by_token/1 issues. Concurrent mints (INSERTs) and any
    # unrelated query no longer count.
    statement = inspect(metadata)

    if String.contains?(statement, "bot_tokens") and String.contains?(statement, "SELECT") do
      send(pid, {tag, :query})
    end
  end

  defp flush_queries, do: collect_queries(0)

  defp collect_queries(timeout_ms) do
    receive do
      {@query_tag, :query} -> collect_queries(timeout_ms) + 1
    after
      timeout_ms -> 0
    end
  end

  # ---------------------------------------------------------------------------
  # Identity contract: cytbot_ → grown machine identity
  # ---------------------------------------------------------------------------

  describe "composite prefix routing: cytbot_" do
    test "resolves the principal into a grown identity (id string, kind/parent/restrictions)" do
      parent = make_parent("gwp")

      {:ok, bot} =
        AgentGrants.mint_all(parent.user_id, :bot, run_unique("Gateway Bot"), %{actions: ["read"], channels: ["123"]})

      parent_id = parent.user_id

      assert {:ok, identity} = Authenticator.verify_token(bot.token)

      # Exact shape: the grown machine identity — nothing more, nothing less.
      assert identity == %{
               id: Integer.to_string(bot.user_id),
               username: bot.username,
               kind: :bot,
               parent_id: parent_id,
               # The legacy column is untouched by a grant; the DOCUMENT is
               # the authority now.
               restrictions: nil,
               access: bot.access
             }
    end

    test "unrestricted principals carry restrictions: nil as a present key" do
      parent = make_parent("gwfree")

      {:ok, agent} = AgentGrants.mint_all(parent.user_id, :agent, run_unique("Free Agent"))

      assert {:ok, identity} = Authenticator.verify_token(agent.token)
      assert identity.restrictions == nil
      assert Map.has_key?(identity, :restrictions)
      assert identity.kind == :bot
    end

    test "revoked (row-deleted) token → {:error, :invalid}" do
      parent = make_parent("gwrev")
      {:ok, bot} = AgentGrants.mint_all(parent.user_id, :webhook, run_unique("Dead Hook"))

      assert {:ok, _} = Authenticator.verify_token(bot.token)

      :ok = Principals.revoke(bot.user_id)

      assert {:error, :invalid} = Authenticator.verify_token(bot.token)
    end

    test "well-formed but unknown cytbot_ token → {:error, :invalid} (storage consulted)" do
      flush_queries()

      # Mint shape (long secret), never issued.
      ghost = "cytbot_" <> String.duplicate("Z", 43)

      assert {:error, :invalid} = Authenticator.verify_token(ghost)
      # The control leg of the no-storage contract below: this DID query.
      assert collect_queries(200) >= 1
    end

    test "a machine principal with nil label falls back to the kind name as username" do
      parent = make_parent("gwnolabel")
      {:ok, bot} = AgentGrants.mint_all(parent.user_id, :bot, run_unique("Labelled Bot"))

      # Data drift: blank the users.display_name the label is read from.
      Repo.execute!(
        "UPDATE #{Repo.keyspace()}.users SET display_name = null WHERE user_id = ?",
        [{"bigint", bot.user_id}]
      )

      assert Principals.get_by_token(bot.token).label == nil

      assert {:ok, identity} = Authenticator.verify_token(bot.token)
      # The label is gone; the TAG is the handle and it survives.
      assert identity.username == bot.username
      assert identity.kind == :bot
    end
  end

  # ---------------------------------------------------------------------------
  # Identity contract: cytale_ → human impl, byte-identical Stub
  # ---------------------------------------------------------------------------

  describe "composite prefix routing: cytale_ (human impl passthrough)" do
    test "stub token binds the same synthetic identity the Stub alone produced" do
      assert {:ok, identity} = Authenticator.verify_token(valid_token())

      # Byte-identical: EXACTLY the Stub's two-key map — the composite must
      # not decorate, rename, or grow the human-path identity.
      assert map_size(identity) == 2
      assert Map.keys(identity) |> Enum.sort() == [:id, :username]
      assert identity.id =~ ~r/^\d+$/
      assert identity.username == "user" <> identity.id
    end

    test "wrong-prefix well-formed token keeps the Stub's {:error, :invalid}" do
      assert {:error, :invalid} = Authenticator.verify_token(invalid_token())
    end

    test "deterministic: the same stub token always binds the same identity" do
      assert {:ok, first} = Authenticator.verify_token(valid_token())
      assert {:ok, second} = Authenticator.verify_token(valid_token())
      assert first == second
    end
  end

  # ---------------------------------------------------------------------------
  # Malformed shapes never touch storage
  # ---------------------------------------------------------------------------

  describe "malformed tokens are rejected before any storage access" do
    test "short cytbot_ garbage → {:error, :malformed} with ZERO queries" do
      flush_queries()

      assert {:error, :malformed} = Authenticator.verify_token("cytbot_short")
      assert {:error, :malformed} = Authenticator.verify_token("cytbot_" <> String.duplicate("x", 10))
      assert collect_queries(200) == 0
    end

    test "short / non-string garbage → {:error, :malformed} with ZERO queries" do
      flush_queries()

      assert {:error, :malformed} = Authenticator.verify_token("nope")
      assert {:error, :malformed} = Authenticator.verify_token("")
      assert {:error, :malformed} = Authenticator.verify_token(:not_a_string)
      assert {:error, :malformed} = Authenticator.verify_token(nil)

      assert collect_queries(200) == 0
    end
  end

  # ---------------------------------------------------------------------------
  # Session.new dual-shape contract
  # ---------------------------------------------------------------------------

  describe "Session.new/2 identity projection" do
    test "old-shaped %{id, username} maps project byte-identically" do
      old_user = %{id: "42", username: "janet"}

      assert %Session{user: user} = Session.new(old_user, now_ms: 1_000)
      assert user == old_user
    end

    test "grown maps carry kind/parent_id/restrictions (nil values preserved)" do
      grown = %{
        id: "77",
        username: "Session Bot",
        kind: :agent,
        parent_id: 5,
        restrictions: nil
      }

      assert %Session{user: user} = Session.new(grown, now_ms: 1_000)
      assert user == grown
    end
  end

  # ---------------------------------------------------------------------------
  # SessionStore round trip + wire Resume with a cytbot_ token
  # ---------------------------------------------------------------------------

  describe "grown identity survives SessionStore and wire Resume" do
    test "put → get round trip preserves the grown user map" do
      identity = %{
        id: "901",
        username: "Store Bot",
        kind: :bot,
        parent_id: 7,
        restrictions: %{"actions" => ["read"]}
      }

      session = Session.new(identity, now_ms: 1_000)
      assert {:ok, _} = SessionStore.put(session)

      assert %Session{} = fetched = SessionStore.get(session.session_id)
      assert fetched.user == identity

      :ok = SessionStore.delete(session.session_id)
    end

    test "Identify with cytbot_ mints a compat session (U7/KTD5); Resume with the same token re-authenticates",
         %{port: port} do
      parent = make_parent("wire")
      {:ok, bot} = AgentGrants.mint_all(parent.user_id, :bot, run_unique("Wire Bot"), %{actions: ["read"]})

      conn1 = connect!(port)
      ready = identify!(conn1, bot.token)

      sid = ready["session_id"]
      parent_id = parent.user_id

      # The stored session record carries the grown machine identity.
      assert %Session{user: user} = SessionStore.get(sid)

      assert user == %{
               id: Integer.to_string(bot.user_id),
               username: bot.username,
               kind: :bot,
               parent_id: parent_id,
               restrictions: nil,
               access: bot.access
             }

      assert ready["user"]["id"] == Integer.to_string(bot.user_id)
      # The READY user object carries the credential's TAG, not the label.
      assert ready["user"]["username"] == bot.username

      # Drop the socket; the record survives for the resume window.
      Cytale.Test.WSClient.stop(conn1.pid)

      wait_until(fn -> match?(%Session{phase: :disconnected}, SessionStore.get(sid)) end)

      # Fresh connection, Resume with the SAME cytbot_ credential. (The
      # compat READY is Discord-shaped — the single-use resume_token lives
      # on the stored record, not on the wire payload.)
      stored = SessionStore.get(sid)

      conn2 = connect!(port, v: 10)

      send_frame!(conn2, 5, %{
        "token" => bot.token,
        "session_id" => sid,
        "seq" => 0,
        "resume_token" => stored.resume_token
      })

      resumed = next_json!(conn2, 5_000)
      assert resumed["op"] == 0 and resumed["t"] == "RESUMED"

      # The adopted (round-tripped) record still binds the machine identity.
      assert %Session{user: adopted} = SessionStore.get(sid)
      assert adopted.kind == :bot
      assert adopted.parent_id == parent.user_id
      # The legacy column is untouched by a grant (the document is the
      # authority); what a resume must re-derive is the identity as it is now.
      assert adopted.restrictions == nil

      Cytale.Test.WSClient.stop(conn2.pid)
    end

    test "Identify with a revoked cytbot_ token → auth-failed close 4004", %{port: port} do
      parent = make_parent("wirerev")
      {:ok, bot} = AgentGrants.mint_all(parent.user_id, :agent, run_unique("Dead Agent"))
      :ok = Principals.revoke(bot.user_id)

      conn = connect!(port)

      send_frame!(conn, 2, %{
        "token" => bot.token,
        "v" => 1,
        "compress" => nil,
        "properties" => %{"os" => "test", "browser" => "authenticator_test", "device" => "test"}
      })

      # {:error, :invalid} — no InvalidSession frame, plain auth-failed close.
      code = assert_closed!(conn, 5_000)
      assert code == 4004
    end
  end
end
