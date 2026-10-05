defmodule Cytale.Messages.PointerWriter do
  @moduledoc """
  Deferred, coalesced `last_message_id` pointer writes (review #18).

  `Messages.touch_last_message/2` denormalizes a channel's newest message id
  onto its row (the sidebar badge / unread pointer). It is best-effort by
  contract — the message is already stored and fanned out — yet it ran on the
  send's response path: one UPDATE for a workspace channel, and for a DM a
  `dm_channels` read plus 1 + N UPDATEs (one per participant's `dms_of_user`
  row), all before the 201.

  The native send hands the write here instead and answers immediately. The
  writer holds, per channel, only the HIGHEST id seen since its last flush and
  flushes every `@flush_ms` — so a burst in one channel costs one pointer
  write per tick, not one per message. The route the permission gate already
  resolved rides along, so a DM pointer needs no `dm_channels` read either.

  Ordering: a flush writes the max id it holds; flushes run one at a time in
  this process. That is the same last-writer-wins the synchronous path had
  (two concurrent sends could always land their pointer writes out of order).

  Durability: none beyond best-effort, exactly like the synchronous path it
  replaces — a crash loses at most one tick of pointer writes, and the next
  message in the channel rewrites the pointer. When the writer is not running
  (a hermetic boot), `touch/3` writes synchronously.
  """

  use GenServer

  require Logger

  alias Cytale.Repo

  @flush_ms 10

  @doc false
  def start_link(opts \\ []), do: GenServer.start_link(__MODULE__, :ok, name: Keyword.get(opts, :name, __MODULE__))

  @doc """
  Record `message_id` as `channel_id`'s newest message. `route` is the
  gate's `{:channel, workspace_id}` / `{:dm, dm_row}` or `nil` (unknown —
  the write resolves the kind itself, as `Messages.touch_last_message/2`
  always did).
  """
  #
  # A DM's pointer is written SYNCHRONOUSLY even so: `dms_of_user.last_message_id`
  # is not only a badge — the DM search backfill reads it to decide whether a
  # member's DM index is behind (`TantivyImpl.ensure_dm_current/1`), so a search
  # right after a send must see it. (It no longer pays the `dm_channels` read:
  # the gate's row rides along.)
  @spec touch(integer(), integer(), term()) :: :ok
  def touch(channel_id, message_id, route \\ nil) when is_integer(channel_id) and is_integer(message_id) do
    case {route, Process.whereis(__MODULE__)} do
      {{:dm, _dm}, _writer} -> write(channel_id, message_id, route)
      {_route, nil} -> write(channel_id, message_id, route)
      {_route, pid} -> GenServer.cast(pid, {:touch, channel_id, message_id, route})
    end

    :ok
  end

  @doc "Flush pending pointer writes now (tests, orderly shutdown)."
  @spec flush() :: :ok
  def flush do
    case Process.whereis(__MODULE__) do
      nil -> :ok
      pid -> GenServer.call(pid, :flush)
    end
  end

  @impl true
  def init(:ok) do
    Process.flag(:trap_exit, true)
    {:ok, %{pending: %{}, timer: nil}}
  end

  @impl true
  def handle_cast({:touch, channel_id, message_id, route}, state) do
    pending =
      Map.update(state.pending, channel_id, {message_id, route}, fn {held, held_route} ->
        if message_id > held, do: {message_id, route || held_route}, else: {held, held_route || route}
      end)

    timer = state.timer || Process.send_after(self(), :flush, @flush_ms)
    {:noreply, %{state | pending: pending, timer: timer}}
  end

  @impl true
  def handle_call(:flush, _from, state), do: {:reply, :ok, do_flush(state)}

  @impl true
  def handle_info(:flush, state), do: {:noreply, do_flush(%{state | timer: nil})}
  def handle_info(_msg, state), do: {:noreply, state}

  @impl true
  def terminate(_reason, state) do
    do_flush(state)
    :ok
  end

  defp do_flush(%{pending: pending} = state) do
    Enum.each(pending, fn {channel_id, {message_id, route}} -> write(channel_id, message_id, route) end)

    if state.timer, do: Process.cancel_timer(state.timer)
    %{state | pending: %{}, timer: nil}
  end

  # The write itself — best-effort, never raising (the message is stored).
  # A workspace channel is ONE prepared UPDATE; a DM with its row in hand
  # skips the `dm_channels` read `maybe_touch_dm/2` would do; an unknown
  # route takes the original resolving path.
  defp write(channel_id, message_id, {:channel, _workspace_id}) do
    Repo.query!(
      "UPDATE {{K}}.channels_by_id SET last_message_id = ? WHERE channel_id = ?",
      [{"bigint", message_id}, {"bigint", channel_id}]
    )

    :ok
  rescue
    e -> log_failure(channel_id, e)
  end

  defp write(channel_id, message_id, {:dm, %{user_ids: user_ids}}) do
    Repo.query!(
      "UPDATE {{K}}.dm_channels SET last_message_id = ? WHERE channel_id = ?",
      [{"bigint", message_id}, {"bigint", channel_id}]
    )

    Enum.each(user_ids || [], fn uid ->
      Repo.query!(
        "UPDATE {{K}}.dms_of_user SET last_message_id = ? WHERE user_id = ? AND channel_id = ?",
        [{"bigint", message_id}, {"bigint", uid}, {"bigint", channel_id}]
      )
    end)

    :ok
  rescue
    e -> log_failure(channel_id, e)
  end

  defp write(channel_id, message_id, _unknown), do: Cytale.Messages.touch_last_message(channel_id, message_id)

  defp log_failure(channel_id, e) do
    Logger.warning("last_message_id pointer write failed for #{channel_id}: #{Exception.message(e)}")
    :ok
  end
end
