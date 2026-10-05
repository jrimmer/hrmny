defmodule Cytale.WorkspacesTest do
  @moduledoc """
  U5 (bots plan) — roster/people synthesis + presence routing at the context
  layer. The merge principle's roster claim (R4/R6): a member's machine
  principals appear beside them carrying `kind` + `parent_user_id`, a
  principal belongs exactly where its PARENT is a member (R1), and
  `workspaces_of_user/1` (the gateway's join_fanout_routes / presence index)
  resolves principals through the parent. Invariant under test throughout:
  machine principals NEVER carry workspace_members / workspaces_of_user rows
  of their own.
  """

  use Cytale.ScyllaCase, async: false

  alias Cytale.Accounts.{Principals, User}
  alias Cytale.Test.AgentGrants
  alias Cytale.Repo
  alias Cytale.Workspaces

  defp run_nonce, do: "r" <> Cytale.TestNonce.get()
  defp run_unique(base), do: base <> run_nonce()

  defp human(base) do
    {:ok, user} = User.create(run_unique(base), run_unique(base <> "@example.com"), "password-123")
    user
  end

  defp workspace_ids(user_id), do: MapSet.new(Workspaces.workspaces_of_user(user_id), & &1.workspace_id)

  defp table_rows(table, where_cols) do
    {stmt, params} =
      where_cols
      |> Enum.map(fn {col, value} -> {"#{col} = ?", {"bigint", value}} end)
      |> Enum.unzip()

    Repo.execute!(
      "SELECT * FROM #{Repo.keyspace()}.#{table} WHERE " <> Enum.join(stmt, " AND "),
      params
    )
    |> Enum.to_list()
  end

  # `workspaces_by_name` is the name-uniqueness index. It has no reader — it is an
  # enforcement index, not a lookup — so the only way to observe it is directly.
  defp name_claim(name_lower) do
    Repo.execute!(
      "SELECT workspace_id FROM #{Repo.keyspace()}.workspaces_by_name WHERE name_lower = ?",
      [{"text", name_lower}]
    )
    |> Enum.to_list()
  end

  # There is no index on `workspaces.name`, so finding rows by name is a full
  # scan — through `stream_rows!` so the assertion cannot be fooled by a 10k-row
  # page boundary.
  defp workspaces_named(name) do
    "SELECT workspace_id, name FROM #{Repo.keyspace()}.workspaces"
    |> Repo.stream_rows!()
    |> Enum.filter(&(&1["name"] == name))
    |> Enum.map(& &1["workspace_id"])
  end

  describe "roster synthesis (list_members include_principals)" do
    test "a member's machine credentials appear beside them with kind + parent_user_id" do
      owner = human("roster_owner")
      {:ok, ws} = Workspaces.create_workspace(owner.user_id, run_unique("roster-ws"))

      {:ok, %{user_id: bot_id}} = AgentGrants.mint_all(owner.user_id, :bot, "Deploy Bot")
      {:ok, %{user_id: agent_id}} = AgentGrants.mint_all(owner.user_id, :agent, "Ops Agent")
      owner_id = owner.user_id

      # Human row first, then that parent's principals (the parent's row group).
      assert [
               %{kind: :human, user_id: ^owner_id, parent_user_id: nil, username: owner_username},
               # One internal kind (`:bot`); the UI's word for both is Agent.
               # `username` here is the credential's TAG (derived from its
               # label), because the roster carries the handle a person can
               # reference — the label is the display name.
               %{
                 kind: :bot,
                 user_id: ^bot_id,
                 parent_user_id: ^owner_id,
                 username: "deploy-bot",
                 display_name: "Deploy Bot",
                 # Its per-workspace nickname (#169): unset.
                 nickname: nil,
                 avatar_url: nil,
                 roles: []
               },
               %{
                 kind: :bot,
                 user_id: ^agent_id,
                 parent_user_id: ^owner_id,
                 username: "ops-agent",
                 display_name: "Ops Agent",
                 nickname: nil,
                 avatar_url: nil,
                 roles: []
               }
             ] = Workspaces.list_members(ws.workspace_id, include_principals: true)

      assert owner_username == owner.username
    end

    test "a principal appears exactly where its parent is a member (R1)" do
      parent = human("multi_parent")
      other = human("multi_other")

      {:ok, ws1} = Workspaces.create_workspace(parent.user_id, run_unique("parent-ws"))
      {:ok, ws2} = Workspaces.create_workspace(other.user_id, run_unique("other-ws"))

      {:ok, %{user_id: agent_id}} = AgentGrants.mint_all(parent.user_id, :agent, run_unique("Scoped Agent"))

      in_ws = fn ws_id ->
        Workspaces.list_members(ws_id, include_principals: true)
        |> Enum.any?(&(&1.user_id == agent_id))
      end

      # Parent is a member of ws1 only: the agent rides that membership alone.
      assert in_ws.(ws1.workspace_id)
      refute in_ws.(ws2.workspace_id)

      # Parent joins ws2 → the agent belongs there too (both rosters).
      :ok = Workspaces.add_member(ws2.workspace_id, parent.user_id, other.user_id)
      assert in_ws.(ws1.workspace_id)
      assert in_ws.(ws2.workspace_id)
    end

    test "limit bounds the HUMAN page; synthesis is additive on top of it" do
      owner = human("limit_owner")
      joiner = human("limit_joiner")

      {:ok, ws} = Workspaces.create_workspace(owner.user_id, run_unique("limit-ws"))
      :ok = Workspaces.add_member(ws.workspace_id, joiner.user_id, owner.user_id)
      {:ok, %{user_id: bot_id}} = AgentGrants.mint_all(joiner.user_id, :bot, "Joiner Bot")

      # limit 1 selects ONE human row (joiner — user_id DESC); its bot rides
      # along without consuming page budget.
      page = Workspaces.list_members(ws.workspace_id, limit: 1, include_principals: true)
      assert [%{kind: :human, user_id: joiner_id}, %{kind: :bot, user_id: ^bot_id}] = page
      assert joiner_id == joiner.user_id
    end

    test "default page stays human-only (pagination/count callers)" do
      owner = human("plain_owner")
      {:ok, ws} = Workspaces.create_workspace(owner.user_id, run_unique("plain-ws"))
      {:ok, %{user_id: bot_id}} = AgentGrants.mint_all(owner.user_id, :bot, "Unlisted Bot")

      assert [%{kind: :human, user_id: owner_id, parent_user_id: nil}] =
               Workspaces.list_members(ws.workspace_id)

      assert owner_id == owner.user_id
      assert Workspaces.list_members(ws.workspace_id) |> Enum.map(& &1.user_id) == [owner.user_id]
      refute bot_id in Enum.map(Workspaces.list_members(ws.workspace_id), & &1.user_id)
    end

    # PERF-5 (B5): a 50-member page's synthesis is BATCHED — bounded query
    # count (≤ ~6 total incl. the base member page), not per-member reads.
    test "a credential that holds nothing here is NOT in this workspace's roster (R12)" do
      parent = human("grant_parent")
      {:ok, ws} = Workspaces.create_workspace(parent.user_id, run_unique("grant-ws"))

      # Minted with no grant (the default): the parent is a member, so the
      # child row is in the page — but the credential reaches nothing here, and
      # the roster is about who holds something in THIS workspace.
      {:ok, bot} = Principals.mint(parent.user_id, :bot, "Dark Bot", nil)

      listed = fn ->
        Workspaces.list_members(ws.workspace_id, include_principals: true)
        |> Enum.any?(&(&1.user_id == bot.user_id))
      end

      refute listed.()

      # Granted for this workspace → listed, like any member.
      document =
        Cytale.Access.parse!(%{
          "v" => 1,
          "workspaces" => %{
            "mode" => "custom",
            "grants" => %{Integer.to_string(ws.workspace_id) => %{"level" => "read"}}
          }
        })

      :ok = Principals.update_access(bot.user_id, document)
      assert listed.()

      # And `All(<level>)` reaches it too, which is the cascade the tree's root
      # expresses — same rule, no special case.
      :ok =
        Principals.update_access(
          bot.user_id,
          Cytale.Access.parse!(%{"v" => 1, "workspaces" => %{"mode" => "all", "level" => "read"}})
        )

      assert listed.()
    end

    test "a 50-member page synthesizes within a bounded query count (page-level batch)" do
      owner = human("batch_owner")
      {:ok, ws} = Workspaces.create_workspace(owner.user_id, run_unique("batch-ws"))

      # 49 joiners (50 humans with the owner); principals on a few parents.
      joiners = for i <- 1..49, do: human("batch_joiner#{i}")

      for joiner <- joiners do
        :ok = Workspaces.add_member(ws.workspace_id, joiner.user_id, owner.user_id)
      end

      {:ok, %{user_id: bot_id}} = AgentGrants.mint_all(owner.user_id, :bot, "Batch Bot")
      {:ok, %{user_id: agent_id}} = AgentGrants.mint_all(hd(joiners).user_id, :agent, "Batch Agent")

      {roster, query_count} =
        count_queries(fn ->
          Workspaces.list_members(ws.workspace_id, limit: 50, include_principals: true)
        end)

      # Shape + order: 50 humans user_id desc, each parent's machine
      # principals right after their parent (principal_id ascending).
      assert length(roster) == 52
      assert Enum.count(roster, &(&1.kind == :human)) == 50
      assert Enum.count(roster, &(&1.kind == :bot)) == 2

      human_ids = roster |> Enum.filter(&(&1.kind == :human)) |> Enum.map(& &1.user_id)
      assert human_ids == Enum.sort_by(human_ids, &(-&1))

      bot_i = Enum.find_index(roster, &(&1.user_id == bot_id))
      bot_neighbors = [Enum.at(roster, bot_i - 1), Enum.at(roster, bot_i + 1)] |> Enum.reject(&is_nil/1)
      assert owner.user_id in Enum.map(bot_neighbors, & &1.user_id)

      agent_i = Enum.find_index(roster, &(&1.user_id == agent_id))
      assert Enum.at(roster, agent_i - 1).user_id == hd(joiners).user_id

      # THE assertion: the whole page (members read + subs IN + principals
      # IN + label users IN + human users IN + the machines' nicknames IN,
      # #169) stayed bounded — the former per-member shape was
      # 1 + 50×(3 + 1) ≈ 201.
      assert query_count <= 7
    end

    # Count EVERY xandra query while `fun` runs (the repo's telemetry-count
    # pattern over Xandra's query telemetry; the handler runs synchronously
    # in the emitting process, so the count is exact when `fun` returns).
    defp count_queries(fun) do
      parent = self()
      ref = make_ref()
      handler_id = "workspaces-test-queries-#{System.unique_integer([:positive])}"

      :ok =
        :telemetry.attach(
          handler_id,
          [:xandra, :execute_query, :start],
          fn _event, _measurements, _metadata, ^parent -> send(parent, {:query, ref}) end,
          parent
        )

      result = fun.()

      count = drain_queries(ref)
      :ok = :telemetry.detach(handler_id)
      {result, count}
    end

    defp drain_queries(ref, acc \\ 0) do
      receive do
        {:query, ^ref} -> drain_queries(ref, acc + 1)
      after
        0 -> acc
      end
    end
  end

  describe "the no-membership-rows invariant" do
    test "listing (and joining parent workspaces) never writes rows for principals" do
      parent = human("invariant_parent")
      other = human("invariant_other")

      {:ok, ws1} = Workspaces.create_workspace(parent.user_id, run_unique("inv-ws1"))
      {:ok, ws2} = Workspaces.create_workspace(other.user_id, run_unique("inv-ws2"))

      {:ok, %{user_id: bot_id}} = AgentGrants.mint_all(parent.user_id, :bot, "Invariant Bot")
      {:ok, %{user_id: agent_id}} = AgentGrants.mint_all(parent.user_id, :agent, "Invariant Agent")

      # Exercise every synthesis path: roster reads, the parent joining a new
      # workspace, and the principal-resolved workspace index.
      _ = Workspaces.list_members(ws1.workspace_id, include_principals: true)
      :ok = Workspaces.add_member(ws2.workspace_id, parent.user_id, other.user_id)
      _ = Workspaces.workspaces_of_user(bot_id)
      _ = Workspaces.workspaces_of_user(agent_id)

      for principal_id <- [bot_id, agent_id] do
        assert Workspaces.get_member(ws1.workspace_id, principal_id) == nil
        assert Workspaces.get_member(ws2.workspace_id, principal_id) == nil
        assert table_rows("workspace_members", workspace_id: ws1.workspace_id, user_id: principal_id) == []
        assert table_rows("workspace_members", workspace_id: ws2.workspace_id, user_id: principal_id) == []
        assert table_rows("workspaces_of_user", user_id: principal_id) == []
      end
    end
  end

  describe "workspaces_of_user/1 (presence/fan-out index)" do
    test "a machine principal resolves through its parent's memberships" do
      parent = human("route_parent")
      other = human("route_other")

      {:ok, ws1} = Workspaces.create_workspace(parent.user_id, run_unique("route-ws1"))
      {:ok, ws2} = Workspaces.create_workspace(other.user_id, run_unique("route-ws2"))
      :ok = Workspaces.add_member(ws2.workspace_id, parent.user_id, other.user_id)

      {:ok, %{user_id: agent_id}} = AgentGrants.mint_all(parent.user_id, :agent, "Routing Agent")
      {:ok, %{user_id: bot_id}} = AgentGrants.mint_all(parent.user_id, :bot, "Routing Bot")

      expected = MapSet.new([ws1.workspace_id, ws2.workspace_id])

      # Principals see exactly the parent's workspaces — the index the
      # gateway's join_fanout_routes + presence announce consume.
      assert workspace_ids(agent_id) == expected
      assert workspace_ids(bot_id) == expected
      assert workspace_ids(parent.user_id) == expected
    end

    test "cost is one read per USER, not one per membership (hardening plan 5.8)" do
      # The gateway's join/presence path calls this for every Identify, and it
      # used to issue one `get_workspace/1` per membership: a member of N
      # workspaces paid N+1 round trips. `IN ?` on the workspace_id key makes it
      # two — the index read and ONE batch — and this asserts the INVARIANCE, not
      # the shape: the count does not move when the membership count does.
      user = human("batch_ws")
      owner = human("batch_ws_owner")

      {:ok, first} = Workspaces.create_workspace(owner.user_id, run_unique("batch-ws-0"))
      :ok = Workspaces.add_member(first.workspace_id, user.user_id, owner.user_id)

      {ids_one, queries_one} = count_queries(fn -> Workspaces.workspaces_of_user(user.user_id) end)
      assert length(ids_one) == 1

      for i <- 1..4 do
        {:ok, ws} = Workspaces.create_workspace(owner.user_id, run_unique("batch-ws-#{i}"))
        :ok = Workspaces.add_member(ws.workspace_id, user.user_id, owner.user_id)
      end

      {ids_five, queries_five} = count_queries(fn -> Workspaces.workspaces_of_user(user.user_id) end)
      assert length(ids_five) == 5

      # THREE, not two: the principal lookup (`membership_owner_id/1`, which
      # decides whether a machine principal resolves through its parent), the
      # membership index, and the batch. What matters is that the number is the
      # same for one membership and for five.
      assert queries_one == queries_five,
             "the membership read scaled with memberships: #{queries_one} → #{queries_five}"

      assert queries_five <= 3, "the batched read grew past its three fixed statements: #{queries_five}"

      # The rows still carry what callers read off them.
      assert Enum.all?(ids_five, &(is_binary(&1.name) and is_integer(&1.workspace_id)))
    end

    test "a human with no principal row is unchanged (nil principals.get)" do
      parent = human("plain_route")
      {:ok, ws} = Workspaces.create_workspace(parent.user_id, run_unique("plain-route-ws"))
      assert workspace_ids(parent.user_id) == MapSet.new([ws.workspace_id])
    end
  end

  describe "notification audience size (hardening plan 1.2)" do
    test "list_member_ids/1 is uncapped where list_members/1 is a 50-row page" do
      owner = human("audience_owner")
      {:ok, ws} = Workspaces.create_workspace(owner.user_id, run_unique("audience-ws"))

      # Synthetic members: `list_member_ids/1` reads only workspace_members, so
      # these need no users rows. Creating 55 real accounts would spend the
      # test's time in argon2 rather than in the query under test.
      ids = for i <- 1..55, do: 9_200_000_000_000_000 + i

      for uid <- ids do
        Repo.execute!(
          "INSERT INTO #{Repo.keyspace()}.workspace_members " <>
            "(workspace_id, user_id, nickname, joined_at, roles) VALUES (?, ?, ?, ?, ?)",
          [
            {"bigint", ws.workspace_id},
            {"bigint", uid},
            {"text", nil},
            {"timestamp", DateTime.utc_now()},
            {"list<bigint>", []}
          ]
        )
      end

      returned = Workspaces.list_member_ids(ws.workspace_id)

      # The audience is every member, not a page of them. Before the fix this
      # list came from `list_members/1`, whose default limit is 50, so in any
      # workspace larger than that nobody beyond the 50 highest user_ids was
      # ever pushed to — silently, since the fan-out telemetry counts
      # deliveries rather than members skipped.
      assert Enum.all?(ids, &(&1 in returned)),
             "audience lost members: #{length(returned)} returned for 55 inserted"

      assert length(returned) > 50

      # The page reader still pages — the two must not be conflated again.
      assert length(Workspaces.list_members(ws.workspace_id)) == 50
    end
  end

  describe "instance-wide workspace name claim (hardening plan 4.11 / O2)" do
    test "a duplicate name is refused, case-insensitively, and the claim names the winner's real id" do
      winner = human("claim_winner")
      loser = human("claim_loser")
      name = run_unique("Claim-Ws")

      assert {:ok, ws} = Workspaces.create_workspace(winner.user_id, name)

      # Case-insensitive: the claim key is the downcased name, so a differently
      # cased duplicate is the same name.
      assert {:error, :name_taken} =
               Workspaces.create_workspace(loser.user_id, String.upcase(name))

      # The claim carries the REAL workspace id. It used to be seeded with a
      # throwaway snowflake and corrected by a second write, which is what made a
      # crash between the two permanently claim a name that no workspace held.
      assert [%{"workspace_id" => claimed}] = name_claim(String.downcase(name))
      assert claimed == ws.workspace_id

      # The loser wrote nothing at all — no workspace row under the contested
      # name, and no membership anywhere.
      assert workspaces_named(name) == [ws.workspace_id]
      assert Workspaces.workspaces_of_user(loser.user_id) == []
    end

    test "a rename moves the claim: the old name is freed and a taken name is refused" do
      a = human("rename_a")
      b = human("rename_b")
      old_name = run_unique("Rename-Old")
      taken_name = run_unique("Rename-Taken")
      new_name = run_unique("Rename-New")

      assert {:ok, ws_a} = Workspaces.create_workspace(a.user_id, old_name)
      assert {:ok, ws_b} = Workspaces.create_workspace(b.user_id, taken_name)

      # Refused BEFORE anything moves: neither the display name nor either claim
      # changes. (This is the case the old bare UPDATE got wrong from the other
      # side: it renamed onto a taken name without a word.)
      assert {:error, :name_taken} = Workspaces.rename_workspace(ws_a.workspace_id, taken_name)
      assert Workspaces.get_workspace(ws_a.workspace_id).name == old_name
      assert name_claim(String.downcase(old_name)) == [%{"workspace_id" => ws_a.workspace_id}]
      assert name_claim(String.downcase(taken_name)) == [%{"workspace_id" => ws_b.workspace_id}]

      assert :ok = Workspaces.rename_workspace(ws_a.workspace_id, new_name)
      assert name_claim(String.downcase(new_name)) == [%{"workspace_id" => ws_a.workspace_id}]

      # The old name is released, which is the half the old code never did — it
      # left the claim behind, so the name was blocked forever by a workspace
      # that no longer answered to it.
      assert name_claim(String.downcase(old_name)) == []

      # ...and immediately reusable, with the claim pointing at its new holder.
      assert {:ok, reused} = Workspaces.create_workspace(b.user_id, old_name)
      assert name_claim(String.downcase(old_name)) == [%{"workspace_id" => reused.workspace_id}]
    end

    test "a case-only rename does not collide with its own claim" do
      owner = human("case_only")
      name = run_unique("Case-Ws")
      assert {:ok, ws} = Workspaces.create_workspace(owner.user_id, name)

      # Same claim key: the LWT would report `:error` against this workspace's own
      # row, so the rename must skip the claim entirely rather than report a
      # phantom "name taken".
      assert :ok = Workspaces.rename_workspace(ws.workspace_id, String.upcase(name))
      assert Workspaces.get_workspace(ws.workspace_id).name == String.upcase(name)
      assert name_claim(String.downcase(name)) == [%{"workspace_id" => ws.workspace_id}]
    end

    test "a create that fails after the claim leaves no phantom claim and no orphan row" do
      name = run_unique("Phantom-Ws")

      # A nil owner puts the failure exactly where the plan cares about: NULL is
      # legal for `workspaces.owner_id` (a regular column, so the workspace row IS
      # written) and illegal for `workspace_members.user_id` (a clustering key, so
      # the member insert is what raises).
      assert_raise Xandra.Error, fn -> Workspaces.create_workspace(nil, name) end

      # No phantom: the claim is gone rather than held by a workspace that never
      # existed...
      assert name_claim(String.downcase(name)) == []

      # ...and so is the workspace row written before the failure. Releasing only
      # the claim would put the NAME back on the market while an invisible
      # workspace kept it — two workspaces under one name.
      assert workspaces_named(name) == []

      # The name is immediately usable, with the claim pointing at the real
      # (second) attempt.
      owner = human("phantom_owner")
      assert {:ok, ws} = Workspaces.create_workspace(owner.user_id, name)
      assert name_claim(String.downcase(name)) == [%{"workspace_id" => ws.workspace_id}]
    end

    # The claim's release is CONDITIONAL on the id it holds, which is what lets the
    # errored-LWT path clean up after itself without ever deleting another
    # workspace's claim. Exercised directly because the LWT error it guards against
    # (a write timeout on a statement that may have applied) cannot be produced
    # from a test.
    test "the conditional claim release only gives back a claim holding our own id" do
      mine = Cytale.Snowflake.next()
      theirs = Cytale.Snowflake.next()
      name = run_unique("Claim-Release")
      key = String.downcase(name)

      assert {:ok, _} = Workspaces.create_workspace(human("release_a").user_id, name)
      [%{"workspace_id" => holder}] = name_claim(key)

      # A stranger's claim: neither conditional release may touch it.
      assert :ok = Workspaces.release_workspace_name_if_ours(key, theirs)
      assert name_claim(key) == [%{"workspace_id" => holder}]

      # Our own claim, unclaimed by anyone else: the release takes it back, and the
      # name is free again.
      assert :ok = Workspaces.release_workspace_name_if_ours(key, mine)
      assert name_claim(key) == [%{"workspace_id" => holder}]

      # And the row's actual holder does release it.
      assert :ok = Workspaces.release_workspace_name_if_ours(key, holder)
      assert name_claim(key) == []
    end
  end

  describe "invite use_count is an atomic reservation (hardening plan 4.3)" do
    test "N parallel accepts each consume exactly one use" do
      owner = human("inv_owner")
      {:ok, ws} = Workspaces.create_workspace(owner.user_id, run_unique("Invite WS"))
      {:ok, invite} = Workspaces.create_invite(ws.workspace_id, owner.user_id, max_uses: 0)

      joiners = for _ <- 1..8, do: human("joiner")

      results =
        joiners
        |> Task.async_stream(
          fn u -> Workspaces.accept_invite(invite.invite_code, u.user_id) end,
          max_concurrency: 8,
          timeout: 60_000
        )
        |> Enum.map(fn {:ok, result} -> result end)

      assert Enum.all?(results, &match?({:ok, _}, &1))
      assert invite_use_count(invite.invite_code) == 8

      members = Workspaces.list_members(ws.workspace_id) |> Enum.map(& &1.user_id)
      for joiner <- joiners, do: assert(joiner.user_id in members)
    end

    test "max_uses is never exceeded under concurrency" do
      # The lost update was also a GATE failure: every accept read the same
      # `use_count` and wrote the same `+ 1`, so three seats admitted every
      # caller who arrived at once. The conditional write re-reads on conflict and
      # `get_invite/1` refuses an exhausted invite, so the seat count holds.
      owner = human("cap_owner")
      {:ok, ws} = Workspaces.create_workspace(owner.user_id, run_unique("Capped WS"))
      {:ok, invite} = Workspaces.create_invite(ws.workspace_id, owner.user_id, max_uses: 3)

      joiners = for _ <- 1..8, do: human("capped")

      results =
        joiners
        |> Task.async_stream(
          fn u -> Workspaces.accept_invite(invite.invite_code, u.user_id) end,
          max_concurrency: 8,
          timeout: 60_000
        )
        |> Enum.map(fn {:ok, result} -> result end)

      assert Enum.count(results, &match?({:ok, _}, &1)) == 3
      assert Enum.count(results, &(&1 == {:error, :invalid_invite})) == 5
      assert invite_use_count(invite.invite_code) == 3

      members = Workspaces.list_members(ws.workspace_id) |> Enum.map(& &1.user_id)

      admitted =
        joiners
        |> Enum.zip(results)
        |> Enum.filter(fn {_u, result} -> match?({:ok, _}, result) end)
        |> Enum.map(fn {u, _} -> u.user_id end)

      assert Enum.sort(admitted) == Enum.sort(members -- [owner.user_id])
    end
  end

  describe "role grants survive a concurrent revoke (hardening plan 4.3)" do
    test "a grant racing a revoke is not dropped by a whole-list rewrite" do
      # The `roles` collection used to be read, recomputed and written back, so a
      # revoke that read `[r1]` wrote `[]` after a concurrent grant had already
      # put `r2` there — the grant vanished with no error. `roles = roles + ?` and
      # `roles = roles - ?` merge IN the database instead, so the two writes
      # compose. This drives both at once, repeatedly, and asserts every granted
      # role survives.
      owner = human("role_owner")
      {:ok, ws} = Workspaces.create_workspace(owner.user_id, run_unique("Role WS"))
      member = human("role_member")
      :ok = Workspaces.add_member(ws.workspace_id, member.user_id, owner.user_id)

      {:ok, revoked} = Workspaces.create_role(ws.workspace_id, run_unique("revoked"))
      :ok = Workspaces.grant_role(ws.workspace_id, member.user_id, revoked.role_id)

      granted = for i <- 1..6, do: elem(Workspaces.create_role(ws.workspace_id, run_unique("kept#{i}")), 1)

      results =
        ([fn -> Workspaces.revoke_role(ws.workspace_id, member.user_id, revoked.role_id) end] ++
           Enum.map(granted, fn role ->
             fn -> Workspaces.grant_role(ws.workspace_id, member.user_id, role.role_id) end
           end))
        |> Task.async_stream(fn fun -> fun.() end, max_concurrency: 7, timeout: 60_000)
        |> Enum.map(fn {:ok, result} -> result end)

      assert Enum.all?(results, &(&1 == :ok))

      roles = Workspaces.get_member(ws.workspace_id, member.user_id).roles || []

      for role <- granted do
        assert role.role_id in roles, "a concurrent grant of #{role.role_id} was lost"
      end

      refute revoked.role_id in roles
    end
  end

  defp invite_use_count(code) do
    Repo.execute!(
      "SELECT use_count FROM #{Repo.keyspace()}.invites WHERE invite_code = ?",
      [{"text", code}]
    )
    |> Enum.to_list()
    |> case do
      [%{"use_count" => count}] -> count
      other -> flunk("no invite row for #{code}: #{inspect(other)}")
    end
  end
end
