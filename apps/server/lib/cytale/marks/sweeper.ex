defmodule Cytale.Marks.Sweeper do
  @moduledoc """
  The due-time sweeper (#54 U4, KTD4) — the codebase's first general-purpose
  "do this at time T" machinery, kept deliberately small.

  One supervised process arms ONE timer, on itself (a crash cancels it — no
  stray timer outlives the process), clamped to `Cytale.Marks.sweep_interval_ms/0`.
  Every tick re-derives due-ness from wall-clock `due_at`, never from the
  delay it slept, so the same body serves a live fire and a boot catch-up and
  a clock step cannot move a fire.

  ## One tick

  1. Read the due index for the minute buckets not yet swept (a CURSOR: the
     boot pass walks the whole lookback once, later ticks read the last couple
     of minutes), rows due at or before now, cached `pending` only, at most
     `:batch` of them — the remainder is re-derived next tick, so one
     synchronized minute cannot make one tick do unbounded work.
  2. FENCE each row against the authoritative mark (R14): it acts only while
     that row is `pending` AND names this same `due_at`. Anything else — a
     cancel, a re-set, an orphan — is settled silently: no read-state write, no
     event, no error.
  3. A mark due longer ago than the lookback resolves `missed` — never fired
     late, never left pending.
  4. VIABILITY: the owner still exists and can still read the channel, and the
     target message still exists (not deleted, not tombstoned). Otherwise the
     mark resolves `missed` with a `:dropped` telemetry reason (R8, U8) and
     writes NO read state.
  5. COALESCE per (owner, channel): one floor move to the EARLIEST viable
     target, one event, and every mark in the group `fired`.

  Delivery is at-least-once with an idempotent effect (moving a floor to the
  same message twice is one state), so the hot path needs no LWT.

  Single-node design: one process per node. A second node needs a claim rule
  before it exists (recorded in the plan's risks).
  """

  use GenServer

  require Logger

  alias Cytale.Marks
  alias Cytale.Messages
  alias Cytale.Messages.ReadState
  alias Cytale.Repo

  @default_batch 200

  # -- process --------------------------------------------------------------------

  def start_link(opts \\ []), do: GenServer.start_link(__MODULE__, opts, name: __MODULE__)

  @doc "Whether the sweeper is switched on (a rolled-back deploy can stop fires without a redeploy)."
  def enabled?, do: Application.get_env(:cytale, :marks_sweeper, true)

  @impl true
  def init(_opts) do
    # The boot catch-up is simply the first tick, armed after the pool is up —
    # an unreachable database logs and retries next interval; it never wedges
    # the boot.
    timer = if enabled?(), do: Process.send_after(self(), :tick, 5_000)
    {:ok, %{cursor: nil, timer: timer}}
  end

  @impl true
  def handle_info(:tick, state) do
    now = System.system_time(:millisecond)

    cursor =
      try do
        sweep(now, cursor: state.cursor).cursor
      rescue
        e ->
          Logger.warning("marks sweeper: tick failed (#{Exception.message(e)}); retrying next interval")
          state.cursor
      end

    timer = if enabled?(), do: Process.send_after(self(), :tick, Marks.sweep_interval_ms())
    {:noreply, %{state | cursor: cursor, timer: timer}}
  end

  # -- the sweep body -------------------------------------------------------------

  @doc """
  One sweep at `now_ms`. Options:

    * `:cursor` — the first minute bucket to read (default: the lookback's
      start). The result carries the cursor for the next call.
    * `:scope` — a predicate over index rows; only matching rows are touched.
      Suites pass one so they can never fire a peer suite's rows in a shared
      keyspace.
    * `:batch` — the most index rows acted on this call.

  Returns `%{fired: n, missed: n, settled: n, cursor: bucket}`.
  """
  @spec sweep(integer(), keyword()) :: map()
  def sweep(now_ms, opts \\ []) do
    scope = Keyword.get(opts, :scope, fn _ -> true end)
    batch = Keyword.get(opts, :batch, @default_batch)
    last = Marks.due_bucket(now_ms)
    # Boot (no cursor) walks two lookbacks: the older half is where marks that
    # came due while the node was down too long are resolved `missed`. After
    # that, one bucket behind the cursor — a row written into a minute after
    # the previous tick read it must not be skipped. Clamped either way, so a
    # stale cursor can never turn one tick into an unbounded scan.
    window_start = Marks.due_bucket(now_ms - 2 * Marks.lookback_ms())

    first =
      case Keyword.get(opts, :cursor) do
        nil -> window_start
        cursor -> max(cursor - 1, window_start)
      end

    {rows, cursor} = collect(first, last, now_ms, scope, batch)

    {live, overdue} = Enum.split_with(rows, &(ms(&1.due_at) >= now_ms - Marks.lookback_ms()))

    missed = Enum.count(overdue, &resolve_missed(&1, now_ms))

    {fenced, settled} = fence(live, now_ms)

    {fired, dropped} = fire_groups(fenced, now_ms)

    %{fired: fired, missed: missed + dropped, settled: settled, cursor: cursor}
  end

  # Walk buckets first..last collecting pending rows due by now, up to `batch`.
  # The cursor stops at the first bucket that was NOT fully consumed.
  defp collect(first, last, now_ms, scope, batch) do
    Enum.reduce_while(first..last//1, {[], last}, fn bucket, {acc, _cursor} ->
      rows =
        "SELECT due_bucket, due_at, mark_id, user_id, kind, target_id, channel_id, state FROM {{K}}.message_marks_by_due WHERE due_bucket = ? AND due_at <= ?"
        |> Repo.execute!([{"bigint", bucket}, {"timestamp", DateTime.from_unix!(now_ms, :millisecond)}])
        |> Enum.to_list()
        |> Enum.filter(&(&1["state"] == "pending"))
        |> Enum.map(&row/1)
        |> Enum.filter(scope)

      acc = acc ++ rows

      if length(acc) >= batch,
        do: {:halt, {Enum.take(acc, batch), bucket}},
        else: {:cont, {acc, bucket}}
    end)
  end

  # R14: the authoritative row decides. Returns {actionable, settled_count}.
  defp fence(rows, now_ms) do
    Enum.reduce(rows, {[], 0}, fn row, {ok, settled} ->
      case Marks.get(row.user_id, row.kind, row.target_id) do
        %{state: "pending", due_at: due_at} = mark when due_at == row.due_at ->
          {[mark | ok], settled}

        _superseded_cancelled_or_orphan ->
          settle_index_row(row, now_ms)
          {ok, settled + 1}
      end
    end)
  end

  defp resolve_missed(row, now_ms) do
    case Marks.get(row.user_id, row.kind, row.target_id) do
      %{state: "pending", due_at: due_at} = mark when due_at == row.due_at ->
        :ok = Marks.transition(mark, "missed", now_ms)
        telemetry(:missed, mark.kind, :late)
        true

      _ ->
        settle_index_row(row, now_ms)
        false
    end
  end

  # Coalesce per (owner, channel) AFTER viability, so a group whose earliest
  # target is gone falls back to the earliest viable one — and writes nothing
  # when none is.
  defp fire_groups(marks, now_ms) do
    marks
    |> Enum.group_by(&{&1.user_id, &1.channel_id})
    |> Enum.reduce({0, 0}, fn {{user_id, channel_id}, group}, {fired, dropped} ->
      {viable, gone} =
        case owner_can_read?(user_id, channel_id) do
          true -> Enum.split_with(group, &target_alive?/1)
          false -> {[], group}
        end

      Enum.each(gone, fn mark ->
        :ok = Marks.transition(mark, "missed", now_ms)
        telemetry(:missed, mark.kind, :dropped)
      end)

      case viable do
        [] ->
          {fired, dropped + length(gone)}

        _ ->
          floor = viable |> Enum.map(& &1.target_id) |> Enum.min()
          fire(user_id, channel_id, floor)

          Enum.each(viable, fn mark ->
            :ok = Marks.transition(mark, "fired", now_ms)
            telemetry(:fired, mark.kind, :due)
          end)

          {fired + length(viable), dropped + length(gone)}
      end
    end)
  end

  # The effect (the snooze kind's `:moves_floor`): the target and everything
  # after it become unread for its owner, through the ONE read-state writer.
  # A lower floor the owner already has is kept — more unread, never less.
  defp fire(user_id, channel_id, target_id) do
    current = ReadState.get(user_id, channel_id)

    floor =
      case current do
        %{unread_floor: existing} when is_integer(existing) and existing < target_id -> existing
        _ -> target_id
      end

    :ok = ReadState.write(user_id, channel_id, %{unread_floor: floor})
    # User-addressed: the owner's sessions only — never a channel fan-out.
    :ok = ReadState.broadcast_update(user_id, channel_id)
  end

  defp owner_can_read?(user_id, channel_id) do
    case owner_claims(user_id) do
      nil -> false
      claims -> match?({:ok, _, _}, CytaleWeb.Compat.Authorize.channel_gate(claims, channel_id))
    end
  end

  # The owner's claims, built the way the auth plugs build them: a machine
  # principal's own shape, or a human's with the plug's additive defaults. A
  # deleted account has neither — and so can read nothing.
  defp owner_claims(user_id) do
    case Cytale.Accounts.Principals.get(user_id) do
      %{} = principal ->
        Cytale.Accounts.Principals.claims(principal)

      nil ->
        case Cytale.Accounts.User.get(user_id) do
          # `get/1` still resolves a soft-deleted account (its tombstone): that
          # owner can read nothing either.
          %{username: username, deleted_at: nil} ->
            %{
              user_id: user_id,
              username: username,
              verified: true,
              kind: :human,
              parent_user_id: nil,
              restrictions: nil,
              access: nil
            }

          _ ->
            nil
        end
    end
  end

  # Deleted by its author (the row is gone) or through account deletion (the
  # row survives as a tombstone with its author cleared): either way not a
  # message to bring anyone back to.
  defp target_alive?(mark) do
    case Messages.get_message(mark.channel_id, mark.target_id) do
      %{author_id: author_id} when not is_nil(author_id) -> true
      _ -> false
    end
  end

  defp settle_index_row(row, _now_ms) do
    Repo.execute!(
      "UPDATE {{K}}.message_marks_by_due USING TTL 604800 SET state = 'cancelled' WHERE due_bucket = ? AND due_at = ? AND mark_id = ?",
      [{"bigint", row.due_bucket}, {"timestamp", row.due_at}, {"bigint", row.mark_id}]
    )
  end

  # Labels carry the kind and the terminal state only — never a user, channel
  # or message id (R2: an operator surface must not learn who marked what).
  defp telemetry(state, kind, reason) do
    :telemetry.execute([:cytale, :marks, state], %{count: 1}, %{kind: kind, reason: reason})
  end

  defp row(r) do
    %{
      due_bucket: r["due_bucket"],
      due_at: r["due_at"],
      mark_id: r["mark_id"],
      user_id: r["user_id"],
      kind: r["kind"],
      target_id: r["target_id"],
      channel_id: r["channel_id"]
    }
  end

  defp ms(%DateTime{} = dt), do: DateTime.to_unix(dt, :millisecond)
end
