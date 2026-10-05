defmodule Cytale.Gateway.SessionStore do
  @moduledoc """
  Gateway session persistence (U10): the authoritative session_id →
  `%Cytale.Gateway.Session{}` map, surviving socket-process death for the
  resume window (target 5 min / hard floor 10 min via `Cytale.Config`).

  ## Layout: 8 record shards + one principal-table owner

  This module is a FACADE + supervisor. Eight long-lived
  `Cytale.Gateway.SessionStore.Shard` GenServers each own one slice of the
  session records — routed by `:erlang.phash2(session_id)`, so a session's
  record and its `{:claim_marker, session_id}` uniqueness row always share
  a shard and can never disagree across shards. One long-lived
  `Cytale.Gateway.SessionStore.Index` owns the PRINCIPAL-scoped tables
  (the `PrincipalIndex` bag and the KTD15 `PrincipalSlots` table). All
  tables run `write_concurrency: true` — concurrent writers to different
  rows never contend on a table lock.

  The principal tables deliberately stay UNIFIED: their traffic is
  per-connection lifecycle (Identify/terminate), not per-event, and the
  pid-keyed release paths (`untrack_principal/1`, `release_principal_slots/1`
  — the caller knows only its own pid) would need an all-shard scan if the
  rows were scattered. Per-principal cap exclusivity is `insert_new`
  atomicity on ONE table — byte-identical semantics to the pre-shard store.

  ## Lock-free hot path vs GenServer serialization

  A session record is only ever mutated by the socket process currently
  holding its per-session live claim (the single-writer invariant), so the
  HOT operations run as direct ETS read-modify-write IN THE OWNING SOCKET
  with zero GenServer hops:

    * dispatch buffering — `update_local/2` from the socket's
      `buffer_dispatch` (seq stamp + resume-buffer append + watermark/cap
      bounding);
    * heartbeat stamping — `update_local/2` from the socket's op-1 handler.

  The atomic primitives (claim/slot `insert_new`, single-key
  insert/delete) are likewise direct ETS ops — atomicity comes from ETS
  itself, not from process serialization.

  Every write above (and this module's `put/1`/`update/1`/`delete/1`) runs
  `Shard.reconcile/4` beside the record write, keeping the shard's sweep
  index + connected count true (PERF-04) — a live→live write, the whole hot
  path, touches no sweep structure; the writer's own process performs the
  paired writes, which is what makes them safe (the single-writer invariant,
  detailed in `Shard`'s moduledoc).

  The owning shard's GenServer serializes only what genuinely needs it:

    * `update_with/2` — RESERVED for correctness-critical read-modify-write
      (today: Resume adoption — the token consume + revive that must not
      interleave with a competing Resume's adoption of the same session on
      the same shard);
    * the per-shard expiry sweep (every second, per shard).

  Session-id uniqueness is an ETS `insert_new` on
  `{:claim_marker, session_id}`: first claim wins, any second connection is
  refused (`already_claimed`) — preventing double-write corruption when two
  connections race to resume one session.

  ## Principal→session index (KTD6 teardown machinery)

  The PrincipalIndex bag (`Cytale.Gateway.SessionStore.Index`) maps
  principal id → `{pid, session_id}` per LIVE socket. The owning socket
  process registers at Identify/Resume success and unregisters in
  `terminate/1` (mirroring how `put`/`delete` are socket-driven today);
  dead pids are filtered at read time, so a crashed socket never poisons a
  teardown. On top of the index:

    * `close_principal_sessions/2` — revocation teardown: close every live
      socket of the principal with the given close code (4004 — dead
      credential, non-reconnectable) AND purge the stored records so Resume
      cannot resurrect them;
    * `reconnect_principal_sessions/1` — restriction-profile teardown: send
      the reconnectable Reconnect signal to every live socket of the
      principal AND purge the stored records — the credential stays valid
      (4004 would brick every live bot client), but a post-teardown Resume
      is refused so the client MUST re-Identify and pick up the narrowed
      profile (a Resume would otherwise resurrect the pre-narrowing
      restrictions frozen in the stored record).

  A teardown's `delete/1` purges each session on the session's OWN shard
  (the index lookup is principal-scoped, the deletes session-routed — no
  cross-table atomicity is needed; each delete is independent).

  In-flight REST requests complete either way — revocation bounds the NEXT
  action; no request-cancellation machinery exists by design. A hot-path
  write racing the purge has the same window it always had (read-then-write
  vs a concurrent delete — the close signal reaches the socket BEFORE the
  purge, so the resurrecting writer is already on its way to stop).
  """

  require Logger

  alias Cytale.Gateway.PushRegistry
  alias Cytale.Gateway.Session
  alias Cytale.Gateway.SessionStore.Index
  alias Cytale.Gateway.SessionStore.Shard

  @shard_count 8
  @update_timeout 5_000

  # -- Supervision (the shard owners are the table owners) ---------------------

  @doc "Starts the supervisor over the #{@shard_count} record shards + the principal-table owner."
  @spec start_link(keyword()) :: Supervisor.on_start()
  def start_link(_opts \\ []) do
    children =
      for index <- 0..(shard_count() - 1) do
        %{id: {Shard, index}, start: {Shard, :start_link, [index]}}
      end

    Supervisor.start_link(children ++ [Index],
      strategy: :one_for_one,
      name: __MODULE__.Supervisor
    )
  end

  @doc false
  def child_spec(opts) do
    %{
      id: __MODULE__,
      start: {__MODULE__, :start_link, [opts]},
      type: :supervisor
    }
  end

  @doc "Number of record shards (records + claim markers route by session_id)."
  @spec shard_count() :: pos_integer()
  def shard_count, do: @shard_count

  # -- Record operations -----------------------------------------------------

  @doc "Track `session`. Crashes on duplicate session_id ids (ids are minted unique upstream)."
  @spec put(Session.t()) :: {:ok, Session.t()}
  def put(%Session{} = session) do
    table = records_table(session.session_id)

    # PERF-04: the sweep structures ride every record write. The lookup keeps
    # the (upstream-impossible) overwrite case counted honestly instead of
    # double-counting a session that was already here.
    old =
      case :ets.lookup(table, session.session_id) do
        [{_sid, %Session{} = rec}] -> rec
        _ -> nil
      end

    true = :ets.insert(table, {session.session_id, session})
    Shard.reconcile(shard_index(session.session_id), session.session_id, old, session)
    {:ok, session}
  end

  @doc "Fetch the current record."
  @spec get(String.t()) :: Session.t() | nil
  def get(session_id) do
    case :ets.lookup(records_table(session_id), session_id) do
      [{_k, %Session{} = s}] -> s
      [] -> nil
    end
  end

  @doc "Replace the full record (single writer: the live-claim holder)."
  @spec update(Session.t()) :: :ok | {:error, :not_found}
  def update(%Session{} = session) do
    table = records_table(session.session_id)

    case :ets.lookup(table, session.session_id) do
      [{_sid, %Session{} = old}] ->
        :ets.insert(table, {session.session_id, session})
        # PERF-04: this is the socket's disconnect stamp (live → dropped) and
        # the resume path's revive (dropped → live) — both transitions the
        # sweep structures key on.
        Shard.reconcile(shard_index(session.session_id), session.session_id, old, session)
        :ok

      # Unreachable via the helpers (every writer stores %Session{}), but the
      # old member-check path overwrote such a row rather than raising — kept.
      _corrupt ->
        :ets.insert(table, {session.session_id, session})
        Shard.reconcile(shard_index(session.session_id), session.session_id, nil, session)
        :ok
    end
  end

  @doc """
  Mutate the stored record under the OWNING SHARD's serialization. Fun
  receives current state (nil if absent — a non-nil return CREATES the
  record); its non-nil return replaces the record.

  RESERVED PATH: correctness-critical mutations only — operations whose
  outcome must not interleave with a concurrent adoption of the same
  session (today: Resume adoption). The per-dispatch / per-heartbeat hot
  path MUST use `update_local/2`: a GenServer hop there would serialize
  every session's every event node-wide.
  """
  @spec update_with(String.t(), (Session.t() | nil -> Session.t() | nil)) ::
          {:ok, Session.t()} | {:error, term()}
  def update_with(session_id, fun) when is_function(fun, 1) do
    session_id
    |> shard_index()
    |> Shard.name()
    |> GenServer.call({:update_with, session_id, fun}, @update_timeout)
  end

  @doc """
  Append a dispatch to the resume buffer of every DISCONNECTED, bufferable
  session in `session_ids` (hardening plan 4.2), in ONE call per owning shard.

  The offline half of the fan-out: a held session has no socket, so the event has
  to be written into its record for the resume replay to carry it. Two things
  make this its own entry point rather than a `for` loop of `update_with/2` at the
  call site:

    * COST — the fan-out would otherwise pay one `GenServer.call` per held
      session, from inside the per-workspace fan-out process, which is exactly the
      serialization that process must not have (`Workspaces.Workspace` documents
      its handler as "ETS reads + sends"). Grouping by shard caps it at
      `shard_count/0` calls however many sessions are held.
    * BLAME — the caller is a DELIVERY path, not a transaction: a shard that is
      slow, restarting or gone must not take the publisher down with it (an
      uncaught `GenServer.call` exit kills the caller, and for the workspace
      fan-out that discards every event already queued behind it). A failure here
      is logged and swallowed, leaving that session's buffer short by one event —
      the best-effort contract the fan-out already has.

  The per-record decision ("is this disconnected? native? excluded?") stays in
  the shard, where the record is: `{:append_offline, ids, name, payload, except}`.
  Ids whose record is gone are reported back and their offline hold is released.

  NON-BLOCKING (review #21): the per-shard request is a CAST. It used to be a
  `GenServer.call` with a 5 s timeout made from INSIDE the workspace fan-out
  process, so one slow shard stalled that workspace's whole fan-out — every
  queued event behind it, for every member — for up to 5 s per shard. The
  shard applies casts in arrival order (a local send enqueues immediately, so
  an append issued before a Resume's adoption call is applied before it), and
  the fan-out never needed the reply.

  A shard that is NOT RUNNING drops the append — observably now: a
  `[:cytale, :gateway, :offline_append_dropped]` event (counted on /metrics)
  and a warning. Nothing needs marking for resync: the shard's records table
  died with it, so every session it held is gone and its Resume is refused
  (Invalid Session → fresh Identify + REST sync) rather than replaying a
  silently short buffer.
  """
  @spec append_offline([String.t()], String.t(), map(), term()) :: :ok
  def append_offline(session_ids, event_name, payload, except \\ :none)
      when is_list(session_ids) and is_binary(event_name) do
    session_ids
    |> Enum.uniq()
    |> Enum.group_by(&shard_index/1)
    |> Enum.each(fn {index, ids} ->
      case Process.whereis(Shard.name(index)) do
        nil ->
          :telemetry.execute([:cytale, :gateway, :offline_append_dropped], %{count: length(ids)}, %{
            shard: index,
            event: event_name
          })

          Logger.warning(
            "session store: shard #{index} is down; offline buffer append dropped " <>
              "(#{length(ids)} session(s), #{event_name}) — those sessions will full-sync"
          )

        pid ->
          GenServer.cast(pid, {:append_offline, ids, event_name, payload, except})
      end
    end)

    :ok
  end

  @doc """
  Barrier: returns once every shard has applied the offline appends queued
  before this call (tests; a caller that must read a record right after a
  fan-out).
  """
  @spec await_offline_appends() :: :ok
  def await_offline_appends do
    for index <- 0..(shard_count() - 1) do
      GenServer.call(Shard.name(index), :ping, @update_timeout)
    end

    :ok
  end

  @doc """
  Lock-free hot path: mutate the stored record by direct ETS
  read-modify-write IN THE CALLING PROCESS — no GenServer hop.

  CONTRACT: the caller must be the socket process holding the session's
  live claim — the single-writer invariant that makes this safe (two
  processes running `update_local/2` against one session_id is a caller bug
  and can lose updates). Unlike `update_with/2`, an absent record is an
  immediate `{:error, :unknown_session}` — the fun never runs against nil,
  because record CREATION is a serialized-path concern.

  Return contract mirrors `update_with/2`: `{:ok, updated}` (written),
  `{:ok, nil}` (the fun returned nil — record deleted), `{:error, reason}`
  (absent record, bad fun return, or fun raise — the stored record is never
  corrupted by a bad fun).
  """
  @spec update_local(String.t(), (Session.t() -> Session.t() | nil)) ::
          {:ok, Session.t()} | {:ok, nil} | {:error, term()}
  def update_local(session_id, fun) when is_function(fun, 1) do
    table = records_table(session_id)

    case :ets.lookup(table, session_id) do
      [] ->
        {:error, :unknown_session}

      [{_sid, %Session{} = current}] ->
        case apply_update(fun, current) do
          {:ok, nil} ->
            :ets.delete(table, session_id)
            Shard.reconcile(shard_index(session_id), session_id, current, nil)
            {:ok, nil}

          {:ok, %Session{} = updated} ->
            :ets.insert(table, {session_id, updated})
            # PERF-04: the hot path's reconcile — a live→live write (dispatch
            # buffering, heartbeat stamping) touches no sweep structure at all;
            # only a fun that drops or disconnects the record pays.
            Shard.reconcile(shard_index(session_id), session_id, current, updated)
            {:ok, updated}

          {:error, _reason} = error ->
            error
        end

      _ ->
        {:error, :corrupt_entry}
    end
  end

  # Normalize the update fun's return (shared by BOTH paths): a %Session{}
  # replaces the record, nil deletes it, {:ok, either} is unwrapped; anything
  # else is a caller bug — reported as an error WITHOUT taking the store down.
  @doc false
  @spec apply_update((Session.t() | nil -> term()), Session.t() | nil) ::
          {:ok, Session.t() | nil} | {:error, term()}
  def apply_update(fun, current) do
    case fun.(current) do
      %Session{} = updated -> {:ok, updated}
      nil -> {:ok, nil}
      {:ok, %Session{} = updated} -> {:ok, updated}
      {:ok, nil} -> {:ok, nil}
      other -> {:error, {:bad_update_return, other}}
    end
  rescue
    e -> {:error, {:update_fun_raised, e}}
  end

  @doc "Release everything known about a session immediately."
  @spec delete(String.t()) :: :ok
  def delete(session_id) do
    table = records_table(session_id)

    # PERF-04: `take/2` is an atomic remove-and-return, so the sweep-structure
    # reconcile sees exactly the record THIS delete removed — never a stale
    # pre-read (a concurrent socket terminate or sweep could transition the
    # same session first, and double-counting that transition would drift the
    # shard's connected count).
    taken =
      case :ets.take(table, session_id) do
        [{_sid, %Session{} = rec}] -> rec
        _ -> nil
      end

    true = :ets.delete(table, {:claim_marker, session_id})
    Shard.reconcile(shard_index(session_id), session_id, taken, nil)

    # The offline hold dies WITH the record (hardening plan 4.2): a session that
    # can no longer be resumed must not stay in the fan-out's address book.
    PushRegistry.release_held(session_id)
    :ok
  end

  # -- Live-connection claims --------------------------------------------------

  @doc """
  Become the single live connection for `session_id`.

      {:ok, :claimed}         → you own the wire for this session now
      {:error, :already_claimed} → a LIVE conn owns it

  The claim is a plain ETS `insert_new` on the session's OWN shard — the
  atomicity is ETS's, not a GenServer's, so it needs no serialization; and
  because the marker shares the record's shard it can never disagree with
  the record it guards.

  The marker records its HOLDER PID, and a marker whose holder is dead is
  taken over rather than blocking: a connection can die UNTRAPPABLY (#52's
  `max_heap_size` kill, a VM-level crash), and `terminate/1` never runs on
  that path, so nothing releases the claim. Those phantoms used to block the
  session until expiry. A marker with a `nil` holder — written before holders
  were recorded — is likewise treated as a phantom (it cannot be verified
  live, and the resume path's own token + identity checks still gate any
  adoption). The dead-holder check mirrors `claim_slot/2`.
  """
  @spec claim(String.t()) :: {:ok, :claimed} | {:error, :already_claimed}
  def claim(session_id) do
    table = records_table(session_id)

    if :ets.insert_new(table, {{:claim_marker, session_id}, self()}) do
      {:ok, :claimed}
    else
      case :ets.lookup(table, {:claim_marker, session_id}) do
        [{_key, holder}] when is_pid(holder) ->
          if Process.alive?(holder) do
            {:error, :already_claimed}
          else
            take_over_claim(table, session_id)
          end

        _phantom ->
          take_over_claim(table, session_id)
      end
    end
  end

  # Delete-then-retry: two resumers racing the same phantom resolve through
  # `insert_new`, so exactly one wins.
  defp take_over_claim(table, session_id) do
    true = :ets.delete(table, {:claim_marker, session_id})

    if :ets.insert_new(table, {{:claim_marker, session_id}, self()}),
      do: {:ok, :claimed},
      else: {:error, :already_claimed}
  end

  @doc "Release the claim (disconnect or forceful take-over)."
  @spec unclaim(String.t()) :: :ok
  def unclaim(session_id) do
    true = :ets.delete(records_table(session_id), {:claim_marker, session_id})
    :ok
  end

  @doc "Is a marker present at all (live or phantom)?"
  @spec claimed?(String.t()) :: boolean()
  def claimed?(session_id) do
    :ets.member(records_table(session_id), {:claim_marker, session_id})
  end

  @doc """
  Who holds `session_id`'s claim, as far as the marker can say:

      :alive      → a recorded holder process is still running
      :dead       → a recorded holder process is GONE (an untrappable death:
                    #52's max_heap_size kill, a VM-level crash — terminate/1
                    never ran, so nothing released the claim)
      :unrecorded → a marker exists but carries no holder (written before
                    holders were recorded: presence is known, liveness is not)
      :none       → no marker at all

  The ONE holder lookup: `claim_held_by_live?/1` and the shard sweeper's
  orphan recovery both read it, so their notions of "held" cannot drift.
  """
  @spec claim_holder_state(String.t()) :: :alive | :dead | :unrecorded | :none
  def claim_holder_state(session_id) do
    case :ets.lookup(records_table(session_id), {:claim_marker, session_id}) do
      [{_key, holder}] when is_pid(holder) ->
        if Process.alive?(holder), do: :alive, else: :dead

      [{_key, _no_holder}] ->
        :unrecorded

      [] ->
        :none
    end
  end

  @doc """
  Is `session_id` held by a LIVE process?

  Distinct from `claimed?/1`, which reports marker PRESENCE: an untrappable
  death (#52) leaves a marker behind with a dead holder, and treating that as
  "live" would both block every adoption of the session and make the record
  un-reapable. `:unrecorded` reads as not-live — it cannot be verified, and
  adoption is still gated by the resume token and the authenticated identity.
  """
  @spec claim_held_by_live?(String.t()) :: boolean()
  def claim_held_by_live?(session_id),
    do: claim_holder_state(session_id) == :alive

  @doc false
  # The pid recorded as holding `session_id`'s claim, or nil. For tests that
  # must act on THE session's socket: every socket of one user shares the
  # user's PushRegistry key, so "the first subscriber" can be another test's
  # socket still closing.
  @spec claim_holder(String.t()) :: pid() | nil
  def claim_holder(session_id) do
    case :ets.lookup(records_table(session_id), {:claim_marker, session_id}) do
      [{_key, holder}] when is_pid(holder) -> holder
      _ -> nil
    end
  end

  # -- Principal→session index + teardown (KTD6) ---------------------------------

  @doc """
  Index the CALLING socket process as a live session of `principal_id`
  (invoked by the socket at Identify/Resume success). Re-registration for
  the same session (a Resume adopting it on a new pid) is additive — the
  bag holds one entry per {principal, pid, session}.
  """
  @spec track_principal(integer(), String.t()) :: :ok
  def track_principal(principal_id, session_id)
      when is_integer(principal_id) and is_binary(session_id) do
    true = :ets.insert(Index.principal_index_table(), {principal_id, self(), session_id})
    :ok
  end

  @doc """
  Drop every index entry held by `pid` (socket terminate path): the
  principal→session bag rows AND any session-cap slot the pid claimed.
  """
  @spec untrack_principal(pid()) :: :ok
  def untrack_principal(pid) when is_pid(pid) do
    true = :ets.match_delete(Index.principal_index_table(), {:_, pid, :_})
    :ok = release_principal_slots(pid)
  end

  @doc """
  Live `{pid, session_id}` pairs for `principal_id`. Entries from crashed
  sockets (which never ran their terminate) are filtered by liveness at
  read time — the same discipline as `PushRegistry.subscribers/1`.
  """
  @spec principal_sessions(integer()) :: [{pid(), String.t()}]
  def principal_sessions(principal_id) when is_integer(principal_id) do
    Index.principal_index_table()
    |> :ets.lookup(principal_id)
    |> Enum.reject(fn {_principal, pid, _session} -> not Process.alive?(pid) end)
    |> Enum.map(fn {_principal, pid, session_id} -> {pid, session_id} end)
  end

  @doc """
  Revocation teardown (R2 wire-instant): close every live session of
  `principal_id` with `close_code` (4004 — the credential is dead and
  non-reconnectable) and purge the stored records, so Resume cannot
  resurrect them. The close message is sent BEFORE the purge: any heartbeat
  already queued ahead of it updates a record that still exists, and
  anything behind it is never processed.
  """
  @spec close_principal_sessions(integer(), pos_integer()) :: :ok
  def close_principal_sessions(principal_id, close_code)
      when is_integer(principal_id) and is_integer(close_code) do
    for {pid, session_id} <- principal_sessions(principal_id) do
      send(pid, {:cytale_principal_close, close_code})
      delete(session_id)
    end

    :ok
  end

  @doc """
  Every stored session id — live OR disconnected-but-resumable — bound to
  `user_id`. A scan of the record shards: the principal index above only
  knows LIVE sockets, and the resumable record a dropped socket leaves behind
  is exactly what a revocation must not let survive. Used by the rare
  security teardowns only (credential revocation, membership loss), never on
  a hot path.
  """
  @spec user_session_ids(integer()) :: [String.t()]
  def user_session_ids(user_id) when is_integer(user_id) do
    uid = Integer.to_string(user_id)

    Enum.flat_map(0..(@shard_count - 1), fn index ->
      :ets.select(Shard.records_table(index), [{{:"$1", %{user: %{id: uid}}}, [], [:"$1"]}])
    end)
  rescue
    ArgumentError -> []
  end

  @doc """
  Make room for one more NATIVE session of `user_id` under `cap` live-plus-
  held sessions (Tier 3 B, 5d). A user at the cap has their OLDEST held
  (disconnected, or abandoned by a dead holder) sessions evicted — deleted,
  so they can no longer be resumed and stop buffering — until one slot is
  free; `{:error, :full}` when every stored session is genuinely live.

  Without the bound, every Identify that never resumed left a record (and its
  offline buffer and held routes) for the whole resume window, so one account
  could park an unbounded number of buffers on the node. Cost: the same shard
  scan as `user_session_ids/1`, once per native Identify.
  """
  @spec make_room_for_user_session(integer(), pos_integer()) :: :ok | {:error, :full}
  def make_room_for_user_session(user_id, cap) when is_integer(user_id) and is_integer(cap) and cap > 0 do
    records = Enum.flat_map(user_session_ids(user_id), &List.wrap(get(&1)))
    excess = length(records) - cap + 1

    if excess <= 0 do
      :ok
    else
      held =
        records
        |> Enum.reject(&(Session.live?(&1) and claim_held_by_live?(&1.session_id)))
        |> Enum.sort_by(&(&1.last_disconnect_at_ms || &1.created_at_ms || 0))

      held
      |> Enum.take(excess)
      |> Enum.each(&delete(&1.session_id))

      if length(held) >= excess, do: :ok, else: {:error, :full}
    end
  end

  @doc """
  Credential teardown for a USER (password reset, refresh-replay detection,
  sign-out-everywhere): close every live socket 4004 (the credential is dead)
  and purge every stored record — the resumable ones of already-dropped
  sockets included, so a Resume cannot bring any of them back.
  """
  @spec close_user_sessions(integer(), pos_integer()) :: :ok
  def close_user_sessions(user_id, close_code) when is_integer(user_id) and is_integer(close_code) do
    :ok = close_principal_sessions(user_id, close_code)
    Enum.each(user_session_ids(user_id), &delete/1)
    :ok
  end

  @doc """
  Membership loss (a kick): the user's DISCONNECTED-but-resumable sessions
  stop being addressed by `route_keys` (the workspace's keys), so the offline
  buffer no longer collects that workspace's events for them. Live sockets
  re-sync their own routes on the `:cytale_refresh_routes` poke; this is the
  held (offline) half.
  """
  @spec release_user_routes(integer(), [term()]) :: :ok
  def release_user_routes(user_id, route_keys) when is_integer(user_id) and is_list(route_keys) do
    drop = MapSet.new(route_keys)

    for session_id <- user_session_ids(user_id),
        {:ok, held} <- [PushRegistry.held_routes_of(session_id)] do
      PushRegistry.hold_session(session_id, Enum.reject(held, &MapSet.member?(drop, &1)))
      if Enum.all?(held, &MapSet.member?(drop, &1)), do: PushRegistry.release_held(session_id)
    end

    :ok
  end

  @doc """
  Restriction-profile teardown (R3): send the reconnectable Reconnect signal
  to every live session of `principal_id` and PURGE the stored records. The
  socket pushes the Reconnect frame and closes; the client library reconnects
  and re-Identifies with the STILL-VALID credential, picking up the narrowed
  profile. The records are purged alongside (unlike a plain link drop) so a
  Resume cannot resurrect the session under the stale, pre-narrowing
  identity/restrictions frozen in the stored record — the fresh Identify the
  narrowing depends on is forced. 4004 is reserved for dead credentials only
  (KTD6).
  """
  @spec reconnect_principal_sessions(integer()) :: :ok
  def reconnect_principal_sessions(principal_id) when is_integer(principal_id) do
    for {pid, session_id} <- principal_sessions(principal_id) do
      send(pid, :cytale_principal_reconnect)
      delete(session_id)
    end

    :ok
  end

  # -- Session-cap slots (KTD15, TOCTOU-free) -----------------------------------

  @doc """
  Atomically claim one of `principal_id`'s `cap` concurrent-session slots for
  the CALLING process: the first free `{principal_id, slot}` tuple wins an
  `insert_new`, so N concurrent Identifies can never overshoot the cap (the
  former read-count-then-track raced). A slot held by a dead process (a
  crashed socket never ran its terminate) is reclaimed on the way through.
  Release is `release_principal_slots/1` (the socket terminate path).
  """
  @spec claim_principal_slot(integer(), pos_integer()) :: {:ok, pos_integer()} | {:error, :full}
  def claim_principal_slot(principal_id, cap) when is_integer(principal_id) and is_integer(cap) do
    case Enum.find_value(1..cap, &claim_slot(principal_id, &1)) do
      slot when is_integer(slot) -> {:ok, slot}
      nil -> {:error, :full}
    end
  end

  # One slot attempt: insert_new when absent; a dead holder's slot is deleted
  # and retried; a live holder's slot moves the scan on.
  defp claim_slot(principal_id, slot) do
    table = Index.principal_slots_table()
    key = {principal_id, slot}

    if :ets.insert_new(table, {key, self()}) do
      true = :ets.insert(table, {self(), key})
      slot
    else
      case :ets.lookup(table, key) do
        [{^key, holder}] when is_pid(holder) ->
          if Process.alive?(holder) do
            nil
          else
            true = :ets.delete(table, key)
            if :ets.insert_new(table, {key, self()}), do: slot, else: nil
          end

        _ ->
          nil
      end
    end
  end

  @doc "Release every session-cap slot held by `pid` (socket terminate path)."
  @spec release_principal_slots(pid()) :: :ok
  def release_principal_slots(pid) when is_pid(pid) do
    for {^pid, key} <- :ets.lookup(Index.principal_slots_table(), pid) do
      true = :ets.delete(Index.principal_slots_table(), key)
      true = :ets.delete(Index.principal_slots_table(), {pid, key})
    end

    :ok
  end

  # -- Internals -----------------------------------------------------------------

  # Session records + claim markers route by session_id: every row of one
  # session lives on one shard, so the per-session invariants (single live
  # claim, single-writer record) hold exactly as on the pre-shard single
  # table.
  defp shard_index(session_id), do: :erlang.phash2(session_id, @shard_count)

  defp records_table(session_id), do: Shard.records_table(shard_index(session_id))
end
