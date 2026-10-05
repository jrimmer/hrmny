defmodule Cytale.Permissions.PrincipalTest do
  @moduledoc """
  U3 (bots plan, KTD3) — the principal-rights resolver: humans keep the
  permission plug's exact oracle (owner → all bits; member → 8-step evaluate
  over the @everyone base + held roles + channel overwrites; 404-vs-403
  semantics), while machine principals resolve through the parent
  (owner-exempt via the parent, then the restrictions intersection: action
  mask + channel allowlist). Everything is re-evaluated on every check (R1 —
  no cache to clear), and every failure mode is fail-closed.
  """

  use Cytale.ScyllaCase, async: false

  alias Cytale.Accounts.{Principals, User}
  alias Cytale.Test.AgentGrants
  alias Cytale.Permissions.Bitfield
  alias Cytale.Permissions.Principal
  alias Cytale.Workspaces

  # make_ref() makes every nonce call-unique: the time-only nonce used
  # elsewhere in the suite can collide when two setups land in the same
  # time bucket (the documented house flake) — never contribute to it.
  defp run_nonce, do: "r" <> Cytale.TestNonce.get()
  defp run_unique(base), do: base <> run_nonce()

  defp make_user(prefix) do
    {:ok, user} = User.create(run_unique(prefix), run_unique(prefix <> "@example.com"), "password-123")
    user
  end

  # Claims shaped exactly like the U2 auth plug's current_user maps.
  defp human_claims(user) do
    %{
      user_id: user.user_id,
      username: user.username,
      verified: true,
      kind: :human,
      parent_user_id: nil,
      restrictions: nil
    }
  end

  defp machine_claims(principal) do
    %{
      user_id: principal.user_id,
      username: principal.label,
      verified: true,
      kind: principal.kind,
      parent_user_id: principal.parent_user_id,
      restrictions: principal.restrictions,
      # The resolver's authority for a machine principal: claims must mirror the
      # row's document (an absent one is no access, never "unrestricted").
      access: principal.access
    }
  end

  # Owner + member-parent workspace with two channels.
  defp seed_workspace do
    owner = make_user("pr_owner")
    {:ok, ws} = Workspaces.create_workspace(owner.user_id, run_unique("Resolve WS"))
    {:ok, ch1} = Workspaces.create_channel(ws.workspace_id, run_unique("one"))
    {:ok, ch2} = Workspaces.create_channel(ws.workspace_id, run_unique("two"))
    parent = make_user("pr_parent")
    :ok = Workspaces.add_member(ws.workspace_id, parent.user_id, owner.user_id, [])

    %{
      owner: owner,
      parent: parent,
      ws_id: ws.workspace_id,
      ch1: ch1.channel_id,
      ch2: ch2.channel_id
    }
  end

  describe "the access document reaches the resolver (agent model U2)" do
    test "a granted agent resolves to its granted level, intersected with its owner" do
      %{owner: owner, ws_id: ws_id, ch1: ch1, ch2: ch2} = seed_workspace()
      # The OWNER parents this agent, so the ceiling is everything — whatever is
      # missing below is missing because the LEVEL does not grant it.
      {:ok, agent} = AgentGrants.mint_all(owner.user_id, :agent, run_unique("Granted Agent"))

      # On the row…
      assert %{workspaces: %{mode: :all, level: :read_write}} = Principals.get(agent.user_id).access

      # …on the claims (what every surface hands the resolver)…
      claims = machine_claims(agent)
      assert claims.access.workspaces.mode == :all

      # …and in the resolved bits: read/write yes, management never.
      assert {:ok, bits} = Principal.resolve(ws_id, claims, ch1)
      assert Bitfield.has?(bits, :view_channel)
      assert Bitfield.has?(bits, :send_messages)
      assert Bitfield.has?(bits, :add_reactions)
      assert Bitfield.has?(bits, :create_threads)
      refute Bitfield.has?(bits, :manage_channels)
      refute Bitfield.has?(bits, :kick_members)

      # An ungranted agent gets NOTHING, anywhere — the fail-closed default.
      {:ok, bare} = Principals.mint(owner.user_id, :agent, run_unique("Ungranted Agent"))
      bare_claims = machine_claims(Principals.get(bare.user_id))
      assert {:ok, 0} = Principal.resolve(ws_id, bare_claims, ch2)
    end
  end

  # KTD3's normative action → bit mapping.
  defp read_bits do
    Bitfield.bit(:view_channel)
    |> Bitfield.bor(Bitfield.bit(:read_message_history))
    |> Bitfield.bor(Bitfield.bit(:add_reactions))
  end

  defp post_bits do
    Bitfield.bit(:send_messages)
    |> Bitfield.bor(Bitfield.bit(:upload_attachments))
  end

  # The @everyone base: view + send + start_call (voice plan U3, KTD7 —
  # START_CALL default-on is a resolve-time default in load_member_roles,
  # not an @everyone roles row) + send_video + share_screen (calls V2 plan
  # U2, R13/VM7 — same resolve-time precedent, no data fix).
  defp everyone_base,
    do:
      Enum.reduce(
        [
          :view_channel,
          :send_messages,
          :add_reactions,
          :start_call,
          :send_video,
          :share_screen,
          :change_nickname
        ],
        0,
        &Bitfield.bor(Bitfield.bit(&1), &2)
      )

  # A role whose grants raise the member from the @everyone base to EXACTLY
  # the five read+post bits (so restriction losses are observable bit-exact).
  defp grant_five_bit_role(ws_id, user_id) do
    extra =
      Bitfield.bit(:read_message_history)
      |> Bitfield.bor(Bitfield.bit(:upload_attachments))
      |> Bitfield.bor(Bitfield.bit(:add_reactions))

    {:ok, role} = Workspaces.create_role(ws_id, run_unique("Five"), permissions: extra, position: 1)
    :ok = Workspaces.grant_role(ws_id, user_id, role.role_id)
    :ok
  end

  describe "humans keep the plug's exact oracle (regression pin)" do
    test "workspace owner resolves to all bits" do
      %{owner: owner, ws_id: ws_id} = seed_workspace()
      expected = Bitfield.all()
      assert {:ok, ^expected} = Principal.resolve(ws_id, human_claims(owner))
    end

    test "role-less member resolves on the @everyone base (view + send + add_reactions + start_call)" do
      %{parent: parent, ws_id: ws_id} = seed_workspace()
      assert {:ok, bits} = Principal.resolve(ws_id, human_claims(parent))
      assert bits == everyone_base()
    end

    # Calls V2 plan U2 (R13/VM7): SEND_VIDEO and SHARE_SCREEN follow the
    # exact START_CALL precedent — resolve-time default-on via the @everyone
    # base, channel-overridable through the normal 8-step engine (an explicit
    # deny blocks that bit in that channel only).
    test "SEND_VIDEO/SHARE_SCREEN: default-on for a plain member, channel deny overwrite blocks" do
      %{parent: parent, ws_id: ws_id, ch1: ch1, ch2: ch2} = seed_workspace()

      assert {:ok, ws_bits} = Principal.resolve(ws_id, human_claims(parent))
      assert Bitfield.has?(ws_bits, :send_video)
      assert Bitfield.has?(ws_bits, :share_screen)

      assert {:ok, ch_bits} = Principal.resolve(ws_id, human_claims(parent), ch1)
      assert Bitfield.has?(ch_bits, :send_video)
      assert Bitfield.has?(ch_bits, :share_screen)

      deny =
        Bitfield.bor(Bitfield.bit(:send_video), Bitfield.bit(:share_screen))

      Workspaces.put_overwrite(ch1, :member, parent.user_id, 0, deny)

      assert {:ok, denied} = Principal.resolve(ws_id, human_claims(parent), ch1)
      refute Bitfield.has?(denied, :send_video)
      refute Bitfield.has?(denied, :share_screen)
      assert Bitfield.has?(denied, :view_channel)

      # A sibling channel is untouched by the overwrite.
      assert {:ok, ch2_bits} = Principal.resolve(ws_id, human_claims(parent), ch2)
      assert Bitfield.has?(ch2_bits, :send_video)
      assert Bitfield.has?(ch2_bits, :share_screen)
    end

    # Voice plan U3 (KTD7/AM2): START_CALL is default-on for every member
    # via the resolve-time @everyone base, and channel-overridable through
    # the normal 8-step engine — an explicit deny blocks start.
    test "START_CALL: default-on for a plain member, channel deny overwrite blocks" do
      %{parent: parent, ws_id: ws_id, ch1: ch1, ch2: ch2} = seed_workspace()

      assert {:ok, ws_bits} = Principal.resolve(ws_id, human_claims(parent))
      assert Bitfield.has?(ws_bits, :start_call)

      assert {:ok, ch_bits} = Principal.resolve(ws_id, human_claims(parent), ch1)
      assert Bitfield.has?(ch_bits, :start_call)

      Workspaces.put_overwrite(ch1, :member, parent.user_id, 0, Bitfield.bit(:start_call))

      assert {:ok, denied} = Principal.resolve(ws_id, human_claims(parent), ch1)
      refute Bitfield.has?(denied, :start_call)
      assert Bitfield.has?(denied, :view_channel)

      # A sibling channel is untouched by the overwrite.
      assert {:ok, ch2_bits} = Principal.resolve(ws_id, human_claims(parent), ch2)
      assert Bitfield.has?(ch2_bits, :start_call)
    end

    test "non-member → :forbidden; unknown workspace → :not_found" do
      %{parent: parent, ws_id: ws_id} = seed_workspace()
      outsider = make_user("pr_out")

      assert {:error, :forbidden} = Principal.resolve(ws_id, human_claims(outsider))
      assert {:error, :not_found} = Principal.resolve(123_456_789_012_345_678, human_claims(parent))
    end

    test "channel deny overwrite narrows per-channel only (the 8-step path)" do
      %{parent: parent, ws_id: ws_id, ch1: ch1, ch2: ch2} = seed_workspace()

      # put_overwrite returns Xandra.Void — the write itself is the contract.
      Workspaces.put_overwrite(ch1, :member, parent.user_id, 0, Bitfield.bit(:send_messages))

      assert {:ok, ws_bits} = Principal.resolve(ws_id, human_claims(parent))
      assert Bitfield.has?(ws_bits, :send_messages)

      assert {:ok, ch_bits} = Principal.resolve(ws_id, human_claims(parent), ch1)
      refute Bitfield.has?(ch_bits, :send_messages)

      # A sibling channel is untouched by the overwrite.
      assert {:ok, ch2_bits} = Principal.resolve(ws_id, human_claims(parent), ch2)
      assert Bitfield.has?(ch2_bits, :send_messages)
    end
  end

  describe "machine principals — the access grant ∩ the parent's reach" do
    # The model in one sentence: an agent's bits are its OWNER'S reach
    # intersected with what its access document grants at that workspace or
    # channel. A grant can only narrow; it can never widen, and it can never
    # reach a capability the levels do not name (`Cytale.Access.never/0`).

    test "a granted agent never exceeds its parent" do
      %{parent: parent, ws_id: ws_id} = seed_workspace()
      :ok = grant_five_bit_role(ws_id, parent.user_id)

      {:ok, bot} = AgentGrants.mint_all(parent.user_id, :bot, run_unique("Echo Bot"))
      bot = AgentGrants.grant_workspaces(bot, %{ws_id => :read_write})

      assert {:ok, bits} = Principal.resolve(ws_id, machine_claims(bot))
      # The parent holds exactly read+post (plus the @everyone base's
      # CHANGE_NICKNAME, #169, which read_write also confers), so that is the
      # ceiling here — the agent's read_write grant cannot lift it higher.
      assert bits == read_bits() |> Bitfield.bor(post_bits()) |> Bitfield.bor(Bitfield.bit(:change_nickname))
    end

    test "a workspace outside the grant yields NOTHING (zero bits, not an error)" do
      %{owner: owner, ws_id: ws_id, ch1: ch1} = seed_workspace()

      # The grant names a DIFFERENT workspace, so this one is ungranted. Zero
      # bits (not `:forbidden`) is deliberate: the callers' view gate renders
      # the same anti-enumeration shape it gives any blind principal.
      {:ok, agent} = Principals.mint(owner.user_id, :agent, run_unique("Elsewhere"))
      agent = AgentGrants.grant_workspaces(agent, %{(ws_id + 1) => :read_write})

      assert {:ok, 0} = Principal.resolve(ws_id, machine_claims(agent))
      assert {:ok, 0} = Principal.resolve(ws_id, machine_claims(agent), ch1)
      # …while the owner obviously still sees it.
      assert {:ok, owner_bits} = Principal.resolve(ws_id, human_claims(owner), ch1)
      assert Bitfield.has?(owner_bits, :view_channel)
    end

    test "a :read grant loses exactly the post bits" do
      %{owner: owner, ws_id: ws_id} = seed_workspace()

      {:ok, agent} = Principals.mint(owner.user_id, :agent, run_unique("Reader"))
      agent = AgentGrants.grant_workspaces(agent, %{ws_id => :read})

      assert {:ok, bits} = Principal.resolve(ws_id, machine_claims(agent))

      assert Bitfield.has?(bits, :view_channel)
      assert Bitfield.has?(bits, :read_message_history)
      refute Bitfield.has?(bits, :send_messages)
      refute Bitfield.has?(bits, :upload_attachments)
      refute Bitfield.has?(bits, :add_reactions)
      assert bits == Cytale.Access.bits(:read)
    end

    test "a :read_write grant holds read+post, and nothing the levels never name" do
      %{owner: owner, ws_id: ws_id} = seed_workspace()

      {:ok, bot} = Principals.mint(owner.user_id, :bot, run_unique("Full Scope"))
      bot = AgentGrants.grant_workspaces(bot, %{ws_id => :read_write})

      assert {:ok, bits} = Principal.resolve(ws_id, machine_claims(bot))
      # Exactly the level's own definition — the module is the source of truth.
      assert bits == Cytale.Access.bits(:read_write)
      assert Bitfield.has?(bits, :send_messages)
      assert Bitfield.has?(bits, :add_reactions)
      assert Bitfield.has?(bits, :create_threads)

      # Management and moderation are ungrantable — not "denied by the parent".
      for never <- [:manage_channels, :manage_roles, :kick_members, :ban_members, :administrator] do
        refute Bitfield.has?(bits, never), "#{never} must not be reachable by any grant"
      end
    end

    test "an explicit channel grant narrows to that channel" do
      %{owner: owner, ws_id: ws_id, ch1: ch1, ch2: ch2} = seed_workspace()

      {:ok, agent} = Principals.mint(owner.user_id, :agent, run_unique("Scoped"))
      agent = AgentGrants.grant_workspaces(agent, %{ws_id => :none}, %{ws_id => %{ch1 => :read}})

      assert {:ok, in_list} = Principal.resolve(ws_id, machine_claims(agent), ch1)
      assert Bitfield.has?(in_list, :view_channel)

      # A channel the document does not name is ungranted, even though the
      # parent (the owner) can see it.
      assert {:ok, out_of_list} = Principal.resolve(ws_id, machine_claims(agent), ch2)
      refute Bitfield.has?(out_of_list, :view_channel)
      assert {:ok, owner_bits} = Principal.resolve(ws_id, human_claims(owner), ch2)
      assert Bitfield.has?(owner_bits, :view_channel)
    end
  end

  describe "recompute-on-check (R1) — the parent's current rights, next resolve" do
    test "the parent's CURRENT bits bound the agent on the very next resolve" do
      %{parent: parent, ws_id: ws_id} = seed_workspace()
      {:ok, bot} = Principals.mint(parent.user_id, :bot, run_unique("Drift Bot"))
      bot = AgentGrants.grant_workspaces(bot, %{ws_id => :read_write})

      # A plain member's base has no read_message_history, so the agent has none
      # either — the grant cannot supply a bit its owner lacks.
      assert {:ok, before} = Principal.resolve(ws_id, machine_claims(bot))
      refute Bitfield.has?(before, :read_message_history)

      {:ok, role} =
        Workspaces.create_role(ws_id, run_unique("Historian"),
          permissions: Bitfield.bit(:read_message_history),
          position: 2
        )

      :ok = Workspaces.grant_role(ws_id, parent.user_id, role.role_id)

      # No cache to clear — the next resolve sees the parent's new rights.
      assert {:ok, after_bits} = Principal.resolve(ws_id, machine_claims(bot))
      assert Bitfield.has?(after_bits, :read_message_history)
      assert Bitfield.band_not(after_bits, before) != 0
    end

    test "parent loses a channel overwrite allow → the sub narrows on the same request" do
      %{parent: parent, ws_id: ws_id, ch1: ch1} = seed_workspace()
      {:ok, bot} = Principals.mint(parent.user_id, :bot, run_unique("Allow Bot"))
      bot = AgentGrants.grant_workspaces(bot, %{ws_id => :read_write})

      Workspaces.put_overwrite(ch1, :member, parent.user_id, Bitfield.bit(:read_message_history), 0)

      assert {:ok, with_allow} = Principal.resolve(ws_id, machine_claims(bot), ch1)
      assert Bitfield.has?(with_allow, :read_message_history)

      Workspaces.delete_overwrite(ch1, parent.user_id)

      assert {:ok, without} = Principal.resolve(ws_id, machine_claims(bot), ch1)
      refute Bitfield.has?(without, :read_message_history)
    end
  end

  describe "role resolution is bounded by the HELD roles (hardening plan 5.7)" do
    test "a member's roles load with role_id IN ?, not a whole-partition scan" do
      owner = make_user("p57_owner")
      member = make_user("p57_member")
      {:ok, ws} = Workspaces.create_workspace(owner.user_id, "p57-#{System.unique_integer([:positive])}")
      :ok = Workspaces.add_member(ws.workspace_id, member.user_id, owner.user_id)

      {:ok, held} = Workspaces.create_role(ws.workspace_id, "held")
      :ok = Workspaces.grant_role(ws.workspace_id, member.user_id, held.role_id)

      # A workspace with MANY roles: the point of the gate is that this number
      # does not appear in the read.
      for i <- 1..30, do: Workspaces.create_role(ws.workspace_id, "spare#{i}")

      stmts = statements_of(fn -> Principal.load_member_roles(ws.workspace_id, member.user_id) end)

      roles_stmt = Enum.find(stmts, &(String.contains?(&1, "FROM ") |> Kernel.and(String.contains?(&1, ".roles"))))
      assert roles_stmt, "no roles read at all: #{inspect(stmts)}"
      assert roles_stmt =~ "role_id IN ?", "the roles read was not keyed by the held ids: #{roles_stmt}"
      refute roles_stmt =~ "ORDER BY", "the roles read looks like a partition scan: #{roles_stmt}"
    end

    test "update_role reads ONE role, not the workspace's partition" do
      owner = make_user("p57_upd")
      {:ok, ws} = Workspaces.create_workspace(owner.user_id, "p57u-#{System.unique_integer([:positive])}")
      {:ok, role} = Workspaces.create_role(ws.workspace_id, "target")
      for i <- 1..30, do: Workspaces.create_role(ws.workspace_id, "spare#{i}")

      stmts = statements_of(fn -> Workspaces.update_role(ws.workspace_id, role.role_id, %{name: "renamed"}) end)

      reads = Enum.filter(stmts, &(String.contains?(&1, "SELECT") and String.contains?(&1, ".roles")))
      assert length(reads) == 1, "update_role issued #{length(reads)} role reads: #{inspect(reads)}"
      assert hd(reads) =~ "role_id = ?", "the role read was not a point read: #{hd(reads)}"

      assert Workspaces.get_role(ws.workspace_id, role.role_id).name == "renamed"
    end

    # Every statement the node executes while `fun` runs, as text.
    defp statements_of(fun) do
      parent = self()
      ref = make_ref()
      handler_id = "principal-test-stmts-#{System.unique_integer([:positive])}"

      :ok =
        :telemetry.attach(
          handler_id,
          [:xandra, :execute_query, :start],
          fn _event, _measurements, metadata, ^parent ->
            send(parent, {:stmt, ref, statement_text(metadata.query)})
          end,
          parent
        )

      result = fun.()
      stmts = drain_statements(ref)
      :ok = :telemetry.detach(handler_id)
      _ = result
      stmts
    end

    defp drain_statements(ref) do
      receive do
        {:stmt, ^ref, text} -> [text | drain_statements(ref)]
      after
        0 -> []
      end
    end

    defp statement_text(%Xandra.Batch{queries: queries}),
      do: Enum.map_join(queries, "; ", &Map.get(&1, :statement, ""))

    defp statement_text(query), do: Map.get(query, :statement)
  end

  describe "a NULL overwrite mask cannot crash the resolver" do
    test "a null allow/deny resolves as NO BITS, and the socket-visible path does not raise" do
      # Found in a full-suite run: `ElixirImpl.apply_stage/2` reduces the
      # overwrite set with `Bitwise.bor/2`, and one row with a NULL mask raised
      # `:erlang.bor(0, nil)` inside the SESSION's visibility computation — a
      # socket crash (close 4000) at Identify, from one bad row.
      owner = make_user("nullmask_owner")
      member = make_user("nullmask_member")
      {:ok, ws} = Workspaces.create_workspace(owner.user_id, run_unique("nullmask"))
      :ok = Workspaces.add_member(ws.workspace_id, member.user_id, owner.user_id)
      {:ok, ch} = Workspaces.create_channel(ws.workspace_id, "nullmask-ch")

      # Write the bad row the way a legacy/broken writer would: both masks NULL
      # (every in-repo writer now normalizes, so this is the bypass).
      Cytale.Repo.execute!(
        ~s"INSERT INTO #{Cytale.Repo.keyspace()}.channel_overwrites (channel_id, target_id, target_type, \"allow\", \"deny\") VALUES (?, ?, 1, NULL, NULL)",
        [{"bigint", ch.channel_id}, {"bigint", member.user_id}]
      )

      # The batch resolver (what the session memo runs on Identify) answers.
      assert {:ok, by_channel} =
               Principal.resolve_channels(ws.workspace_id, human_claims(member), [ch.channel_id])

      assert {:ok, bits} = Map.get(by_channel, ch.channel_id)
      # With the overwrite a no-op, the @everyone base still grants view.
      assert Bitfield.has?(bits, :view_channel)

      # …and a nil mask through the WRITER cannot create one either.
      assert :ok = Workspaces.put_overwrite(ch.channel_id, :member, member.user_id, nil, nil)
      assert {:ok, _} = Principal.resolve_channels(ws.workspace_id, human_claims(member), [ch.channel_id])
    end
  end

  describe "fail-closed errors" do
    test "sub-identity after the parent left the workspace → :forbidden" do
      %{parent: parent, ws_id: ws_id} = seed_workspace()
      {:ok, bot} = AgentGrants.mint_all(parent.user_id, :bot, run_unique("Left Behind"))

      :ok = Workspaces.remove_member(ws_id, parent.user_id)
      assert {:error, :forbidden} = Principal.resolve(ws_id, machine_claims(bot))
    end

    test "unknown workspace → :not_found (machine claims)" do
      %{parent: parent} = seed_workspace()
      {:ok, bot} = AgentGrants.mint_all(parent.user_id, :bot, run_unique("Nowhere"))

      assert {:error, :not_found} =
               Principal.resolve(123_456_789_012_345_678, machine_claims(bot))
    end

    test "machine principal whose parent row vanished → :forbidden" do
      %{parent: parent, ws_id: ws_id} = seed_workspace()
      {:ok, bot} = AgentGrants.mint_all(parent.user_id, :bot, run_unique("Orphan Bot"))

      # Soft-deleted parent with the membership row still present: the
      # resolver must fail closed on the parent's liveness, not fall through
      # to membership-only checks.
      :ok = User.soft_delete!(parent.user_id)
      assert {:error, :forbidden} = Principal.resolve(ws_id, machine_claims(bot))
    end
  end

  describe "resolve_channels (PERF-4 batch: one overwrites read per page)" do
    test "N channels with overwrites → ONE channel_overwrites query, results equal per-channel resolve" do
      %{parent: parent, ws_id: ws_id, ch1: ch1, ch2: ch2} = seed_workspace()

      # Distinct overwrites on both channels (member denies).
      Workspaces.put_overwrite(ch1, :member, parent.user_id, 0, Bitfield.bit(:send_messages))
      Workspaces.put_overwrite(ch2, :member, parent.user_id, 0, Bitfield.bit(:view_channel))

      # Seed 8 more channels with an overwrite each — the page the gateway
      # visible-set computation would resolve.
      page_ids =
        for _ <- 1..8 do
          {:ok, ch} = Workspaces.create_channel(ws_id, run_unique("batch"))
          Workspaces.put_overwrite(ch.channel_id, :member, parent.user_id, 0, Bitfield.bit(:send_messages))
          ch.channel_id
        end

      channel_ids = [ch1, ch2 | page_ids]

      # THE counting window: the batch resolve alone.
      {by_channel, overwrite_queries} =
        count_overwrites_queries(fn ->
          Principal.resolve_channels(ws_id, human_claims(parent), channel_ids)
        end)

      assert {:ok, resolved} = by_channel

      # Behavior pin (outside the counting window): every channel's batched
      # result equals the single-channel resolve over the same claims.
      for channel_id <- channel_ids do
        assert {:ok, single} = Principal.resolve(ws_id, human_claims(parent), channel_id)
        assert Map.get(resolved, channel_id) == {:ok, single}
      end

      # The deny shape specifically: ch2 lost view, ch1 lost send (the
      # seeded eight lost send — per-channel only, never cross-channel).
      assert {:ok, ch2_bits} = Map.get(resolved, ch2)
      refute Bitfield.has?(ch2_bits, :view_channel)

      assert {:ok, ch1_bits} = Map.get(resolved, ch1)
      refute Bitfield.has?(ch1_bits, :send_messages)

      # The whole 10-channel page cost ONE overwrites read (the former
      # shape was one per channel — 10).
      assert overwrite_queries == 1
    end

    test "owners never read channel_overwrites at all" do
      %{owner: owner, ws_id: ws_id, ch1: ch1, ch2: ch2} = seed_workspace()

      Workspaces.put_overwrite(ch1, :member, owner.user_id, 0, Bitfield.bit(:view_channel))

      {result, overwrite_queries} =
        count_overwrites_queries(fn ->
          Principal.resolve_channels(ws_id, human_claims(owner), [ch1, ch2])
        end)

      assert {:ok, by_channel} = result

      for channel_id <- [ch1, ch2] do
        assert {:ok, bits} = Map.get(by_channel, channel_id)
        assert Bitfield.has?(bits, :view_channel)
      end

      assert overwrite_queries == 0
    end

    # Count [:xandra, :execute_query, :start] events whose statement touches
    # channel_overwrites while `fun` runs (the repo's telemetry-count
    # pattern, over Xandra's query telemetry). The handler runs synchronously
    # in the emitting process, so every hit is already in the mailbox when
    # `fun` returns.
    defp count_overwrites_queries(fun) do
      parent = self()
      ref = make_ref()
      handler_id = "principal-test-overwrites-#{System.unique_integer([:positive])}"

      :ok =
        :telemetry.attach(
          handler_id,
          [:xandra, :execute_query, :start],
          fn _event, _measurements, metadata, ^parent ->
            case metadata do
              %{query: %{statement: stmt}} when is_binary(stmt) ->
                if stmt =~ "channel_overwrites", do: send(parent, {:overwrite_query, ref})

              _ ->
                :ok
            end
          end,
          parent
        )

      result = fun.()

      count = drain_overwrite_queries(ref)
      :ok = :telemetry.detach(handler_id)
      {result, count}
    end

    defp drain_overwrite_queries(ref, acc \\ 0) do
      receive do
        {:overwrite_query, ^ref} -> drain_overwrite_queries(ref, acc + 1)
      after
        0 -> acc
      end
    end
  end

  describe "member overwrites are scoped to their member (security tier 1 #1)" do
    # A "private" channel: every member holds the Members role, whose role
    # overwrite denies VIEW; A alone gets a member allow. (@everyone overwrites
    # are not expressible as a bigint target, so the role carries the deny.)
    defp seed_private_channel do
      %{owner: owner, ws_id: ws_id, ch1: ch1, ch2: ch2} = seed_workspace()
      a = make_user("pr_mem_a")
      b = make_user("pr_mem_b")
      :ok = Workspaces.add_member(ws_id, a.user_id, owner.user_id, [])
      :ok = Workspaces.add_member(ws_id, b.user_id, owner.user_id, [])
      {:ok, role} = Workspaces.create_role(ws_id, run_unique("Members"), permissions: 0, position: 1)
      :ok = Workspaces.grant_role(ws_id, a.user_id, role.role_id)
      :ok = Workspaces.grant_role(ws_id, b.user_id, role.role_id)
      Workspaces.put_overwrite(ch1, :role, role.role_id, 0, Bitfield.bit(:view_channel))
      Workspaces.put_overwrite(ch1, :member, a.user_id, Bitfield.bit(:view_channel), 0)
      %{owner: owner, a: a, b: b, ws_id: ws_id, ch1: ch1, ch2: ch2}
    end

    test "a member allow on A never reaches B (resolve, resolve_channels, resolve_many)" do
      %{a: a, b: b, ws_id: ws_id, ch1: ch1, ch2: ch2} = seed_private_channel()

      assert {:ok, a_bits} = Principal.resolve(ws_id, human_claims(a), ch1)
      assert Bitfield.has?(a_bits, :view_channel)

      assert {:ok, b_bits} = Principal.resolve(ws_id, human_claims(b), ch1)
      refute Bitfield.has?(b_bits, :view_channel)

      assert {:ok, %{^ch1 => {:ok, b_page}}} = Principal.resolve_channels(ws_id, human_claims(b), [ch1, ch2])
      refute Bitfield.has?(b_page, :view_channel)

      assert {:ok, many} = Principal.resolve_many(ws_id, [a.user_id, b.user_id], ch1)
      assert {:ok, a_many} = many[a.user_id]
      assert {:ok, b_many} = many[b.user_id]
      assert Bitfield.has?(a_many, :view_channel)
      refute Bitfield.has?(b_many, :view_channel)
    end

    test "a member deny on A leaves B untouched" do
      %{owner: owner, ws_id: ws_id, ch2: ch2} = seed_workspace()
      a = make_user("pr_den_a")
      b = make_user("pr_den_b")
      :ok = Workspaces.add_member(ws_id, a.user_id, owner.user_id, [])
      :ok = Workspaces.add_member(ws_id, b.user_id, owner.user_id, [])
      Workspaces.put_overwrite(ch2, :member, a.user_id, 0, Bitfield.bit(:send_messages))

      assert {:ok, a_bits} = Principal.resolve(ws_id, human_claims(a), ch2)
      refute Bitfield.has?(a_bits, :send_messages)
      assert {:ok, b_bits} = Principal.resolve(ws_id, human_claims(b), ch2)
      assert Bitfield.has?(b_bits, :send_messages)
    end

    test "a machine principal plays its PARENT's member overwrites, not another member's" do
      %{a: a, b: b, ws_id: ws_id, ch1: ch1} = seed_private_channel()
      {:ok, bot_b} = AgentGrants.mint_all(b.user_id, :agent, run_unique("B agent"))
      {:ok, bot_a} = AgentGrants.mint_all(a.user_id, :agent, run_unique("A agent"))

      assert {:ok, 0} = Principal.resolve(ws_id, machine_claims(bot_b), ch1)
      assert {:ok, a_bits} = Principal.resolve(ws_id, machine_claims(bot_a), ch1)
      assert Bitfield.has?(a_bits, :view_channel)
    end
  end

  describe "the channel-scope view gate (security tier 1 #5)" do
    test "without VIEW_CHANNEL, no other channel bit survives" do
      %{parent: parent, ws_id: ws_id, ch1: ch1} = seed_workspace()

      {:ok, role} =
        Workspaces.create_role(ws_id, run_unique("Hist"), permissions: Bitfield.bit(:read_message_history), position: 1)

      :ok = Workspaces.grant_role(ws_id, parent.user_id, role.role_id)
      # Deny view, explicitly ALLOW send: the allow must not survive the gate.
      Workspaces.put_overwrite(ch1, :member, parent.user_id, Bitfield.bit(:send_messages), Bitfield.bit(:view_channel))

      assert {:ok, 0} = Principal.resolve(ws_id, human_claims(parent), ch1)
      assert {:ok, %{^ch1 => {:ok, 0}}} = Principal.resolve_channels(ws_id, human_claims(parent), [ch1])
      assert {:ok, %{} = many} = Principal.resolve_many(ws_id, [parent.user_id], ch1)
      assert {:ok, 0} = many[parent.user_id]

      # Workspace scope is not a channel: the member still holds its bits there.
      assert {:ok, ws_bits} = Principal.resolve(ws_id, human_claims(parent))
      assert Bitfield.has?(ws_bits, :send_messages)
    end
  end
end
