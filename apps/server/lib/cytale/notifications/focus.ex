defmodule Cytale.Notifications.Focus do
  @moduledoc """
  Which of a member's sessions is being looked at (plan U5, R16).

  Delivery needs this to keep one event from notifying every device. Without
  it, a member with a laptop and a phone gets two notifications for a message
  already open on one of them — the failure that makes people turn
  notifications off, which is worse than missing one.

  ## Focus is per member, not per session

  The question delivery asks is "is this member looking at the app anywhere",
  not "which socket". So the store keys by member and remembers the session
  that last claimed focus; a report from a second session takes focus from the
  first, because a member is looking at one screen at a time.

  ## Staleness resolves toward NOTIFIED

  A client that crashes, is suspended, or loses its network never sends the
  "not focused any more" report. If a stale claim could keep suppressing
  pushes, a member's other devices would go quiet with no way to recover —
  the exact failure this feature exists to prevent. So a report older than the
  window is treated as unfocused, and the sweep drops it.

  This is deliberately the opposite trade from dedup: a stale entry costs one
  redundant notification, while honouring it costs silence.

  ## Presence is not a substitute

  The `dnd` and `idle` presence statuses are values the member *chooses* from
  a picker. Using them as a focus proxy would mean a member who set Idle while
  actively reading stops hearing about anything, and a member whose client is
  genuinely hidden but whose status says Online keeps being interrupted.
  """

  use GenServer

  @table :cytale_notification_focus
  @stale_after_seconds 120
  @sweep_interval_ms 30_000

  # -- public API ----------------------------------------------------------------

  @doc "Supervisor child entry point."
  @spec start_link(keyword()) :: GenServer.on_start()
  def start_link(_opts \\ []) do
    GenServer.start_link(__MODULE__, :ok, name: __MODULE__)
  end

  @doc """
  Idempotent start for unit tests, which exercise the store without booting the
  whole application tree.
  """
  @spec ensure_started() :: :ok
  def ensure_started do
    case start_link() do
      {:ok, _pid} -> :ok
      {:error, {:already_started, _pid}} -> :ok
    end
  end

  @doc "How long a focus report stays valid without a refresh."
  @spec stale_after_seconds() :: pos_integer()
  def stale_after_seconds, do: @stale_after_seconds

  @doc """
  Record whether `session_id` is focused for `user_id`.

  A `false` report clears the member's focus only when that session is the one
  holding it, so a backgrounded tab cannot steal focus from the tab in front.
  """
  @spec report(integer(), String.t(), boolean()) :: :ok
  def report(user_id, session_id, focused) when is_integer(user_id) and is_binary(session_id) do
    if focused do
      report_at(user_id, session_id, DateTime.utc_now())
    else
      clear_if_holder(user_id, session_id)
    end
  end

  @doc """
  The same report with an explicit timestamp. Exists so tests can exercise
  staleness without sleeping; production callers use `report/3`.
  """
  @spec report_at(integer(), String.t(), DateTime.t()) :: :ok
  def report_at(user_id, session_id, %DateTime{} = at)
      when is_integer(user_id) and is_binary(session_id) do
    ensure_table()
    :ets.insert(table(), {user_id, session_id, at})
    :ok
  end

  @doc "Whether this member is currently looking at the app in `session_id`."
  @spec focused?(integer(), String.t() | nil) :: boolean()
  def focused?(_user_id, nil), do: false

  def focused?(user_id, session_id)
      when is_integer(user_id) and is_binary(session_id) do
    ensure_table()

    case :ets.lookup(table(), user_id) do
      [{^user_id, ^session_id, at}] -> fresh?(at)
      _ -> false
    end
  end

  @doc "Whether this member is looking at the app in ANY session."
  @spec focused_anywhere?(integer()) :: boolean()
  def focused_anywhere?(user_id) when is_integer(user_id) do
    ensure_table()

    case :ets.lookup(table(), user_id) do
      [{^user_id, _session_id, at}] -> fresh?(at)
      _ -> false
    end
  end

  @doc "Drop focus for a session, on disconnect or on an explicit blur."
  @spec clear(integer(), String.t()) :: :ok
  def clear(user_id, session_id) when is_integer(user_id) and is_binary(session_id) do
    clear_if_holder(user_id, session_id)
  end

  # -- GenServer -----------------------------------------------------------------

  @impl true
  def init(:ok) do
    ensure_table()
    schedule_sweep()
    {:ok, %{}}
  end

  @impl true
  def handle_info(:sweep, state) do
    ensure_table()

    :ets.foldl(
      fn
        {user_id, _session_id, at}, acc ->
          if fresh?(at), do: acc, else: drop(user_id)
      end,
      :ok,
      table()
    )

    schedule_sweep()
    {:noreply, state}
  end

  def handle_info(_other, state), do: {:noreply, state}

  # -- internals -----------------------------------------------------------------

  defp clear_if_holder(user_id, session_id) do
    ensure_table()

    case :ets.lookup(table(), user_id) do
      [{^user_id, ^session_id, _at}] -> :ets.delete(table(), user_id)
      _ -> false
    end

    :ok
  end

  defp drop(user_id) do
    :ets.delete(table(), user_id)
    :ok
  end

  defp fresh?(at) do
    DateTime.diff(DateTime.utc_now(), at, :second) < @stale_after_seconds
  end

  defp schedule_sweep, do: Process.send_after(self(), :sweep, @sweep_interval_ms)

  # A public named table so a socket process can read it without a GenServer
  # round trip: delivery asks this question once per recipient, and a serialized
  # call there would become the fan-out's bottleneck.
  defp ensure_table do
    case :ets.whereis(@table) do
      :undefined ->
        try do
          :ets.new(@table, [:named_table, :public, :set, read_concurrency: true])
        rescue
          ArgumentError -> @table
        end

      _tid ->
        @table
    end
  end

  defp table, do: @table
end
