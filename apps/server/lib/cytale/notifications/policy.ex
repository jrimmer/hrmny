defmodule Cytale.Notifications.Policy do
  @moduledoc """
  The one function that decides whether an event notifies a member (plan U3,
  R1/R2/R4/R9).

  Before this module there was no event policy at all: which events would
  notify was undefined, so there was nothing to reason about and nothing to
  change. Discord's equivalent is a cascade of per-device conditionals, which
  is why a member can hold two settings that look correct and cancel each
  other invisibly.

  ## Pure by construction

  The policy takes the member's already-loaded preference map rather than
  reading storage. The fan-out path calls this once per recipient, so a
  database read here would put a round trip on the hot path; keeping it pure
  also means every combination is testable without a socket, which is how the
  taxonomy stays honest.

  ## The decision carries its reason

  Every verdict names the rule and the layer that produced it. The reason is
  not a log line: it is the data the "why did / didn't this reach me" surface
  renders. A wrong reason is a visible defect even when the verdict is right,
  because the whole point of the feature is that the member can see what the
  system did and why.

  ## Order of evaluation

  The own-message guard comes first — a member is never notified about their
  own post, however it is addressed, including a self-mention. Then the
  explicit mute, which is the member's most direct instruction and outranks
  every event class. Then the event class itself: a direct message is
  addressed by construction, a mention is addressed by token, and everything
  else is ordinary traffic whose fate the resolved level decides.
  """

  alias Cytale.Messages.AllowedMentions
  alias Cytale.Notifications.{Mentions, Preferences, Resolver}

  @typedoc "What the member's devices should do with this event."
  @type verdict :: :push | :badge | :none

  @typedoc "Which rule decided. Stable atoms, safe to render as a reason."
  @type rule ::
          :own_message
          | :muted
          | :participated
          | :focused
          | :direct_message
          | :direct_mention
          | :broadcast_mention
          | :reply_to_me
          | :thread_reply
          | :channel_message

  @typedoc "The event under consideration."
  @type event :: %{
          required(:kind) => :message | :dm | :thread_reply,
          optional(:content) => String.t() | nil,
          optional(:author_id) => integer() | nil,
          optional(:reply_to_author_id) => integer() | nil,
          optional(:thread_id) => integer() | nil
        }

  @typedoc "A decision plus the provenance the surfaces render."
  @type decision :: %{
          verdict: verdict(),
          rule: rule(),
          level: String.t(),
          decided_by: atom(),
          explicit?: boolean()
        }

  @doc """
  Decide for one recipient.

  Options: `:preferences` (the member's loaded overrides, required),
  `:workspace_id`, `:channel_id`, `:thread_id`, `:account_entity`.

  `:preferences` is required rather than loaded here on purpose. The fan-out
  path decides once per recipient, so a read in this function would put a
  round trip per recipient on the hot path; requiring the map also keeps this
  module pure, which is what makes every combination in the taxonomy testable
  without a socket.
  """
  @spec decide(event(), integer(), keyword()) :: decision()
  def decide(event, recipient_id, opts) when is_integer(recipient_id) do
    preferences = Keyword.fetch!(opts, :preferences)

    # `:resolved_override` injects an already-resolved level, which exists so
    # the classification rules can be exercised against a provenance the
    # resolver's own I/O would otherwise have to produce (notably the
    # participation sweep, whose resolution needs a participation index). The
    # resolver has its own tests for producing these; this seam is for
    # consuming them.
    resolved =
      Keyword.get_lazy(opts, :resolved_override, fn ->
        Resolver.resolve(
          user_id: recipient_id,
          workspace_id: Keyword.get(opts, :workspace_id),
          channel_id: Keyword.get(opts, :channel_id),
          thread_id: Keyword.get(opts, :thread_id),
          account_entity: Keyword.get(opts, :account_entity, Preferences.account_entity()),
          # The already-loaded map, so the walk does no storage read.
          preferences: preferences
        )
      end)

    # The broadcast switch is read from the SAME loaded map — no extra read on
    # the per-recipient path (see `Preferences` on why it shares the table).
    suppress? = Preferences.suppresses_broadcasts?(preferences, Keyword.get(opts, :workspace_id))

    {verdict, rule} = classify(event, recipient_id, resolved, suppress?)

    Map.merge(resolved, %{verdict: verdict, rule: rule})
  end

  # -- classification ------------------------------------------------------------

  defp classify(event, recipient_id, resolved, suppress_broadcasts?) do
    level = resolved.level

    cond do
      # Their own post, however it is addressed — including a self-mention.
      event[:author_id] == recipient_id ->
        {:none, :own_message}

      event[:kind] == :dm ->
        classify_dm(resolved)

      level == "mute" ->
        {:none, :muted}

      true ->
        classify_content(event, recipient_id, level, resolved.decided_by, suppress_broadcasts?)
    end
  end

  # A DM is addressed by construction, so no level below mute can demote it to
  # a badge. A mute still silences it — muting a direct conversation is the
  # only way to quiet one — but only a level that could actually reach this
  # conversation counts: a thread level the caller happened to pass alongside
  # the channel is not about this DM, and must not silence it.
  defp classify_dm(%{level: "mute", decided_by: decided_by}) when decided_by != :thread,
    do: {:none, :muted}

  defp classify_dm(_resolved), do: {:push, :direct_message}

  # `decided_by` is the layer that resolved the level, which matters in exactly
  # one case: the participation sweep (R11) raised a mute. Then the ordinary
  # branch rule would report `:channel_message` — which contradicts a mute the
  # member set and can see — so preference is reported instead.
  #
  # A branch that is ITSELF self-explaining keeps its own name: a direct
  # mention notifies because it mentioned them, whatever lifted the level, and
  # reporting "you participated" there would hide the more useful fact.
  defp classify_content(event, recipient_id, level, decided_by, suppress_broadcasts?) do
    content = event[:content]

    reason = fn specific ->
      if decided_by == :participation, do: :participated, else: specific
    end

    # The sender's `allowed_mentions` (the create path's `mention_user_ids`;
    # nil = no restriction) decides whether a direct mention or a reply may
    # reach this member AS one. Suppressed, the message is ordinary traffic.
    allowed? = AllowedMentions.notifies?(event[:mention_user_ids], recipient_id)

    cond do
      allowed? and Mentions.mentions_user?(content, recipient_id) ->
        {Resolver.allows?(level, %{kind: :mentions_me, mentions_me: true}), :direct_mention}

      # A broadcast only counts when its author held `mention_everyone`
      # (`event[:broadcast_permitted]`, decided by the dispatcher —
      # `BroadcastGate`); otherwise the token is plain text and the message is
      # ordinary traffic below.
      broadcast?(event) and not suppress_broadcasts? ->
        # Owner direction 2026-09-27: "Mentions only" INCLUDES @everyone and
        # @here — a broadcast addresses the member, so it notifies at the same
        # levels a direct mention does. It keeps its own rule name because a
        # member's willingness to receive them is a separate switch
        # ("Suppress @everyone and @here", per workspace), and the explainer
        # must be able to say which of the two reached them.
        {Resolver.allows?(level, %{kind: :mentions_me, mentions_me: true}), reason.(:broadcast_mention)}

      broadcast?(event) ->
        # Suppressed: the broadcast is ordinary traffic for this member, so
        # "mentions" demotes it to a badge while "all" still pushes it (all
        # activity is all activity). The rule still names the broadcast, so
        # "why didn't @everyone reach me" has an honest answer.
        {Resolver.allows?(level, %{kind: :message, mentions_me: false}), reason.(:broadcast_mention)}

      allowed? and event[:reply_to_author_id] == recipient_id ->
        {Resolver.allows?(level, %{kind: :reply_to_me, mentions_me: false}), :reply_to_me}

      event[:kind] == :thread_reply ->
        {Resolver.allows?(level, %{kind: :message, mentions_me: false}), reason.(:thread_reply)}

      true ->
        {Resolver.allows?(level, %{kind: :message, mentions_me: false}), reason.(:channel_message)}
    end
  end

  defp broadcast?(event),
    do: event[:broadcast_permitted] == true and Mentions.broadcast?(event[:content])
end
