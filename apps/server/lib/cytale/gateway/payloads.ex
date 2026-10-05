defmodule Cytale.Gateway.Payloads do
  @moduledoc """
  Wire payloads shared by every origin that publishes the same gateway event.

  ONE builder per event — the one-shape-per-object rule that #63/#69/#73/#74/
  #75 each turned out to be an instance of. `TypingStart` had three hand-rolled
  copies of the same map, and they did not agree:

      native socket (op 20)   channel_id: <integer>,  user_id: <integer>
      POST /api/v1 …/typing    channel_id: <string>,   user_id: <string>
      POST /api/v10 …/typing   channel_id: <string>,   user_id: <string>

  All three reach the same fan-out and land on the same wire, so a client saw
  two JSON types for one field depending on who typed. Nothing rendered the
  field until U23 was wired up, which is why it went unnoticed — the client
  types both as `Snowflake`, a decimal STRING, so the builder stringifies.

  Timestamps stay in this builder too: they are part of the event's shape and
  three copies is how one of them drifts.

  It is also where the event-address taxonomy below lives, because whether a
  payload MAY omit a channel is a property of the payload, and this is the
  module a new payload is added to (#110).
  """

  @doc """
  The canonical `TypingStart` payload.

  `thread_id` is `nil` for a channel-scoped signal (the wire contract) and
  passed through when the origin has a thread scope.
  """
  @spec typing_start(integer() | String.t(), integer() | String.t(), String.t() | nil) :: map()
  def typing_start(channel_id, user_id, thread_id \\ nil) do
    %{
      channel_id: to_string(channel_id),
      thread_id: thread_id,
      user_id: to_string(user_id),
      timestamp: System.system_time(:millisecond)
    }
  end

  # -- Event address taxonomy (#110) --------------------------------------------
  #
  # The fan-out re-derives its delivery route from the PAYLOAD, not from the
  # channel the publisher handed to `Cytale.Publish.publish/2`:
  # `Workspaces.Workspace.handle_cast/2` reads the payload's `channel_id` and a
  # payload without one resolves to the `{:workspace, :all}` route, which
  # `fanout_route_keys/2` subscribes NO session to. Such an event is published,
  # acked `:ok`, and delivered to nobody — in silence, which is the whole
  # failure mode. `ThreadUpdate` was exactly that shape until #109: its builder
  # mirrored its protocol type, and the type carried no channel.
  #
  # The discriminator is the event CLASS, not a missing key: an event that is
  # SUPPOSED to be channel-less is not a bug, and warning on it would be noise
  # that trains readers to ignore the line. Two consumers read these lists, so
  # they are the single source of truth for both directions:
  #
  #   * `Workspaces.Workspace` warns when a channel-scoped event lands on the
  #     workspace-wide route.
  #   * `Cytale.Gateway.PayloadsTest` asserts that every `channel_anchored`
  #     builder actually emits the anchor, and that no event the codebase
  #     dispatches is left unclassified.
  #
  # Channel-scoped AND routed by the payload's `channel_id`: the set that must
  # never be published without one. A new builder here needs `channel_id` even
  # when its protocol type has no such field (finish the job the way #109 did
  # for `ThreadUpdate`, whose type was extended in the same commit).
  #
  # Deliberately NOT listed (the trap #110 was filed to keep visible):
  # `ThreadMemberAdd`, `ThreadMemberRemove`, `ThreadListSync`, `Role*` have no
  # producer yet, and their builders carry `thread_id` — adding a producer for
  # one of them by mirroring its protocol type reproduces #109 exactly. See
  # `Threads.Events` for the same warning next to those builders.
  @channel_anchored ~w(
    MessageCreate
    MessageUpdate
    MessageDelete
    MessageReactionAdd
    MessageReactionRemove
    MessageReactionRemoveAll
    ThreadCreate
    ThreadMessageCreate
    ThreadUpdate
    ThreadDelete
    TypingStart
    CallStart
    CallUpdate
    CallEnd
  )

  # Channel-addressed, but routed by an EXPLICIT key chosen at the origin
  # rather than by the payload: `ChannelUpdate` is delivered from the channel
  # controller through `GatewaySocket.fan_out(channel_key, …)`, and its payload
  # carries `id` (the `@cytale/protocol` `ChannelUpdate` type has no
  # `channel_id`). It still belongs to the channel-scoped class — routed through
  # the workspace process it WOULD drop silently, so the seam must warn — but no
  # payload-derived route depends on it, so the builders' suite does not demand
  # the anchor (adding one would change a wire payload for no delivery gain).
  @channel_keyed ~w(ChannelUpdate)

  # Legitimately channel-LESS — there is no channel to name. Workspace-addressed:
  # membership, presence and channel-lifecycle broadcasts delivered on the
  # workspace key the sessions subscribe to directly (`ChannelCreate`/
  # `ChannelDelete` are broadcast there on purpose: the new channel has no
  # subscribers yet, and the deleted one has none left).
  @workspace_addressed ~w(ChannelCreate ChannelDelete PresenceUpdate MemberAdd MemberRemove MemberUpdate)

  # …and user-addressed: point-to-point to a user's own sessions on the user
  # key (profile converge, read acks, call ring/signal/sync, bot interactions,
  # account teardown). `ReadStateUpdate` (#54) names a channel in its payload
  # but is delivered to the owner's user key, never by channel. It is buffered
  # for a disconnected session, unlike `ReadStateSync`: the resume sync's
  # never-regress guard would skip a floor-only move, i.e. a fired reminder.
  # `InteractionModal` (#30) and `InteractionSuccess` go to the invoking
  # human's own sessions.
  @user_addressed ~w(
    MessageAck
    ReadStateSync
    ReadStateUpdate
    InteractionCreate
    InteractionModal
    InteractionSuccess
    CallRing
    CallSignal
    CallSync
    UserUpdate
    AccountDelete
  )

  @doc """
  True when `event_name` is delivered BY CHANNEL, and so must never resolve to
  the workspace-wide route. Covers both the payload-routed set
  (`channel_anchored_events/0`) and the channel-addressed events whose origin
  picks an explicit route key.

  This is the discriminator the fan-out's warning uses: it answers "was this
  event SUPPOSED to name a channel?", which a nil channel alone cannot.
  """
  @spec channel_scoped?(String.t()) :: boolean()
  def channel_scoped?(event_name) when is_binary(event_name),
    do: event_name in @channel_anchored or event_name in @channel_keyed

  @doc """
  Channel-scoped events whose delivery route is derived from the payload's
  `channel_id` — the builders that must emit the anchor.
  """
  @spec channel_anchored_events() :: [String.t()]
  def channel_anchored_events, do: @channel_anchored

  @doc """
  Events that are legitimately channel-less (workspace- or user-addressed).
  None of them may appear in `channel_anchored_events/0`, and the fan-out must
  not warn for any of them.
  """
  @spec channel_less_events() :: [String.t()]
  def channel_less_events, do: @workspace_addressed ++ @user_addressed

  # -- Offline-buffer taxonomy (hardening plan 4.2) -----------------------------
  #
  # Events that must NOT be appended to a disconnected session's resume buffer
  # (`FanOut.buffer_offline/3`). Two reasons, and only these two:
  #
  #   * the Resume tail re-derives them from live state, so a buffered copy is a
  #     STALE copy racing the fresh one — `PresenceUpdate` (re-emitted as a
  #     snapshot), `ReadStateSync` and every `Call*` event (`emit_read_state_sync/1`,
  #     `emit_call_sync/1`);
  #   * they are ephemeral by contract and meaningless once replayed late —
  #     `TypingStart` (the client expires an indicator on its own clock).
  #
  # Excluding `PresenceUpdate` also keeps the disconnect path from feeding on
  # itself: `terminate/2` holds the routes and THEN announces the user offline on
  # the workspace key, so the departing session would buffer its own offline
  # presence and replay it after the fresh snapshot that says it is online.
  #
  # The `Call*` exclusion is also the security-relevant one: CALL_* events are
  # visibility-filtered per recipient at the live fan-out (KTD6/AM9 — call
  # existence and rosters are presence-like data for hidden channels), and the
  # offline buffer has no visibility context, so buffering them would deliver
  # hidden-channel call traffic to a session the live path refuses.
  @offline_superseded ~w(
    PresenceUpdate
    ReadStateSync
    TypingStart
    CallStart
    CallUpdate
    CallEnd
    CallRing
    CallSignal
    CallSync
  )

  @doc """
  Should `event_name` be appended to an offline session's resume buffer?
  False only for `offline_superseded_events/0` — everything else a client could
  not otherwise learn about is bufferable.
  """
  @spec offline_bufferable?(String.t()) :: boolean()
  def offline_bufferable?(event_name) when is_binary(event_name),
    do: event_name not in @offline_superseded

  @doc "The events deliberately kept out of a disconnected session's buffer."
  @spec offline_superseded_events() :: [String.t()]
  def offline_superseded_events, do: @offline_superseded
end
