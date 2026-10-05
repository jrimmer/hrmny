defmodule Cytale.Notifications.Dispatcher do
  @moduledoc """
  Turns a delivered event into per-recipient verdicts (plan U4, R1/R4/R16/R21).

  This is the seam between "the message reached the member's sessions" and
  "the member was told". The two are deliberately separate concerns: in-app
  fan-out must never be delayed, altered, or skipped by a notification
  decision, because trading a missed message for a missed notification is
  strictly worse. Nothing here touches delivery.

  ## One decision per member, not per session

  The fan-out works in sessions — a member may have several live sockets. A
  notification is per MEMBER: one event produces at most one interruption.
  Recipients are collapsed by user id, and the reaction-precedence detail
  (which session) is not this module's business.

  ## The focused device is not interrupted

  A member who is looking at the app is already seeing the message, so the
  notification would be noise. `Cytale.Notifications.Focus` answers that, and
  a focused member resolves to `:none` with rule `:focused` — withheld rather
  than demoted, because a badge on a device already displaying the thing is
  also noise.

  ## Cost on the fan-out path

  One preference read per member per event, then a pure decision. The read is
  the only storage work, and it is a single partition read (see
  `Preferences.all/1`). Recipients whose verdict is `:none` produce no
  further work at all.
  """

  require Logger

  alias Cytale.Notifications.{Delivery, Focus, Participations, Policy, Preferences}

  @concerned_events ~w(MessageCreate ThreadMessageCreate)

  @doc """
  Does this event class have a notification policy at all?

  Public so the fan-out can skip the AUDIENCE work for classes `verdicts/4`
  would discard. `members` costs a full member read plus a per-member permission
  resolve for a channel-anchored event, and `subscribed` a second member read;
  the fan-out computes both as eager keyword arguments, so every fan-out event
  paid for them — `TypingStart`, the highest-rate event in the product,
  included — and then the guard in `verdicts/4` threw the result away.
  """
  @spec concerned?(String.t()) :: boolean()
  def concerned?(event_name), do: event_name in @concerned_events

  @typedoc "A live session, as the fan-out registry reports it."
  @type session :: {{pid(), integer()}, integer()}

  @doc """
  Decide and deliver: the single call the fan-out path makes.

  Returns the number of verdicts that were handed to a delivery channel, which
  is what telemetry reports. Every non-push verdict is still computed (a badge
  is a real outcome) but is not delivered here — see `Delivery`.
  """
  @spec dispatch(String.t(), map(), [session()], keyword()) :: non_neg_integer()
  def dispatch(event_name, payload, live, opts \\ []) do
    verdicts = verdicts(event_name, payload, live, opts)

    pushable =
      for {user_id, %{verdict: :push} = resolved} <- verdicts do
        %{
          user_id: user_id,
          verdict: :push,
          rule: resolved.rule,
          level: resolved.level,
          decided_by: resolved.decided_by,
          event_name: event_name,
          payload: payload
        }
      end

    Delivery.deliver(pushable)
    length(pushable)
  end

  @doc """
  The verdicts for one event, one entry per distinct member.

  Returns `[]` for any event this system does not consider, which is every
  event other than message creation. A broader set would need a product
  decision per event class, not a default.

  ## The audience is MEMBERSHIP, and presence only suppresses

  `live` is the fan-out's live subscriber list — sessions currently attached to
  the channel. It is NOT the audience, and treating it as one was this module's
  original bug: a member with the app closed has no live session, so they were
  never a recipient and push could only ever reach people who were already
  connected. That makes push redundant with the thing it exists to back up.

  The audience is therefore `members` — everyone who should be able to read the
  channel, supplied by the caller (which owns visibility). A live session is
  then a REACHABILITY fact: a member with one is reached in-app, and a member
  without one is exactly who a push is for.

  `subscribed` is the third fact: which members hold a push target. Together
  the three answer "should this member be told, and how".
  """
  @spec verdicts(String.t(), map(), [session()], keyword()) :: [{integer(), map()}]
  def verdicts(event_name, payload, live, opts \\ [])

  def verdicts(event_name, _payload, _live, _opts) when event_name not in @concerned_events, do: []

  def verdicts(_event_name, payload, live, opts) do
    event = build_event(payload)
    workspace_id = Keyword.get(opts, :workspace_id) || channel_workspace(payload)
    channel_id = int_or_nil(payload["channel_id"])
    thread_id = int_or_nil(payload["thread_id"])

    # R11's index: the author has now taken part where they posted, which is
    # what later lets a reply reach them through a mute. Recorded here because
    # this is the one place every delivered message already passes through —
    # the eight producers converge on the fan-out, not on a shared function.
    record_participation(event, channel_id, thread_id)

    live_users = distinct_user_ids(live)
    subscribed = Keyword.get(opts, :subscribed, MapSet.new())

    # Membership is the audience. The live list joins it so a member with a
    # session but no subscription is still decided on (their gateway delivery
    # is the reachability, and the in-app surface is theirs to drive).
    #
    # When the caller supplies `:members` it is the VISIBILITY-FILTERED
    # audience, and it is authoritative: a live session (a route subscription
    # is not a view right — the socket filters its own pushes) or a push
    # subscription outside it must never earn a verdict, or a private
    # channel's content would be pushed to whoever merely had a socket open
    # on the workspace. Without `:members` (a direct caller that already
    # scoped `live`), the live list is the audience, as before.
    audience =
      case Keyword.fetch(opts, :members) do
        {:ok, members} ->
          allowed =
            members
            |> Enum.map(&as_integer/1)
            |> Enum.reject(&is_nil/1)
            |> Enum.uniq()

          allowed_set = MapSet.new(allowed)

          (allowed ++ live_users ++ MapSet.to_list(subscribed))
          |> Enum.uniq()
          |> Enum.filter(&MapSet.member?(allowed_set, &1))

        :error ->
          (live_users ++ MapSet.to_list(subscribed)) |> Enum.uniq()
      end

    Enum.map(audience, fn user_id ->
      resolved =
        Policy.decide(event, user_id,
          preferences: Preferences.all(user_id),
          workspace_id: workspace_id,
          channel_id: channel_id,
          thread_id: thread_id
        )

      {user_id, withhold_if_focused(user_id, resolved)}
    end)
  end

  # -- internals -----------------------------------------------------------------

  # The wire payload uses string ids; the member's id in the event is the
  # author's string snowflake. Policy compares author to recipient, so both
  # sides must be the same shape.
  defp build_event(payload) do
    %{
      kind: if(payload["thread_id"], do: :thread_reply, else: :message),
      content: payload["content"],
      author_id: int_or_nil(payload["author_id"]),
      reply_to_author_id: reply_author(payload),
      broadcast_permitted: broadcast_permitted?(payload),
      mention_user_ids: mention_user_ids(payload)
    }
  end

  # The users the SENDER allowed to be notified directly (`allowed_mentions`,
  # decided on the create path and put on the wire as `mention_user_ids`);
  # nil — the key absent — means no restriction.
  defp mention_user_ids(%{"mention_user_ids" => ids}) when is_list(ids),
    do: ids |> Enum.map(&int_or_nil/1) |> Enum.reject(&is_nil/1)

  defp mention_user_ids(_payload), do: nil

  # May this message's `@everyone`/`@here` notify? The create path decided it
  # (and put the verdict on the wire as `mention_everyone`); a payload without
  # the key is resolved here from its author, fail-closed — never assumed.
  defp broadcast_permitted?(payload) do
    case payload["mention_everyone"] do
      verdict when is_boolean(verdict) ->
        verdict

      _ ->
        Cytale.Notifications.BroadcastGate.permitted?(
          payload["content"],
          int_or_nil(payload["author_id"]),
          int_or_nil(payload["channel_id"])
        )
    end
  end

  # A reply's target author is not on the wire payload for every event shape,
  # so this is best-effort: absent means "not a reply", which under-notifies
  # rather than over-notifies.
  defp reply_author(payload) do
    payload["reply_to_author_id"] || get_in(payload, ["referenced", "author_id"]) |> int_or_nil()
  end

  # The registry reports user ids as STRINGS (they are wire snowflakes); the
  # policy and the preference store both key on integers, so everything is
  # normalised here rather than at each comparison.
  defp distinct_user_ids(live) do
    live
    |> Enum.map(fn {_key, user_id} -> as_integer(user_id) end)
    |> Enum.reject(&is_nil/1)
    |> Enum.uniq()
  end

  defp as_integer(value) when is_integer(value), do: value

  defp as_integer(value) when is_binary(value), do: int_or_nil(value)

  defp as_integer(_other), do: nil

  # A thread reply records the thread AND its parent channel: a member who
  # posted in the thread has taken part in the conversation, and one who posted
  # in the channel has taken part where the thread lives — either should lift
  # a mute on the other.
  defp record_participation(%{author_id: author_id}, channel_id, thread_id)
       when is_integer(author_id) do
    Enum.each(Enum.reject([channel_id, thread_id], &is_nil/1), fn entity_id ->
      Participations.record(author_id, entity_id)
    end)
  rescue
    error ->
      # Never cost the message: the index is an optimization for a later
      # decision, and a missed row only means one mute behaves as before.
      Logger.warning("participation record failed: #{inspect(error)}")
      :ok
  end

  defp record_participation(_event, _channel_id, _thread_id), do: :ok

  defp withhold_if_focused(user_id, resolved) do
    if Focus.focused_anywhere?(user_id) do
      %{resolved | verdict: :none, rule: :focused}
    else
      resolved
    end
  end

  defp channel_workspace(payload) do
    with channel_id when is_integer(channel_id) <- int_or_nil(payload["channel_id"]),
         %{workspace_id: workspace_id} <- Cytale.Workspaces.get_channel(channel_id) do
      workspace_id
    else
      _ -> nil
    end
  end

  defp int_or_nil(nil), do: nil

  defp int_or_nil(value) when is_integer(value), do: value

  defp int_or_nil(value) when is_binary(value) do
    case Integer.parse(value) do
      {int, ""} -> int
      _ -> nil
    end
  end

  defp int_or_nil(_other), do: nil
end
