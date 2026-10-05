defmodule Cytale.InteractionsTest do
  @moduledoc """
  U8 (bots plan) — the interactions context: application-command upsert/list
  (CHAT_INPUT naming validation, bulk replace vs single merge, stable ids for
  surviving names), invocation (token mint + native InteractionCreate
  payload), and the ETS interaction-token lifecycle (15-min TTL via config,
  distinct mints, principal-revocation purge, callback verification).
  """

  use Cytale.ScyllaCase, async: false

  alias Cytale.Accounts.{Principals, User}
  alias Cytale.Test.AgentGrants
  alias Cytale.Interactions
  alias Cytale.Interactions.TokenStore
  alias Cytale.Workspaces

  defp run_unique(base) do
    base <>
      Integer.to_string(
        :erlang.phash2({System.system_time(:millisecond), System.unique_integer([:positive])}, 1_000_000_000)
      )
  end

  setup do
    {:ok, owner} = User.create(run_unique("u8c_owner"), run_unique("u8c_owner@example.com"), "password-123")
    {:ok, member} = User.create(run_unique("u8c_member"), run_unique("u8c_member@example.com"), "password-123")
    {:ok, ws} = Workspaces.create_workspace(owner.user_id, run_unique("u8-ws"))
    {:ok, ch} = Workspaces.create_channel(ws.workspace_id, "general")
    :ok = Workspaces.add_member(ws.workspace_id, member.user_id, owner.user_id)
    {:ok, bot} = AgentGrants.mint_all(owner.user_id, :bot, run_unique("Ctx Bot"))

    {:ok,
     ws: ws,
     ch: ch,
     owner: owner,
     member: member,
     member_claims: %{user_id: member.user_id, username: member.username, verified: true, kind: :human},
     bot: bot}
  end

  defp register!(ws_id, bot_id, names) do
    commands = Enum.map(names, &%{"name" => &1, "description" => "The #{&1} command"})

    assert {:ok, stored} = Interactions.upsert_commands(ws_id, bot_id, commands, :replace)
    stored
  end

  defp invoke!(claims, ws, ch, bot, options \\ %{}) do
    [%{command_id: command_id} | _] = register!(ws.workspace_id, bot.user_id, ["echo"])

    assert {:ok, minted} = Interactions.invoke(claims, command_id, ch.channel_id, options)
    minted
  end

  # ---------------------------------------------------------------------------
  # Command registration
  # ---------------------------------------------------------------------------

  describe "upsert_commands/4" do
    test "bulk upsert stores and lists commands", %{ws: ws, bot: bot} do
      stored = register!(ws.workspace_id, bot.user_id, ["echo", "roll"])

      assert length(stored) == 2
      assert [%{name: "echo"} = echo, %{name: "roll"}] = Enum.sort_by(stored, & &1.name)
      assert is_integer(echo.command_id) and echo.command_id > 0
      assert echo.application_id == bot.user_id
      assert echo.workspace_id == ws.workspace_id
      assert echo.description == "The echo command"

      listed = Interactions.list_commands(ws.workspace_id)
      assert MapSet.new(Enum.map(listed, & &1.name)) == MapSet.new(["echo", "roll"])
    end

    test "a deleted bot's commands vanish from the list and are uninvokable (liveness filter)", %{
      ws: ws,
      bot: bot
    } do
      register!(ws.workspace_id, bot.user_id, ["echo"])
      assert [%{command_id: command_id, name: "echo"}] = Interactions.list_commands(ws.workspace_id)

      # DELETE the application principal (full removal): its credential dies
      # AND its commands stop being listed/invokable — the principal row is
      # gone, so the liveness filter hides the orphaned rows.
      :ok = Principals.delete_machine_principal!(bot.user_id)

      assert [] = Interactions.list_commands(ws.workspace_id)
      assert nil == Interactions.get_command(ws.workspace_id, command_id)
    end

    test "bulk replace drops removed names and keeps ids for survivors", %{ws: ws, bot: bot} do
      [echo, roll] = register!(ws.workspace_id, bot.user_id, ["echo", "roll"]) |> Enum.sort_by(& &1.name)

      # Re-PUT with roll + a new ping: echo dies, roll keeps its id.
      assert {:ok, stored} =
               Interactions.upsert_commands(
                 ws.workspace_id,
                 bot.user_id,
                 [
                   %{"name" => "roll", "description" => "rolled"},
                   %{"name" => "ping", "description" => "pong"}
                 ],
                 :replace
               )

      assert MapSet.new(Enum.map(stored, & &1.name)) == MapSet.new(["roll", "ping"])
      kept = Enum.find(stored, &(&1.name == "roll"))
      assert kept.command_id == roll.command_id
      assert kept.description == "rolled"

      names = ws.workspace_id |> Interactions.list_commands() |> Enum.map(& &1.name)
      assert "echo" not in names
      assert MapSet.new(names) == MapSet.new(["roll", "ping"])
      assert echo.command_id != roll.command_id
    end

    test ":merge (single create) leaves siblings alone", %{ws: ws, bot: bot} do
      register!(ws.workspace_id, bot.user_id, ["echo"])

      assert {:ok, [stored]} =
               Interactions.upsert_commands(
                 ws.workspace_id,
                 bot.user_id,
                 [
                   %{"name" => "roll", "description" => "dice"}
                 ],
                 :merge
               )

      assert stored.name == "roll"
      names = ws.workspace_id |> Interactions.list_commands() |> Enum.map(& &1.name)
      assert MapSet.new(names) == MapSet.new(["echo", "roll"])
    end

    test "options ride verbatim as JSON", %{ws: ws, bot: bot} do
      options = [%{"name" => "text", "type" => 3, "required" => true}]

      assert {:ok, [stored]} =
               Interactions.upsert_commands(
                 ws.workspace_id,
                 bot.user_id,
                 [
                   %{"name" => "echo", "description" => "d", "options" => options}
                 ],
                 :replace
               )

      assert stored.options == options
    end

    test "invalid names are rejected: spaces, uppercase, 33 chars, wrong type", %{ws: ws, bot: bot} do
      for bad <- ["has space", "Upper", String.duplicate("a", 33), 42, nil, ""] do
        assert {:error, :invalid_commands} =
                 Interactions.upsert_commands(
                   ws.workspace_id,
                   bot.user_id,
                   [
                     %{"name" => bad, "description" => "d"}
                   ],
                   :replace
                 )
      end
    end

    test "invalid descriptions, options, duplicate names, non-array bodies are rejected", %{ws: ws, bot: bot} do
      for body <- [
            [%{"name" => "ok", "description" => ""}],
            [%{"name" => "ok", "description" => String.duplicate("d", 101)}],
            [%{"name" => "ok", "description" => "d", "options" => "nope"}],
            [%{"name" => "dup", "description" => "d"}, %{"name" => "dup", "description" => "d2"}],
            [%{"name" => "ok"}],
            %{"name" => "not-a-list"}
          ] do
        assert {:error, :invalid_commands} = Interactions.upsert_commands(ws.workspace_id, bot.user_id, body, :replace)
      end
    end
  end

  # ---------------------------------------------------------------------------
  # Component clicks (components plan U2, R3/R8-ingress)
  # ---------------------------------------------------------------------------

  describe "invoke_component/5 (components plan U2)" do
    alias Cytale.Messages

    defp button_row(ids),
      do: %{
        "type" => 1,
        "components" => Enum.map(ids, &%{"type" => 2, "style" => 1, "label" => "B#{&1}", "custom_id" => &1})
      }

    defp select_row(id) do
      %{
        "type" => 1,
        "components" => [
          %{
            "type" => 3,
            "custom_id" => id,
            "options" => [
              %{"label" => "One", "value" => "one"},
              %{"label" => "Two", "value" => "two"}
            ]
          }
        ]
      }
    end

    defp card!(channel_id, author_id, components) do
      {:ok, msg} =
        Messages.create_message(%{
          channel_id: channel_id,
          author_id: author_id,
          content: "card",
          thread_id: nil,
          components: components
        })

      msg
    end

    defp click!(claims, msg, custom_id, component_type \\ 2, values \\ nil),
      do: Interactions.invoke_component(claims, msg.channel_id, msg.id, custom_id, component_type, values)

    test "mints a component interaction: native payload + the extended data map", %{
      ws: ws,
      ch: ch,
      member_claims: claims,
      bot: bot
    } do
      rows = [button_row(["approve", "deny"])]
      msg = card!(ch.channel_id, bot.user_id, rows)

      assert {:ok, minted} = click!(claims, msg, "approve")

      assert minted.interaction_id > 0
      assert is_binary(minted.token) and byte_size(minted.token) >= 32

      payload = minted.payload
      assert payload["id"] == Integer.to_string(minted.interaction_id)
      assert payload["token"] == minted.token
      assert payload["application_id"] == Integer.to_string(bot.user_id)
      assert payload["kind"] == "component"
      assert payload["custom_id"] == "approve"
      assert payload["component_type"] == 2
      assert payload["message_id"] == Integer.to_string(msg.id)
      assert payload["channel_id"] == Integer.to_string(ch.channel_id)
      assert payload["workspace_id"] == Integer.to_string(ws.workspace_id)
      assert payload["user"]["id"] == claims.user_id
      assert payload["user"]["username"] == claims.username
      # The embedded row snapshot (the codec's d.message source).
      assert payload["message"].id == msg.id
      assert payload["message"].channel_id == ch.channel_id
      assert payload["message"].components == rows
      # The owning agent's resolved channel bitfield rides as an integer: the
      # grant-derived bits (a full read_write grant under the owner parent),
      # which by construction never carry a manage/moderation bit.
      assert payload["app_permissions"] == Cytale.Access.bits(:read_write)
      refute Enum.any?(Cytale.Access.never(), &Cytale.Permissions.Bitfield.has?(payload["app_permissions"], &1))

      # The token data map carries the component provenance (KTD2 — the map,
      # never the TokenStore 3-tuple).
      assert {:ok, data} = Interactions.verify_callback(minted.interaction_id, minted.token)
      assert data.application_id == bot.user_id
      assert data.workspace_id == ws.workspace_id
      assert data.channel_id == ch.channel_id
      assert data.message_id == msg.id
      assert data.custom_id == "approve"
      assert data.component_type == 2
      assert data.values == []
      assert data.invoked_by.user_id == claims.user_id
    end

    test "provenance: the owning application is the MESSAGE's author (not the clicker's bot)", %{
      ch: ch,
      owner: owner,
      member_claims: claims
    } do
      {:ok, other_bot} = AgentGrants.mint_all(owner.user_id, :bot, run_unique("Card Owner"))

      msg = card!(ch.channel_id, other_bot.user_id, [button_row(["go"])])

      assert {:ok, minted} = click!(claims, msg, "go")
      assert minted.payload["application_id"] == Integer.to_string(other_bot.user_id)
      assert {:ok, data} = Interactions.verify_callback(minted.interaction_id, minted.token)
      assert data.application_id == other_bot.user_id
    end

    test "select clicks carry values verbatim through mint and data map", %{
      ch: ch,
      member_claims: claims,
      bot: bot
    } do
      msg = card!(ch.channel_id, bot.user_id, [select_row("model")])

      assert {:ok, minted} = click!(claims, msg, "model", 3, ["two"])
      assert minted.payload["values"] == ["two"]

      assert {:ok, data} = Interactions.verify_callback(minted.interaction_id, minted.token)
      assert data.component_type == 3
      assert data.custom_id == "model"
      assert data.values == ["two"]
    end

    # The R3 security core: the click is verified against the message's
    # CURRENT stored components — forged/stale/disabled/component-less all
    # mint NOTHING.
    test "membership negatives: forged custom_id / disabled / component-less → no mint", %{
      ch: ch,
      member_claims: claims,
      owner: owner,
      bot: bot
    } do
      rows = [
        button_row(["approve"]),
        %{
          "type" => 1,
          "components" => [%{"type" => 2, "style" => 1, "label" => "D", "custom_id" => "dead", "disabled" => true}]
        }
      ]

      msg = card!(ch.channel_id, bot.user_id, rows)
      before = TokenStore.count()

      assert {:error, :component_unavailable} = click!(claims, msg, "forged")
      assert {:error, :component_unavailable} = click!(claims, msg, "dead")
      assert {:error, :component_unavailable} = click!(claims, msg, "approve", 3)
      assert TokenStore.count() == before

      # Dead-air guard: a component-less bot message mints nothing.
      plain = card!(ch.channel_id, bot.user_id, [])
      assert {:error, :component_unavailable} = click!(claims, plain, "anything")
      # ... and a webhook-authored component-less message neither (webhook
      # interactive components are rejected at validation, U1).
      {:ok, hook} = AgentGrants.mint_all(owner.user_id, :webhook, run_unique("Hook"))
      webhook_msg = card!(ch.channel_id, hook.user_id, [])
      assert {:error, :component_unavailable} = click!(claims, webhook_msg, "anything")
      assert TokenStore.count() == before
    end

    test "select values validation: ⊥ option, out-of-bounds count, non-list, >4KB", %{
      ch: ch,
      member_claims: claims,
      bot: bot
    } do
      msg = card!(ch.channel_id, bot.user_id, [select_row("model")])

      # A value outside the stored option set.
      assert {:error, :invalid_values} = click!(claims, msg, "model", 3, ["gopher"])
      # |values| above max_values (1, the default) and below the default min (1).
      assert {:error, :invalid_values} = click!(claims, msg, "model", 3, ["one", "two"])
      assert {:error, :invalid_values} = click!(claims, msg, "model", 3, [])
      # Non-list values.
      assert {:error, :invalid_values} = click!(claims, msg, "model", 3, "one")
      assert {:error, :invalid_values} = click!(claims, msg, "model", 3, [1, 2])
      # >100-char single value; >4KB total (many short stored-option values).
      assert {:error, :invalid_values} = click!(claims, msg, "model", 3, [String.duplicate("x", 5_000)])
      assert {:error, :invalid_values} = click!(claims, msg, "model", 3, List.duplicate("one", 5_000))
    end

    test "multi-select (#30): a set within min..max passes; duplicates and overflow do not", %{
      ch: ch,
      member_claims: claims,
      bot: bot
    } do
      multi =
        put_in(select_row("tags"), ["components", Access.at(0), "max_values"], 2)
        |> put_in(["components", Access.at(0), "min_values"], 0)

      msg = card!(ch.channel_id, bot.user_id, [multi])

      assert {:ok, minted} = click!(claims, msg, "tags", 3, ["two", "one"])
      assert minted.payload["values"] == ["two", "one"]
      # min 0: an empty pick is a valid submission (it carries no values key).
      assert {:ok, empty} = click!(claims, msg, "tags", 3, [])
      refute Map.has_key?(empty.payload, "values")
      # A set, not a list: the same option twice never passes.
      assert {:error, :invalid_values} = click!(claims, msg, "tags", 3, ["one", "one"])
    end

    # R8 (ingress half): a dead bot's buttons are inert — the distinct
    # dead-button error fires BEFORE any mint.
    test "a deleted bot's button is dead: distinct error, TokenStore unchanged", %{
      ch: ch,
      member_claims: claims,
      bot: bot
    } do
      msg = card!(ch.channel_id, bot.user_id, [button_row(["approve"])])
      :ok = Principals.delete_machine_principal!(bot.user_id)

      before = TokenStore.count()
      assert {:error, :application_dead} = click!(claims, msg, "approve")
      assert TokenStore.count() == before
    end

    test "clicker gate: machine principals cannot click; humans need the send right", %{
      ws: ws,
      ch: ch,
      member: member,
      bot: bot
    } do
      alias Cytale.Permissions.Bitfield

      msg = card!(ch.channel_id, bot.user_id, [button_row(["approve"])])

      # Machine clicker → 403 (the kind-guard doctrine: clicks are a human
      # input primitive; a machine clicker could ping-pong bots with no human
      # watching).
      assert {:error, :forbidden} = click!(Principals.claims(bot), msg, "approve")

      # Stranger human → forbidden (no membership oracle).
      stranger = %{user_id: 999_999_999, username: "stranger", verified: true, kind: :human}
      assert {:error, :forbidden} = click!(stranger, msg, "approve")

      # Member denied send right in the channel → forbidden (the invoke
      # precedent).
      {:ok, locked} = Workspaces.create_channel(ws.workspace_id, "locked")
      Workspaces.put_overwrite(locked.channel_id, :member, member.user_id, 0, Bitfield.bit(:send_messages))
      locked_msg = card!(locked.channel_id, bot.user_id, [button_row(["approve"])])
      claims = %{user_id: member.user_id, username: member.username, verified: true, kind: :human}
      assert {:error, :forbidden} = click!(claims, locked_msg, "approve")
    end

    test "DM leg: participant human clicks (nil workspace); non-participant gets the 404 oracle", %{
      owner: owner,
      bot: bot,
      member: member
    } do
      {:ok, dm} = Workspaces.open_dm(owner.user_id, bot.user_id)
      msg = card!(dm.channel_id, bot.user_id, [button_row(["approve"])])

      owner_claims = %{user_id: owner.user_id, username: owner.username, verified: true, kind: :human}
      assert {:ok, minted} = Interactions.invoke_component(owner_claims, dm.channel_id, msg.id, "approve", 2)

      refute Map.has_key?(minted.payload, "workspace_id")
      assert minted.payload["app_permissions"] == Cytale.Permissions.Bitfield.all()

      assert {:ok, data} = Interactions.verify_callback(minted.interaction_id, minted.token)
      assert data.workspace_id == nil
      assert data.channel_id == dm.channel_id

      # Non-participant: identical channel_not_found — never a DM oracle.
      member_claims = %{user_id: member.user_id, username: member.username, verified: true, kind: :human}

      assert {:error, :channel_not_found} =
               Interactions.invoke_component(member_claims, dm.channel_id, msg.id, "approve", 2)
    end

    test "missing message / missing channel are 404-class errors", %{
      ch: ch,
      member_claims: claims,
      bot: bot
    } do
      msg = card!(ch.channel_id, bot.user_id, [button_row(["approve"])])

      assert {:error, :message_not_found} =
               Interactions.invoke_component(claims, ch.channel_id, 999_999_999_999, "approve", 2)

      assert {:error, :channel_not_found} = Interactions.invoke_component(claims, 999_999_999_999, msg.id, "approve", 2)
    end
  end

  # ---------------------------------------------------------------------------
  # Invocation + interaction tokens
  # ---------------------------------------------------------------------------

  describe "invoke/4" do
    test "mints an interaction and builds the native payload", %{
      ws: ws,
      ch: ch,
      member_claims: claims,
      bot: bot
    } do
      minted = invoke!(claims, ws, ch, bot, %{"text" => "hi"})

      assert is_integer(minted.interaction_id) and minted.interaction_id > 0
      assert is_binary(minted.token) and byte_size(minted.token) >= 32

      payload = minted.payload
      assert payload["id"] == Integer.to_string(minted.interaction_id)
      assert payload["token"] == minted.token
      assert payload["application_id"] == Integer.to_string(bot.user_id)
      assert payload["command"]["name"] == "echo"
      assert is_binary(payload["command"]["id"])
      assert payload["options"] == %{"text" => "hi"}
      assert payload["channel_id"] == Integer.to_string(ch.channel_id)
      assert payload["workspace_id"] == Integer.to_string(ws.workspace_id)
      assert payload["user"]["id"] == Integer.to_string(claims.user_id)
      assert payload["user"]["username"] == claims.username
    end

    test "two invocations mint distinct ids and tokens", %{ws: ws, ch: ch, member_claims: claims, bot: bot} do
      a = invoke!(claims, ws, ch, bot)
      b = invoke!(claims, ws, ch, bot)

      assert a.interaction_id != b.interaction_id
      assert a.token != b.token
    end

    test "unknown channel / unknown command / non-member caller are errors", %{
      ws: ws,
      ch: ch,
      bot: bot,
      member_claims: claims
    } do
      [%{command_id: command_id} | _] = register!(ws.workspace_id, bot.user_id, ["echo"])

      assert {:error, :channel_not_found} = Interactions.invoke(claims, command_id, 999_999_999_999, %{})
      assert {:error, :command_not_found} = Interactions.invoke(claims, 999_999_999_999, ch.channel_id, %{})

      stranger = %{user_id: 999_999_999, username: "stranger", verified: true, kind: :human}
      assert {:error, :forbidden} = Interactions.invoke(stranger, command_id, ch.channel_id, %{})
    end

    test "a member without the send right on the channel is forbidden", %{
      ws: ws,
      bot: bot,
      member: member,
      member_claims: claims
    } do
      alias Cytale.Permissions.Bitfield

      {:ok, locked} = Workspaces.create_channel(ws.workspace_id, "locked")
      # Member-scoped deny overwrite: the member cannot SEND in `locked`.
      Workspaces.put_overwrite(locked.channel_id, :member, member.user_id, 0, Bitfield.bit(:send_messages))

      [%{command_id: command_id} | _] = register!(ws.workspace_id, bot.user_id, ["echo"])
      assert {:error, :forbidden} = Interactions.invoke(claims, command_id, locked.channel_id, %{})
    end

    # #134 invocation-side gates. A command named `invite` mints workspace
    # invites: the acting principal needs manage_workspace, checked HERE
    # (the stored command object has no Discord default_member_permissions
    # counterpart). Every other command needs only the channel send right
    # the invoke already checked (the @-mention parity).
    test "an `invite` command is gated on manage_workspace at invocation", %{
      ws: ws,
      ch: ch,
      owner: owner,
      member_claims: claims,
      bot: bot
    } do
      [%{command_id: invite_id} | _] = register!(ws.workspace_id, bot.user_id, ["invite"])

      # The plain member holds the @everyone base (view + send) — the send
      # right passes, the workspace authority does not.
      assert {:error, :command_forbidden} = Interactions.invoke(claims, invite_id, ch.channel_id, %{})

      # The owner resolves full bits — the mint proceeds.
      owner_claims = %{user_id: owner.user_id, username: owner.username, verified: true, kind: :human}
      assert {:ok, minted} = Interactions.invoke(owner_claims, invite_id, ch.channel_id, %{})
      assert minted.payload["command"]["name"] == "invite"
    end

    test "non-invite commands need only the send right (the gate is name-keyed)", %{
      ws: ws,
      ch: ch,
      member_claims: claims,
      bot: bot
    } do
      [%{command_id: ask_id} | _] = register!(ws.workspace_id, bot.user_id, ["ask"])

      # The same plain member that `invite` refused invokes `ask` freely.
      assert {:ok, minted} = Interactions.invoke(claims, ask_id, ch.channel_id, %{})
      assert minted.payload["command"]["name"] == "ask"
    end
  end

  describe "interaction token lifecycle" do
    test "verify_callback: right token ok; wrong token / unknown id fail", %{
      ws: ws,
      ch: ch,
      member_claims: claims,
      bot: bot
    } do
      minted = invoke!(claims, ws, ch, bot)

      assert {:ok, data} = Interactions.verify_callback(minted.interaction_id, minted.token)
      assert data.application_id == bot.user_id
      assert data.workspace_id == ws.workspace_id
      assert data.channel_id == ch.channel_id

      assert {:error, :bad_token} = Interactions.verify_callback(minted.interaction_id, minted.token <> "x")
      assert {:error, :unknown_interaction} = Interactions.verify_callback(999_999_999_999, minted.token)
    end

    test "tokens expire after the configured TTL", %{ws: ws, ch: ch, member_claims: claims, bot: bot} do
      previous = Application.get_env(:cytale, :interactions)
      Application.put_env(:cytale, :interactions, token_ttl_ms: 40)

      on_exit(fn ->
        case previous do
          nil -> Application.delete_env(:cytale, :interactions)
          value -> Application.put_env(:cytale, :interactions, value)
        end
      end)

      minted = invoke!(claims, ws, ch, bot)
      assert {:ok, _} = Interactions.verify_callback(minted.interaction_id, minted.token)
      Process.sleep(60)
      assert {:error, :expired} = Interactions.verify_callback(minted.interaction_id, minted.token)
    end

    test "revoking the principal purges its outstanding tokens", %{
      ws: ws,
      ch: ch,
      member_claims: claims,
      bot: bot
    } do
      minted = invoke!(claims, ws, ch, bot)
      assert {:ok, _} = Interactions.verify_callback(minted.interaction_id, minted.token)

      assert TokenStore.revoke_principal(bot.user_id) >= 1
      assert {:error, :unknown_interaction} = Interactions.verify_callback(minted.interaction_id, minted.token)
    end

    # C-1: the ack is single-use — exactly ONE caller wins the atomic
    # check-and-set, even under concurrency.
    test "consume_ack: first wins, replays lose, races have exactly one winner", %{
      ws: ws,
      ch: ch,
      member_claims: claims,
      bot: bot
    } do
      minted = invoke!(claims, ws, ch, bot)

      assert :ok = Interactions.consume_callback_ack(minted.interaction_id, minted.token)
      assert {:error, :ack_consumed} = Interactions.consume_callback_ack(minted.interaction_id, minted.token)
      assert {:error, :bad_token} = Interactions.consume_callback_ack(minted.interaction_id, minted.token <> "x")
      assert {:error, :unknown_interaction} = Interactions.consume_callback_ack(999_999_999_999, minted.token)

      # 20 concurrent consumers on a fresh token: exactly one :ok.
      fresh = invoke!(claims, ws, ch, bot)

      results =
        1..20
        |> Enum.map(fn _ ->
          Task.async(fn -> TokenStore.consume_ack(fresh.interaction_id, fresh.token) end)
        end)
        |> Task.await_many(5_000)

      assert Enum.count(results, &(&1 == :ok)) == 1
      assert Enum.count(results, &match?({:error, :ack_consumed}, &1)) == 19
    end
  end
end
