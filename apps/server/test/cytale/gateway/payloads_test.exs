defmodule Cytale.Gateway.PayloadsTest do
  use ExUnit.Case, async: true

  @moduledoc """
  Two payload-shape guards.

  The one-shape-per-object guard for `TypingStart`: three origins published
  this event with hand-rolled maps that disagreed on the JSON type of BOTH ids
  (the native socket sent integers, both REST origins sent strings). The client
  types them as `Snowflake` — a decimal string — so the builder owns the
  coercion and this suite keeps every origin routed through it.

  And the channel-anchor guard (#110): the fan-out derives its delivery route
  from the PAYLOAD, so every channel-scoped builder's payload must carry
  `channel_id` — a payload without one is delivered to nobody, silently.
  """

  alias Cytale.Calls.Events, as: CallEvents
  alias Cytale.Gateway.Payloads
  alias Cytale.Messages.Events, as: MessageEvents
  alias Cytale.Messages.Message
  alias Cytale.Threads.Events, as: ThreadEvents
  alias CytaleWeb.ReactionController

  describe "typing_start/3" do
    test "coerces both ids to the string form the client types" do
      payload = Payloads.typing_start(123, 456)

      assert payload.channel_id == "123"
      assert payload.user_id == "456"
      assert payload.thread_id == nil
      assert is_integer(payload.timestamp)
    end

    test "is idempotent for ids that are already strings" do
      payload = Payloads.typing_start("123", "456")

      assert payload.channel_id == "123"
      assert payload.user_id == "456"
    end

    test "passes a thread scope through untouched" do
      payload = Payloads.typing_start(1, 2, "9")

      assert payload.thread_id == "9"
    end
  end

  describe "every publisher uses the builder" do
    # A source pin: the whole failure was three copies drifting apart, so the
    # test asserts the COPIES ARE GONE, not merely that one of them is right.
    @publishers [
      "lib/cytale_web/channels/gateway_socket.ex",
      "lib/cytale_web/controllers/message_controller.ex",
      "lib/cytale_web/controllers/compat/channels_controller.ex"
    ]

    test "no site hand-rolls the map, and each calls the builder" do
      for relative <- @publishers do
        source = File.read!(Path.join([__DIR__, "..", "..", "..", relative]))

        assert source =~ "TypingStart",
               "#{relative} no longer publishes TypingStart — update this pin"

        assert source =~ "Payloads.typing_start(",
               "#{relative} publishes TypingStart without the shared builder"

        # Scope the no-drift refutes to the TypingStart payload SHAPE: the
        # original drift hand-built `"user_id" =>` map entries. Whole-file
        # keyword refutes (user_id: state.user_id) trip legitimate ack
        # sites whose native wire shape is an integer user id.
        refute source =~ ~s("user_id" => Integer.to_string),
               "#{relative} hand-rolls the typing user_id again"

        refute source =~ ~s(TypingStart", %{),
               "#{relative} builds the TypingStart payload without the builder"
      end
    end
  end

  describe "every MessageDelete publisher uses the builder" do
    # The MESSAGE_DELETE shape lived as three hand-rolled copies (native and
    # compat message routes + the interaction original-delete) until the
    # builder collected them — the same drift the TypingStart pin guards, so
    # the same doctrine: assert the COPIES ARE GONE, not merely that one of
    # them is right.
    @publishers [
      "lib/cytale_web/controllers/message_controller.ex",
      "lib/cytale_web/controllers/compat/messages_controller.ex",
      "lib/cytale_web/controllers/interaction_controller.ex"
    ]

    test "no site hand-rolls the map, and each calls the builder" do
      for relative <- @publishers do
        source = File.read!(Path.join([__DIR__, "..", "..", "..", relative]))

        assert source =~ "MessageDelete",
               "#{relative} no longer publishes MessageDelete — update this pin"

        assert dispatch_region(source, "MessageDelete") =~ "Messages.Events.message_delete(",
               "#{relative} publishes MessageDelete without the shared builder"

        refute source =~ ~s(MessageDelete", %{),
               "#{relative} hand-rolls the MessageDelete payload again"
      end
    end
  end

  describe "channel anchor (#110)" do
    # The fan-out re-derives its delivery route from the PAYLOAD
    # (`Workspaces.Workspace.handle_cast/2` → `route_for/1`): a payload with no
    # `channel_id` resolves to `{:workspace, :all}`, which `fanout_route_keys/2`
    # subscribes NO session to — so the event is published, acked `:ok`, and
    # delivered to nobody, in silence. #109 lived there, and it survived because
    # the payload BUILDER looked correct in isolation: it mirrored its protocol
    # type, which for `ThreadUpdate` carries no channel.
    #
    # The guard is therefore per builder, and it INVOKES the builder — a shape
    # asserted from a literal here would keep passing after the builder dropped
    # the anchor, which is the whole failure mode. The event-class list these
    # tests read is `Cytale.Gateway.Payloads`, so the seam's warning and this
    # suite cannot drift apart.

    test "every channel-anchored builder emits channel_id" do
      for {event, builders} <- anchored_builders(), {label, build} <- builders do
        anchor = channel_anchor(build.())

        assert is_binary(anchor) and anchor != "",
               "#{event} (#{label}) emits no channel_id: the fan-out resolves it to the " <>
                 "workspace-wide route and delivers it to nobody, silently (#110)"
      end
    end

    test "the anchored set is covered exactly — one cannot slip in untested" do
      covered = Enum.sort(Map.keys(anchored_builders()) ++ Map.keys(source_pinned_builders()))

      assert covered == Enum.sort(Payloads.channel_anchored_events()),
             "the channel-anchored list and this suite's coverage disagree: add the builder " <>
               "here, or move the event to the channel-less list with the reason it needs " <>
               "no channel (#110)"
    end

    test "the payloads with no callable builder are pinned to their anchor at the source" do
      # `message_json/1` serves MESSAGE_CREATE's REST/interaction routes AND
      # every MESSAGE_UPDATE, but it reads ScyllaDB (the reaction summary), so
      # it cannot run in this DB-less async suite. Pinned once, where it is
      # defined: removing the anchor makes every MESSAGE_UPDATE unroutable.
      message_source = read_app("lib/cytale_web/controllers/message_controller.ex")

      assert function_region(message_source, "def message_json(") =~ ~s("channel_id"),
             "MessageController.message_json/1 no longer anchors the channel — every " <>
               "MESSAGE_UPDATE it builds would be delivered to nobody (#110)"
    end

    test "a legitimately channel-less event is never treated as channel-scoped" do
      # `PresenceUpdate`, `MemberAdd`/`MemberRemove` and the user-addressed
      # events have no channel BY DESIGN (the ticket's own discriminator): the
      # warning must never fire for them, so they cannot appear in the anchored
      # (or channel-scoped) set.
      for event <- Payloads.channel_less_events() do
        refute Payloads.channel_scoped?(event), "#{event} is classified both ways"
        refute event in Payloads.channel_anchored_events(), "#{event} is channel-less but anchored"
      end
    end

    test "every event name the codebase dispatches is classified" do
      # The loud half: a NEW event dispatched in lib/ must be classified, so a
      # producer cannot be added for an event without someone deciding which
      # class it is — the decision that was never made for `ThreadUpdate`.
      # Static inventory of `{"Name", …}` dispatch tuple literals under lib/,
      # intersected with the protocol's EventName union (which keeps it off CQL
      # parameters like `{"bigint", …}`). A name only ever dispatched through a
      # runtime variable — `CallStart`/`CallUpdate`/`CallEnd` are computed by the
      # calls sink — is invisible here, and those ride the anchored table above.
      dispatched = dispatched_event_names()

      assert dispatched != [], "the dispatch scan found nothing — the heuristic has drifted"

      for event <- dispatched do
        assert Payloads.channel_scoped?(event) or event in Payloads.channel_less_events(),
               "#{event} is dispatched in lib/ but classified nowhere: add it to " <>
                 "Cytale.Gateway.Payloads as channel-anchored, or as channel-less with the " <>
                 "reason it needs no channel — an unclassified channel-scoped event is how " <>
                 "#109's silence got in"
      end
    end
  end

  describe "offline buffer taxonomy (hardening plan 4.2)" do
    # `FanOut.buffer_offline/3` appends a published event to a disconnected
    # session's record. Two classes must never go in: what the Resume tail
    # re-derives from live state (a stale copy would race the fresh one) and what
    # is ephemeral by contract. The list lives here because this module is where
    # a payload's class is decided.

    test "durable events are bufferable — a message published while away must survive" do
      # The regression this pins: adding a message event to the exclusion list
      # would silently restore the whole message-loss window the fix closed.
      for event <- ~w(MessageCreate MessageUpdate MessageDelete MessageReactionAdd
                      ThreadCreate ThreadMessageCreate ThreadUpdate MemberAdd ChannelCreate
                      MessageAck UserUpdate) do
        assert Payloads.offline_bufferable?(event), "#{event} would be dropped while offline"
      end
    end

    test "the superseded and ephemeral classes are excluded" do
      for event <- ~w(PresenceUpdate ReadStateSync TypingStart CallStart CallUpdate CallEnd
                      CallRing CallSignal CallSync) do
        refute Payloads.offline_bufferable?(event), "#{event} must not be buffered"
      end
    end

    test "every excluded name is a real, classified event — no typo'd dead entry" do
      known = Enum.sort(Payloads.channel_anchored_events() ++ Payloads.channel_less_events())
      superseded = Payloads.offline_superseded_events()

      for event <- superseded, do: assert(event in known, "#{event} is not a classified event")
      assert superseded == Enum.uniq(superseded), "the exclusion list has duplicates"
    end

    test "the Resume tail really does re-derive the superseded state" do
      # The exclusion is only safe while the reconnect re-syncs it. Pin the
      # emitters at their call site: if the tail stops re-syncing presence/read
      # state/calls, these events must come OUT of the exclusion list (or the
      # session resumes with stale state and no correction).
      source = read_app("lib/cytale_web/channels/gateway_socket.ex")

      for emitter <- ~w(send_presence_snapshot emit_read_state_sync emit_call_sync) do
        assert source =~ emitter, "#{emitter} is gone — revisit Payloads.offline_superseded_events/0"
      end
    end
  end

  # -- #110 fixtures and source pins --------------------------------------------

  # The payload each channel-anchored event is actually built with, INVOKED — the
  # event name maps to every builder that serves it (MESSAGE_CREATE and
  # THREAD_MESSAGE_CREATE share a wire shape, produced by two builders).
  defp anchored_builders do
    %{
      "MessageCreate" => [{"Messages.Message.to_wire/1", fn -> Message.to_wire(message()) end}],
      "MessageDelete" => [
        {"Messages.Events.message_delete/1", fn -> MessageEvents.message_delete(message()) end}
      ],
      "MessageReactionAdd" => [
        {"ReactionController.reaction_payload/4", fn -> ReactionController.reaction_payload(1, 2, 3, "x") end}
      ],
      "MessageReactionRemove" => [
        {"ReactionController.reaction_payload/4", fn -> ReactionController.reaction_payload(1, 2, 3, "x") end}
      ],
      "MessageReactionRemoveAll" => [
        {"ReactionController.remove_all_payload/2", fn -> ReactionController.remove_all_payload(1, 2) end}
      ],
      "ThreadCreate" => [{"Threads.Events.thread_create/1", fn -> ThreadEvents.thread_create(thread()) end}],
      "ThreadMessageCreate" => [
        {"Messages.Message.to_wire/1", fn -> Message.to_wire(message()) end},
        {"Threads.Events.thread_message_create/1",
         fn -> ThreadEvents.thread_message_create(Message.to_wire(message())) end}
      ],
      "ThreadUpdate" => [
        {"Threads.Events.thread_update/2", fn -> ThreadEvents.thread_update(thread(), %{}) end}
      ],
      "ThreadDelete" => [{"Threads.Events.thread_delete/1", fn -> ThreadEvents.thread_delete(thread()) end}],
      "TypingStart" => [{"Gateway.Payloads.typing_start/3", fn -> Payloads.typing_start(1, 2) end}],
      "CallStart" => [
        {"Calls.Events.call_start/5", fn -> CallEvents.call_start(1, 2, nil, 3, ~U[2026-09-12 00:00:00Z]) end}
      ],
      "CallUpdate" => [
        {"Calls.Events.call_update/5", fn -> CallEvents.call_update(1, 2, 3, "leg", "joined") end}
      ],
      "CallEnd" => [
        {"Calls.Events.call_end/4", fn -> CallEvents.call_end(1, 2, "last_left", ~U[2026-09-12 00:00:00Z]) end}
      ]
    }
  end

  # The anchored events whose payload is real but has no callable builder (see
  # the pin test above); the values are the source files the anchor must survive
  # in. Kept as names-only the coverage assertion can count them.
  defp source_pinned_builders do
    %{
      "MessageUpdate" => ["lib/cytale_web/controllers/message_controller.ex"]
    }
  end

  # An integer-native message row (`Cytale.Messages.t/0`) — the input
  # `Messages.Message.to_wire/1` takes. It must carry EVERY field `to_wire/1`
  # reads: the base's #155 made `reply_to_id` one of them, and this fixture
  # (unlike the struct) is a hand-built map, so the field has to be listed
  # here too. It was missing at the base tip and this test was red there —
  # measured in a separate worktree at `9afe390`: 13/14, same KeyError.
  defp message do
    %{
      id: 7_300_000_000_000_001,
      channel_id: 7_300_000_000_000_002,
      thread_id: nil,
      reply_to_id: nil,
      author_id: 7_300_000_000_000_003,
      content: "anchor probe",
      created_at: ~U[2026-09-12 00:00:00Z],
      edited_at: nil,
      attachments: []
    }
  end

  # An integer-native thread row (`Cytale.Threads.Thread.t/0`).
  defp thread do
    %{
      thread_id: 7_300_000_000_000_004,
      channel_id: 7_300_000_000_000_002,
      parent_message_id: 7_300_000_000_000_004,
      name: "anchor probe",
      archived: false,
      created_by: 7_300_000_000_000_003,
      created_at: ~U[2026-09-12 00:00:00Z]
    }
  end

  defp read_app(relative), do: File.read!(Path.join([__DIR__, "..", "..", "..", relative]))

  # The anchor may be string- or atom-keyed: the shared builders emit the wire's
  # string keys, while `Payloads.typing_start/3` emits atoms
  # (`Workspaces.Workspace.payload_channel_id/1` reads both, which is why that
  # builder routes correctly today). What must never happen is neither.
  defp channel_anchor(payload), do: payload["channel_id"] || payload[:channel_id]

  # The body of a function, from its head to the first two-space `end` — so the
  # assertion cannot be satisfied by an anchor living in some neighbouring
  # function of the same file.
  defp function_region(source, head) do
    case Regex.run(~r/#{Regex.escape(head)}(.*?)\n  end\n/s, source) do
      [_, region] -> region
      _ -> flunk("#{head} not found in the source — this pin needs updating")
    end
  end

  # The payload region that follows a dispatch's event-name literal.
  defp dispatch_region(source, event) do
    case Regex.run(~r/"#{event}".{0,400}/s, source) do
      [region] -> region
      _ -> flunk("no #{event} dispatch found — this pin needs updating")
    end
  end

  # The protocol package owns the EventName union; reading it keeps this scan
  # from inventing a second list of event names (and from tripping over
  # non-event literals like the CQL `{"bigint", …}` parameters).
  defp protocol_event_names do
    events_ts =
      File.read!(Path.join([__DIR__, "..", "..", "..", "..", "..", "packages", "protocol", "src", "events.ts"]))

    names =
      Regex.scan(~r/^\s*\|\s*'([A-Za-z]+)'/m, events_ts)
      |> Enum.map(&Enum.at(&1, 1))
      |> MapSet.new()

    assert MapSet.size(names) > 20, "the protocol EventName union could not be read"
    names
  end

  # Every `{"EventName", …}` dispatch tuple literal under lib/, intersected with
  # the protocol's names (a CQL `{"bigint", …}` parameter never matches one).
  defp dispatched_event_names do
    lib = Path.join([__DIR__, "..", "..", "..", "lib"])
    known = protocol_event_names()

    for path <- Path.wildcard(Path.join(lib, "**/*.ex")),
        [_, name] <- Regex.scan(~r/\{\s*"([A-Za-z]+)"\s*,/, File.read!(path)),
        MapSet.member?(known, name),
        uniq: true,
        do: name
  end
end
