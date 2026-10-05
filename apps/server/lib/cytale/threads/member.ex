defmodule Cytale.Threads.Member do
  @moduledoc """
  Thread follow state (U12) — follow/unfollow, notify flag, last_read_id, and
  the two-tier unread badge.

  Follow-on-reply-opt-out default: a user who replies to a thread is
  auto-followed (notify=true) unless they have explicitly unfollowed it. An
  explicit unfollow removes the row; a later reply does NOT re-follow (the
  opt-out is sticky).

  Unread tiers (per plan):
    * `:notified` — notify == true AND unread (orange)
    * `:unread`   — notify == false AND unread (gray)
    * `:read`     — not unread
  """

  alias Cytale.Repo
  alias Cytale.Threads.Thread

  @typedoc "A thread-membership row (integer-native ids)."
  @type t :: %{
          thread_id: integer(),
          user_id: integer(),
          joined_at: DateTime.t(),
          notify: boolean(),
          last_read_id: integer() | nil
        }

  @doc "Follow a thread (notify=true by default). Idempotent."
  @spec follow(integer(), integer(), boolean()) :: :ok
  def follow(thread_id, user_id, notify \\ true)
      when is_integer(thread_id) and is_integer(user_id) and is_boolean(notify) do
    now = DateTime.utc_now() |> DateTime.truncate(:millisecond)

    case get(thread_id, user_id) do
      nil ->
        Repo.execute!(
          "INSERT INTO {{K}}.thread_members (thread_id, user_id, joined_at, notify, last_read_id) VALUES (?, ?, ?, ?, ?)",
          [{"bigint", thread_id}, {"bigint", user_id}, {"timestamp", now}, {"boolean", notify}, {"bigint", nil}]
        )

        Repo.execute!(
          "INSERT INTO {{K}}.thread_members_by_user (user_id, thread_id, joined_at, notify, last_read_id) VALUES (?, ?, ?, ?, ?)",
          [{"bigint", user_id}, {"bigint", thread_id}, {"timestamp", now}, {"boolean", notify}, {"bigint", nil}]
        )

        Thread.bump_member_count(thread_id)

      %{} ->
        # Already following: just update the notify flag (idempotent re-follow).
        set_notify(thread_id, user_id, notify)
    end

    :ok
  end

  @doc """
  LEAVE a thread outright (compat thread-members/@me, bots plan B-2 —
  Discord's thread leave removes the membership): both membership rows are
  deleted and the thread's member_count decrements. Idempotent — leaving a
  thread with no membership row is a no-op `:ok` (distinct from
  `unfollow/2`, which mutes but keeps the row).
  """
  @spec leave(integer(), integer()) :: :ok
  def leave(thread_id, user_id) when is_integer(thread_id) and is_integer(user_id) do
    case get(thread_id, user_id) do
      nil ->
        :ok

      %{} ->
        Repo.execute!(
          "DELETE FROM {{K}}.thread_members WHERE thread_id = ? AND user_id = ?",
          [{"bigint", thread_id}, {"bigint", user_id}]
        )

        Repo.execute!(
          "DELETE FROM {{K}}.thread_members_by_user WHERE user_id = ? AND thread_id = ?",
          [{"bigint", user_id}, {"bigint", thread_id}]
        )

        Thread.decrement_member_count(thread_id)
    end

    :ok
  end

  @doc """
  Unfollow a thread: sets notify=false (muted) and keeps the row. The muted
  row IS the follow-on-reply opt-out — a later reply does NOT re-follow
  (sticky), and new replies accrue as the gray `:unread` tier, not orange
  `:notified`.
  """
  @spec unfollow(integer(), integer()) :: :ok
  def unfollow(thread_id, user_id) when is_integer(thread_id) and is_integer(user_id) do
    case get(thread_id, user_id) do
      nil ->
        # Not following at all — nothing to mute.
        :ok

      %{} ->
        set_notify(thread_id, user_id, false)
    end

    :ok
  end

  @doc "Set the notify flag on an existing membership."
  @spec set_notify(integer(), integer(), boolean()) :: :ok
  def set_notify(thread_id, user_id, notify)
      when is_integer(thread_id) and is_integer(user_id) and is_boolean(notify) do
    Repo.execute!(
      "UPDATE {{K}}.thread_members SET notify = ? WHERE thread_id = ? AND user_id = ?",
      [{"boolean", notify}, {"bigint", thread_id}, {"bigint", user_id}]
    )

    Repo.execute!(
      "UPDATE {{K}}.thread_members_by_user SET notify = ? WHERE user_id = ? AND thread_id = ?",
      [{"boolean", notify}, {"bigint", user_id}, {"bigint", thread_id}]
    )

    :ok
  end

  @doc "Advance the user's last_read_id in a thread (open/scroll). Never regresses."
  @spec mark_read(integer(), integer(), integer()) :: :ok
  def mark_read(thread_id, user_id, last_read_id)
      when is_integer(thread_id) and is_integer(user_id) and is_integer(last_read_id) do
    current = get(thread_id, user_id)

    if current && (is_nil(current.last_read_id) or last_read_id > current.last_read_id) do
      Repo.execute!(
        "UPDATE {{K}}.thread_members SET last_read_id = ? WHERE thread_id = ? AND user_id = ?",
        [{"bigint", last_read_id}, {"bigint", thread_id}, {"bigint", user_id}]
      )

      Repo.execute!(
        "UPDATE {{K}}.thread_members_by_user SET last_read_id = ? WHERE user_id = ? AND thread_id = ?",
        [{"bigint", last_read_id}, {"bigint", user_id}, {"bigint", thread_id}]
      )
    end

    :ok
  end

  @doc """
  Clear the thread's watermark (Mark Unread): every reply counts as new.

  Explicit clearing rather than a `mark_read` with a null, because the two are
  different instructions — a null there means "leave it alone". It writes the
  same nil to both views so neither can go on reporting a read position the
  other has dropped.
  """
  @spec clear_read(integer(), integer()) :: :ok
  def clear_read(thread_id, user_id) when is_integer(thread_id) and is_integer(user_id) do
    Repo.execute!(
      "UPDATE {{K}}.thread_members SET last_read_id = ? WHERE thread_id = ? AND user_id = ?",
      [{"bigint", nil}, {"bigint", thread_id}, {"bigint", user_id}]
    )

    Repo.execute!(
      "UPDATE {{K}}.thread_members_by_user SET last_read_id = ? WHERE user_id = ? AND thread_id = ?",
      [{"bigint", nil}, {"bigint", user_id}, {"bigint", thread_id}]
    )

    :ok
  end

  @doc """
  The user ids holding a membership row on a thread — the thread partition
  read, used by `Thread.delete/2` to clear the by-user index before the
  partition itself goes.
  """
  @spec user_ids(integer()) :: [integer()]
  def user_ids(thread_id) when is_integer(thread_id) do
    Repo.execute!(
      "SELECT user_id FROM {{K}}.thread_members WHERE thread_id = ?",
      [{"bigint", thread_id}]
    )
    |> Enum.map(& &1["user_id"])
  end

  @doc "Fetch a membership row."
  @spec get(integer(), integer()) :: t() | nil
  def get(thread_id, user_id) when is_integer(thread_id) and is_integer(user_id) do
    rows =
      Repo.execute!(
        "SELECT thread_id, user_id, joined_at, notify, last_read_id FROM {{K}}.thread_members WHERE thread_id = ? AND user_id = ?",
        [{"bigint", thread_id}, {"bigint", user_id}]
      )
      |> Enum.to_list()

    case rows do
      [r] -> row_to_member(r)
      [] -> nil
    end
  end

  @doc """
  Auto-follow-on-reply (follow-on-reply-opt-out default): a user who replies
  to a thread is followed (notify=true) UNLESS they have a membership row
  already — a muted row (notify=false, from an explicit unfollow) is the
  sticky opt-out and is left untouched. Returns `:ok`.
  """
  @spec ensure_followed_on_reply(integer(), integer()) :: :ok
  def ensure_followed_on_reply(thread_id, user_id)
      when is_integer(thread_id) and is_integer(user_id) do
    case get(thread_id, user_id) do
      nil -> follow(thread_id, user_id, true)
      %{} -> :ok
    end

    :ok
  end

  @doc """
  Unread tier for a user in a thread: `:notified` | `:unread` | `:read`.
  Requires the thread's latest_reply_id (from `Thread.get/1`).
  """
  @spec unread_tier(t() | nil, map()) :: :notified | :unread | :read
  def unread_tier(member, thread) do
    latest = thread && thread.latest_reply_id

    unread? =
      member != nil and latest != nil and
        (is_nil(member.last_read_id) or latest > member.last_read_id)

    cond do
      not unread? -> :read
      member.notify -> :notified
      true -> :unread
    end
  end

  @doc """
  All followed-thread state for a user across workspaces — the THREAD_LIST_SYNC
  payload source (U23/U22 call this on READY/resume). Returns a list of
  `%{thread: Thread.t(), member: Member.t()}` pairs.
  """
  @spec followed_threads(integer()) :: [{Thread.t(), t()}]
  def followed_threads(user_id) when is_integer(user_id) do
    rows =
      Repo.execute!(
        "SELECT user_id, thread_id, joined_at, notify, last_read_id FROM {{K}}.thread_members_by_user WHERE user_id = ?",
        [{"bigint", user_id}]
      )
      |> Enum.to_list()

    Enum.flat_map(rows, fn r ->
      member = row_to_member(r)

      case Thread.get(member.thread_id) do
        nil -> []
        thread -> [{thread, member}]
      end
    end)
  end

  # -- Internals ---------------------------------------------------------------

  defp row_to_member(r) do
    %{
      thread_id: r["thread_id"],
      user_id: r["user_id"],
      joined_at: r["joined_at"],
      notify: r["notify"],
      last_read_id: r["last_read_id"]
    }
  end
end
