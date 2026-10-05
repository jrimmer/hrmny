defmodule Cytale.Calls.RoomSupervisor do
  @moduledoc """
  Thin wrapper over the voice-plan U3 `Cytale.Calls.RoomSupervisor`
  DynamicSupervisor. Rooms start lazily on first call start and restart only
  on ABNORMAL exit (:transient — a crashed room re-adopts its open `calls`
  row and lets the empty sweep end the stale call, see `Cytale.Calls.Room`;
  the deliberate end-of-call stop is final, never a restart loop).
  """

  use DynamicSupervisor

  @doc false
  @spec start_link(term()) :: Supervisor.on_start()
  def start_link(init_arg), do: DynamicSupervisor.start_link(__MODULE__, init_arg, name: __MODULE__)

  @doc """
  Ensure the room for `channel_id` is running. `{:already_started, pid}`
  (the one-live registry race, AM16) is normalized to `{:ok, pid}` — the
  caller resolves the lost race as a JOIN of the live call.
  """
  @spec start_room(integer(), integer(), keyword()) :: {:ok, pid()} | {:error, term()}
  def start_room(channel_id, started_by, opts \\ []) when is_integer(channel_id) do
    child = {Cytale.Calls.Room, Keyword.merge(opts, channel_id: channel_id, started_by: started_by)}

    case DynamicSupervisor.start_child(__MODULE__, child) do
      {:ok, pid} -> {:ok, pid}
      {:error, {:already_started, pid}} -> {:ok, pid}
      {:error, reason} -> {:error, reason}
    end
  end

  @doc """
  Terminate and REMOVE the room child (DynamicSupervisor semantics: the
  child is not restarted) — the crash tests' hard-stop, and the shape a
  future admin force-end would take.
  """
  @spec stop_room(pid()) :: :ok | {:error, term()}
  def stop_room(pid) when is_pid(pid) do
    DynamicSupervisor.terminate_child(__MODULE__, pid)
  end

  @impl true
  def init(_init_arg), do: DynamicSupervisor.init(strategy: :one_for_one)
end
