defmodule Cytale.Notifications.Participations do
  @moduledoc """
  Where a member has posted (plan U11, R11).

  This answers one question, asked by the notification resolver: *have they
  taken part here?* A member who has posted in a channel or thread is entitled
  to hear a reply even if they muted the channel — which is the single most
  cited "I missed something addressed to me" cause in both Discord and Slack.
  Both compute the level first and stop; the mute wins and the reply is lost
  with no signal.

  ## Derived, not declared

  Participation is RECORDED when a member's message fans out, not asked of the
  member. A self-declared "I'm interested" flag is a second thing to keep in
  sync with reality and would drift the moment a member posts without ticking
  it. Deriving it means the index can only ever be behind the message table,
  never wrong about it.

  ## Why a dedicated index

  `author_messages` already knows every message a member wrote, but its
  partition holds all of them, and the notification decision runs per message
  per recipient — an unbounded read there would sit on the fan-out path. One
  row per (member, channel) keeps the question a bounded partition read.

  ## The rule raises, never lowers

  See `Cytale.Notifications.Resolver`: participation lifts a muted level to
  mentions, and never demotes a level the member chose. A member who set a
  channel to "all activity" keeps it; one who set "mentions" keeps that too.
  """

  alias Cytale.Repo

  @doc "Record that this member has posted in this channel or thread. Idempotent."
  @spec record(integer(), integer()) :: :ok
  def record(user_id, entity_id) when is_integer(user_id) and is_integer(entity_id) do
    now = DateTime.utc_now() |> DateTime.truncate(:millisecond)

    Repo.execute!(
      "INSERT INTO {{K}}.notification_participations (user_id, entity_id, created_at) VALUES (?, ?, ?)",
      [{"bigint", user_id}, {"bigint", entity_id}, {"timestamp", now}]
    )

    :ok
  end

  @doc "Whether this member has posted in this channel or thread."
  @spec participated?(integer(), integer()) :: boolean()
  def participated?(user_id, entity_id)
      when is_integer(user_id) and is_integer(entity_id) do
    Repo.execute!(
      "SELECT entity_id FROM {{K}}.notification_participations WHERE user_id = ? AND entity_id = ?",
      [{"bigint", user_id}, {"bigint", entity_id}]
    )
    |> Enum.to_list()
    |> case do
      [] -> false
      _ -> true
    end
  end

  @doc "Every entity this member has posted in — the settings surface's read."
  @spec channels_for_user(integer()) :: [integer()]
  def channels_for_user(user_id) when is_integer(user_id) do
    Repo.execute!(
      "SELECT entity_id FROM {{K}}.notification_participations WHERE user_id = ?",
      [{"bigint", user_id}]
    )
    |> Enum.map(& &1["entity_id"])
  end

  @doc """
  Drop a member's whole participation index. The lifecycle hook, alongside
  preferences and subscriptions (R19).
  """
  @spec delete_all_for_user(integer()) :: :ok
  def delete_all_for_user(user_id) when is_integer(user_id) do
    Repo.execute!(
      "DELETE FROM {{K}}.notification_participations WHERE user_id = ?",
      [{"bigint", user_id}]
    )

    :ok
  end
end
