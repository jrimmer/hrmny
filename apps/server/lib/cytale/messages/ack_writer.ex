defmodule Cytale.Messages.AckWriter do
  @moduledoc """
  The gateway read-ack's storage leg, OFF the socket process (review #20).

  An op-21 `MESSAGE_ACK` used to persist inside the recipient's socket: the
  stored watermark read, the upsert, the member's read state read again, and a
  scan of up to 200 `mention_events` rows — all before that socket could
  handle its next frame or push its next event. A client acking as it scrolls
  queued every dispatch for that member behind its own acks.

  The socket now keeps what it can answer from memory (the id parsing, the
  per-socket "already persisted" memo, the visibility gate against its
  visible-set memo) and hands the write here. `persist/3` is a cast.

  ORDERING — per user. Acks route to one of `@partitions` writer processes by
  `phash2(user_id)`, so every ack of one member is applied by ONE process, in
  arrival order; two devices of the same member can never interleave their
  read-modify-writes. Independent members spread across partitions.

  COALESCING — a burst of acks for the same `{user, scope}` that queues up
  while a write is in flight collapses to the highest watermark: a partition
  merges every ack already in its mailbox before it writes (the `:flush` it
  schedules lands behind them), so a scroll that acks twenty times writes
  once.

  The write itself is `#117`'s, unchanged in meaning: the watermark never
  regresses (the stored value is read back and the older one discarded), and
  the ack answers the mention rows it covers (`Cytale.Inbox.mark_done_through/4`,
  which now skips its read-state read — the value is in hand — and does no
  further work when the member has no open mention in that scope).

  Best-effort, as it was on the socket: a storage failure is logged and the
  next ack retries the same advance. When the writer is not running (a
  hermetic boot), `persist/3` writes synchronously in the caller.
  """

  use Supervisor

  require Logger

  alias Cytale.Messages.ReadState

  @partitions 16

  @doc false
  def start_link(opts \\ []), do: Supervisor.start_link(__MODULE__, opts, name: __MODULE__)

  @impl true
  def init(_opts) do
    children =
      for index <- 0..(@partitions - 1) do
        %{id: {__MODULE__.Partition, index}, start: {__MODULE__.Partition, :start_link, [index]}}
      end

    Supervisor.init(children, strategy: :one_for_one)
  end

  @doc """
  Persist `user_id`'s read watermark for `scope_id` (a channel or thread id)
  at `watermark`, answering the mentions it covers. The caller has already
  authorized the scope.
  """
  @spec persist(integer(), integer(), integer()) :: :ok
  def persist(user_id, scope_id, watermark)
      when is_integer(user_id) and is_integer(scope_id) and is_integer(watermark) do
    case Process.whereis(partition_name(:erlang.phash2(user_id, @partitions))) do
      nil -> write(user_id, scope_id, watermark)
      pid -> GenServer.cast(pid, {:ack, user_id, scope_id, watermark})
    end

    :ok
  end

  @doc "Barrier: every ack cast before this call has been written (tests)."
  @spec await() :: :ok
  def await do
    for index <- 0..(@partitions - 1) do
      case Process.whereis(partition_name(index)) do
        nil -> :ok
        pid -> GenServer.call(pid, :flush, 10_000)
      end
    end

    :ok
  end

  @doc false
  def partition_name(index), do: :"#{__MODULE__}.P#{index}"

  @doc false
  # The write — the storage half `GatewaySocket.persist_ack/3` used to run
  # inline. Never raises.
  @spec write(integer(), integer(), integer()) :: :ok
  def write(user_id, scope_id, watermark) do
    stored = ReadState.get(user_id, scope_id)
    advance = advance_to(stored, watermark)

    if advance != stored_watermark(stored) do
      :ok = ReadState.write(user_id, scope_id, %{last_read_id: advance})
    end

    # The read state is in hand (a watermark write never touches the floor),
    # so the sweep does not read it again.
    Cytale.Inbox.mark_done_through(user_id, scope_id, advance, read_state: stored)
    :ok
  rescue
    e ->
      Logger.warning("read-ack persist failed for #{user_id}/#{scope_id}: #{Exception.message(e)}")
      :ok
  end

  defp stored_watermark(%{last_read_id: id}), do: id
  defp stored_watermark(_), do: nil

  defp advance_to(nil, watermark), do: watermark
  defp advance_to(%{last_read_id: nil}, watermark), do: watermark
  defp advance_to(%{last_read_id: stored}, watermark), do: max(stored, watermark)

  defmodule Partition do
    @moduledoc false
    use GenServer

    alias Cytale.Messages.AckWriter

    def start_link(index), do: GenServer.start_link(__MODULE__, index, name: AckWriter.partition_name(index))

    @impl true
    def init(index), do: {:ok, %{index: index, pending: %{}, scheduled?: false}}

    @impl true
    def handle_cast({:ack, user_id, scope_id, watermark}, state) do
      pending = Map.update(state.pending, {user_id, scope_id}, watermark, &max(&1, watermark))

      # The flush goes to the BACK of the mailbox: every ack already queued is
      # merged before it runs — the coalescing described in the moduledoc.
      unless state.scheduled?, do: send(self(), :flush)
      {:noreply, %{state | pending: pending, scheduled?: true}}
    end

    @impl true
    def handle_info(:flush, state), do: {:noreply, flush(state)}
    def handle_info(_msg, state), do: {:noreply, state}

    @impl true
    def handle_call(:flush, _from, state), do: {:reply, :ok, flush(state)}

    defp flush(state) do
      Enum.each(state.pending, fn {{user_id, scope_id}, watermark} ->
        AckWriter.write(user_id, scope_id, watermark)
      end)

      %{state | pending: %{}, scheduled?: false}
    end
  end
end
