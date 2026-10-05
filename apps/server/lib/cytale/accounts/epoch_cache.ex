defmodule Cytale.Accounts.EpochCache do
  @moduledoc """
  Memo of each account's credential epoch for the per-request check (review
  #19). `Auth.epoch_current?/2` runs on EVERY authenticated request (the auth
  plug) and every gateway Identify, and each run was one `users` row read —
  the first of the ~10 sequential round trips on a send.

  The epoch moves in exactly one place, `Auth.bump_credential_epoch!/1`
  (revoke-all, password reset, account deletion), and that place WRITES
  THROUGH this cache after the database write. Correctness of a revocation
  therefore never waits on a TTL on this node:

    * a bump overwrites the entry with the new value (`put/2`);
    * a miss fills with `:ets.insert_new/2`, so a fill that read the OLD value
      from the database just before a bump can never overwrite the bump's
      entry — it loses the race by construction;
    * an expired entry is removed with `:ets.delete_object/2` (that exact
      entry only — a bump that replaced it in the meantime is kept) before
      the refill.

  The TTL (`@ttl_ms`) only bounds how long an out-of-band change to the row
  (a backup restore, an operator's CQL) takes to be seen. A failed read is
  never cached. The table is owned by this process (long-lived owner); when it
  is not running, callers read the database every time, as before.
  """

  use GenServer

  @table __MODULE__
  @ttl_ms 30_000

  @doc false
  def start_link(opts \\ []), do: GenServer.start_link(__MODULE__, opts, name: __MODULE__)

  @impl true
  def init(_opts) do
    :ets.new(@table, [:set, :named_table, :public, read_concurrency: true, write_concurrency: true])
    {:ok, %{}}
  end

  @doc """
  The account's epoch: the memo when fresh, else `read.()` (which returns
  `{:ok, epoch}` or `:error`) — filled, never overwriting a concurrent bump.
  """
  @spec fetch(integer(), (-> {:ok, non_neg_integer()} | :error)) :: {:ok, non_neg_integer()} | :error
  def fetch(user_id, read) when is_integer(user_id) and is_function(read, 0) do
    now = System.monotonic_time(:millisecond)

    case lookup(user_id) do
      {:fresh, epoch} ->
        {:ok, epoch}

      {:expired, entry} ->
        :ets.delete_object(@table, entry)
        fill(user_id, read, now)

      :miss ->
        fill(user_id, read, now)

      :no_table ->
        read.()
    end
  end

  @doc "Write-through after a bump: the new epoch replaces whatever is held."
  @spec put(integer(), non_neg_integer()) :: :ok
  def put(user_id, epoch) when is_integer(user_id) and is_integer(epoch) do
    :ets.insert(@table, {user_id, epoch, System.monotonic_time(:millisecond) + @ttl_ms})
    :ok
  rescue
    ArgumentError -> :ok
  end

  @doc "Forget an account's entry (the next check reads the database)."
  @spec forget(integer()) :: :ok
  def forget(user_id) when is_integer(user_id) do
    :ets.delete(@table, user_id)
    :ok
  rescue
    ArgumentError -> :ok
  end

  @doc """
  Whether `user_id` is a MACHINE principal (bot/agent/webhook), memoized: an
  id's kind is fixed at mint and never changes, so the entry carries no TTL.
  `read.()` answers `{:ok, boolean}` or `:error`; an error is never cached.
  Lives beside the epoch memo because both guard the same per-request token
  check (`Auth.check_human_subject/1`).
  """
  @spec machine?(integer(), (-> {:ok, boolean()} | :error)) :: {:ok, boolean()} | :error
  def machine?(user_id, read) when is_integer(user_id) and is_function(read, 0) do
    key = {:machine, user_id}

    case :ets.lookup(@table, key) do
      [{^key, verdict}] ->
        {:ok, verdict}

      [] ->
        case read.() do
          {:ok, verdict} = ok ->
            :ets.insert(@table, {key, verdict})
            ok

          :error ->
            :error
        end
    end
  rescue
    ArgumentError -> read.()
  end

  defp lookup(user_id) do
    now = System.monotonic_time(:millisecond)

    case :ets.lookup(@table, user_id) do
      [{^user_id, epoch, expires_at}] when expires_at > now -> {:fresh, epoch}
      [entry] -> {:expired, entry}
      [] -> :miss
    end
  rescue
    ArgumentError -> :no_table
  end

  defp fill(user_id, read, now) do
    case read.() do
      {:ok, epoch} = ok ->
        # insert_new: a bump that landed while we were reading wins.
        _ = :ets.insert_new(@table, {user_id, epoch, now + @ttl_ms})

        case :ets.lookup(@table, user_id) do
          [{^user_id, held, _}] -> {:ok, max(held, epoch)}
          _ -> ok
        end

      :error ->
        :error
    end
  rescue
    ArgumentError -> read.()
  end
end
