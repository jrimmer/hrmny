defmodule Cytale.Gateway.SessionStore.Shard do
  @moduledoc """
  One RECORD shard of `Cytale.Gateway.SessionStore`: the long-lived owner of
  that shard's ETS records table (`%Session{}` rows keyed `session_id` PLUS
  the `{:claim_marker, session_id}` uniqueness rows — both routed here by
  `:erlang.phash2(session_id)`) and the per-shard expiry sweeper.

  GenServer-serialized work is deliberately MINIMAL:

    * `handle_call({:update_with, ...})` — the correctness-reserved
      read-modify-write (today: Resume adoption). Operations whose outcome
      must not interleave with a concurrent adoption of the same session
      serialize HERE, on the session's own shard.
    * `handle_info(:sweep)` — the once-a-second expiry pass over this
      shard's records (each shard sweeps its own; the union sweeps all).

  EVERYTHING else against these tables is direct ETS from the calling
  process — the hot path (dispatch buffering, heartbeat stamping via
  `SessionStore.update_local/2`) runs in the claim-holding socket, which is
  the record's single writer by invariant, and the atomic primitives
  (claim `insert_new`, insert/delete) need no serialization. A crashed
  shard loses only its own 1/8 of sessions; `:one_for_one` restarts it with
  a fresh table without touching the other shards.

  ## Sweep structures (PERF-04)

  The once-a-second sweep must cost proportional to the sessions expiring
  NOW, not to the table size, so expiry walks a per-shard SWEEP INDEX — an
  `:ordered_set` keyed by `{anchor_ms, session_id}` (`SweepIndex` table, rows
  are the 1-tuple `{{anchor_ms, session_id}}`, ordered by anchor) holding exactly the DISCONNECTED records with an expiry
  anchor (`Session.expired?/3`'s clock: last disconnect, else creation;
  connected records are never swept and get no entry). The walk pops due
  entries (`anchor < now - window`), re-verifies each against its record —
  the entry is a HINT, the record is the truth — and reaps with the same
  `delete_local/2` side effects the old full-table fold had.

  The index is maintained by `reconcile/4`, which runs beside EVERY
  records-table write: the facade's write helpers (`SessionStore.put/
  update/update_local/delete`, in the writer's own process) and this
  shard's serialized paths (`update_with`, `append_offline`, orphan
  recovery). It is sound because of the same single-writer invariant that
  licenses the lock-free hot path: for any one record, all writes execute
  in ONE process at a time (the live-claim-holding socket, or this shard
  once no live claim exists), so the paired index/counter writes interleave
  with nothing. The walk's re-verification makes a stranded entry — a
  writer that died between its record write and its index write —
  self-healing instead of harmful: the next sweep pops it, reads the
  record, and leaves both alone.

  Orphan recovery (#52) keeps its foldl but SKIPS it entirely while this
  shard's connected-count row (`@connected_count_key` in the records table,
  maintained by the same `reconcile/4` transitions) reads zero — a shard
  with no connected records has no orphans to look for. An overcount only
  runs the scan needlessly (the pre-PERF-04 behavior); the residual risk is
  an undercount to zero from a writer dying between its two ETS ops — the
  same crash-window class the store's other paired writes (record vs claim
  marker vs offline hold) already carry — which would defer that orphan's
  recovery until this shard's next phase transition.
  """

  use GenServer

  alias Cytale.Gateway.PushRegistry
  alias Cytale.Gateway.Session
  alias Cytale.Gateway.SessionStore

  # Sweep cadence: fast enough that tests can observe expiry promptly.
  @sweep_interval_ms 1_000

  # The records-table row holding this shard's count of `:connected` records
  # (PERF-04): transitions are reconciled beside every record write, and the
  # sweep skips orphan recovery entirely while it reads zero. Keyed in the
  # records table itself — an atom key can never collide with a binary
  # session_id or a `{:claim_marker, _}` row.
  @connected_count_key :connected_count

  @spec start_link(non_neg_integer()) :: GenServer.on_start()
  def start_link(index) when is_integer(index) and index >= 0 do
    GenServer.start_link(__MODULE__, index, name: name(index))
  end

  @doc "The shard owner's registered name."
  def name(index) when is_integer(index), do: :"#{__MODULE__}#{index}"

  @doc "The shard's session-records table (session rows + claim markers)."
  def records_table(index) when is_integer(index), do: :"#{__MODULE__}#{index}.Records"

  @doc "The shard's sweep-index table (`{{anchor_ms, session_id}}` rows, keyed and ordered by anchor)."
  def index_table(index) when is_integer(index), do: :"#{__MODULE__}#{index}.SweepIndex"

  @impl true
  def init(index) do
    :ets.new(records_table(index), [:set, :named_table, :public, write_concurrency: true])

    # Seeded before the shard can serve anything (the one writer that could
    # race this is a helper's update_counter, whose default covers an absent
    # row anyway).
    true = :ets.insert(records_table(index), {@connected_count_key, 0})

    # PERF-04: `{anchor_ms, session_id}` rows for every DISCONNECTED record
    # with an expiry anchor, ordered by anchor — the sweep pops only due
    # entries instead of folding the whole records table every second.
    :ets.new(index_table(index), [:ordered_set, :named_table, :public, write_concurrency: true])

    Process.send_after(self(), :sweep, @sweep_interval_ms)
    {:ok, index}
  end

  # Serialized read-modify-write — correctness-critical operations only
  # (see `SessionStore.update_with/2`). Identical contract to the pre-shard
  # store's handle_call, down to the create-on-nil branch and the error
  # normalization (a bad fun never takes the store down).
  @impl true
  def handle_call({:update_with, session_id, fun}, _from, index) do
    table = records_table(index)

    case :ets.lookup(table, session_id) do
      [] ->
        case SessionStore.apply_update(fun, nil) do
          {:ok, nil} ->
            {:reply, {:error, :unknown_session}, index}

          {:ok, %Session{} = fresh} ->
            :ets.insert(table, {session_id, fresh})
            reconcile(index, session_id, nil, fresh)
            {:reply, {:ok, fresh}, index}

          {:error, reason} ->
            {:reply, {:error, reason}, index}
        end

      [{_, %Session{} = current}] ->
        case SessionStore.apply_update(fun, current) do
          {:ok, nil} ->
            :ets.delete(table, session_id)
            reconcile(index, session_id, current, nil)
            {:reply, {:ok, nil}, index}

          {:ok, %Session{} = updated} ->
            :ets.insert(table, {session_id, updated})
            reconcile(index, session_id, current, updated)
            {:reply, {:ok, updated}, index}

          {:error, reason} ->
            {:reply, {:error, reason}, index}
        end

      _ ->
        {:reply, {:error, :corrupt_entry}, index}
    end
  end

  def handle_call(:ping, _from, index), do: {:reply, :ok, index}

  # The CAST form is what `SessionStore.append_offline/4` sends (review #21 —
  # the fan-out must never block on a shard); the call form is kept for any
  # caller that needs the append applied before it proceeds.
  def handle_call({:append_offline, _ids, _name, _payload, _except} = request, _from, index) do
    {:noreply, index} = handle_cast(request, index)
    {:reply, :ok, index}
  end

  @impl true
  def handle_cast({:append_offline, session_ids, event_name, payload, except}, index) do
    # The offline half of the fan-out (hardening plan 4.2): one shard call for
    # every held session this shard owns. The eligibility decision lives here
    # because the record does — a live record must NEVER be written from this
    # path (the socket holding it is the record's single writer), a compat record
    # must not be fed untranslated native payloads, and `{:user, id}` exclusions
    # (the typing rule, #80) are evaluated against the record's own user.
    table = records_table(index)

    Enum.each(session_ids, fn session_id ->
      case :ets.lookup(table, session_id) do
        [{_sid, %Session{phase: :disconnected, mode: :native} = rec}] ->
          unless excluded?(rec.user[:id], except) do
            {updated, _env} = Session.buffer_event(rec, event_name, payload)
            :ets.insert(table, {session_id, updated})

            # PERF-04: buffering never moves the record's expiry anchor, so
            # this reconcile is a no-op on the index — it exists so the
            # invariant ("every record write reconciles") has no exceptions.
            reconcile(index, session_id, rec, updated)
          end

        _absent_or_not_bufferable ->
          # Nothing to write: the record is gone (expired/swept/deleted), already
          # live again, or compat. A vanished record means the hold is stale —
          # release it, exactly as `subscribers/1` reclaims a dead pid.
          if :ets.lookup(table, session_id) == [], do: PushRegistry.release_held(session_id)
      end
    end)

    {:noreply, index}
  end

  defp excluded?(_user_id, :none), do: false
  defp excluded?(_user_id, pid) when is_pid(pid), do: false

  defp excluded?(user_id, {:user, except_user}),
    do: not is_nil(user_id) and not is_nil(except_user) and to_string(user_id) == to_string(except_user)

  defp excluded?(_user_id, _other), do: false

  @impl true
  def handle_info(:sweep, index) do
    now_ms = System.system_time(:millisecond)
    window = Cytale.Config.resume_window_floor_ms()

    # #52: recover untrappable deaths BEFORE deciding expiry. terminate/1 never
    # runs on that path, so such a session sits `:connected` with a dead claim
    # holder and no disconnect stamp — invisible to the reap below ("live
    # sessions are never swept") and holding its replay buffer forever, one per
    # death. Stamping the last sign of life puts it on the ordinary clock.
    recover_orphans(index, now_ms)

    # PERF-04: pop only DUE entries off the ordered sweep index instead of
    # folding every record each second.
    sweep_expired(index, now_ms, window)

    Process.send_after(self(), :sweep, @sweep_interval_ms)
    {:noreply, index}
  end

  # -- Internals -----------------------------------------------------------------

  # Recover exactly the shape an UNTRAPPABLE death leaves — a `:connected`
  # record whose claim holder is a recorded pid that is now dead — and nothing
  # else:
  #
  #   * `:unrecorded` markers (written before holders were recorded) are left
  #     alone, so a session whose socket is genuinely live on an older build is
  #     never disturbed;
  #   * the disconnect is stamped at the LAST SIGN OF LIFE (the last
  #     heartbeat), never at "now" — a session abandoned long ago must expire
  #     on its real clock instead of being kept alive by each sweep.
  #
  # Writes go straight to this shard's own table (the shard is its owner), the
  # same as the `update_with` path does.
  #
  # PERF-04: the foldl is O(table), so it runs ONLY when the shard holds
  # connected records (the only shape recovery examines). The count is the
  # same one `reconcile/4` maintains beside every record write.
  defp recover_orphans(index, now_ms) do
    table = records_table(index)

    if connected_count(table) > 0 do
      :ets.foldl(
        fn
          {session_id, %Session{phase: :connected} = s}, acc when is_binary(session_id) ->
            if SessionStore.claim_holder_state(session_id) == :dead do
              at = s.last_heartbeat_at_ms || s.created_at_ms || now_ms
              marked = Session.mark_disconnected(s, at)
              true = :ets.insert(table, {session_id, marked})
              hold_recovered(table, session_id)
              reconcile(index, session_id, s, marked)
            end

            acc

          _, acc ->
            acc
        end,
        0,
        table
      )
    end

    :ok
  end

  # A recovered orphan is disconnected-but-resumable, so it must be ADDRESSABLE
  # too (hardening plan 4.2), exactly like a session whose terminate/2 ran: the
  # socket that held its routes never got to write the hold, and without this its
  # resume window would keep the original hole (events published during it
  # reaching nobody while `replay_complete?/2` still accepts the resume).
  #
  # The routes come from the registry by the DEAD holder's pid. `subscribers/1`
  # reclaims a dead pid's route ROWS on the read path but deliberately leaves its
  # reverse-index entry (see `PushRegistry.drop_routes/1`), which is what makes
  # this read work even after a fan-out has already noticed the death. The entry
  # is retired HERE, once the hold owns the routes.
  #
  # The native/compat rule is NOT duplicated here: the fan-out's write path
  # (`FanOut.buffer_offline/3`) is the one place that decides what may be
  # buffered, and it refuses a compat record, so holding one is merely a
  # short-lived index entry the sweep retires.
  defp hold_recovered(table, session_id) do
    case :ets.lookup(table, {:claim_marker, session_id}) do
      [{_key, pid}] when is_pid(pid) ->
        :ok =
          PushRegistry.hold_session(
            session_id,
            PushRegistry.session_keys(pid)
          )

        PushRegistry.drop_session(pid)

      _ ->
        :ok
    end
  end

  # PERF-04: the expiry pass. The sweep index holds exactly the sweepable
  # records keyed `{anchor_ms, session_id}` in anchor order, so the walk pops
  # entries from the FRONT while they are due (`anchor < now - window` — the
  # exact `Session.expired?/3` boundary) and stops at the first not-due entry:
  # cost is the sessions expiring NOW, never the table size. Tail-recursive —
  # a mass disconnect can put thousands of due entries in one pass.
  defp sweep_expired(index, now_ms, window_ms) do
    walk_due(index_table(index), index, now_ms - window_ms, now_ms, window_ms)
  end

  defp walk_due(sweep_index, index, horizon, now_ms, window_ms) do
    case :ets.first(sweep_index) do
      {anchor, session_id} when anchor < horizon ->
        # Pop the entry regardless of what the record says next: if the record
        # no longer matches, the entry was stranded (self-healing drop); if it
        # does, the entry is consumed by the reap.
        true = :ets.delete(sweep_index, {anchor, session_id})
        reap_due(index, session_id, now_ms, window_ms)
        walk_due(sweep_index, index, horizon, now_ms, window_ms)

      _ ->
        :ok
    end
  end

  # A popped index row is a HINT; the record is the truth. A re-connected
  # session (its reconcile removes its own entry, but a crashed writer could
  # strand one) and a record whose clock was moved must never be reaped — so
  # the exact `expired?/3` judgment the table-fold sweep made is re-run before
  # `delete_local/2` fires. A vanished record releases its offline hold, the
  # same stale-hold rule `append_offline`'s vanished-record branch applies.
  defp reap_due(index, session_id, now_ms, window_ms) do
    case :ets.lookup(records_table(index), session_id) do
      [{^session_id, %Session{} = rec}] ->
        if not Session.live?(rec) and Session.expired?(rec, now_ms, window_ms),
          do: delete_local(index, session_id)

      [] ->
        PushRegistry.release_held(session_id)
    end

    :ok
  end

  # The record dies WITH its claim marker: a swept session must not be
  # resumable (and a stale marker alone would block a fresh Identify). The
  # offline hold (hardening plan 4.2) dies with it too — an expired session must
  # stop being a fan-out target, or `buffer_offline/3` would keep writing
  # envelopes nobody can ever replay. (Its sweep-index entry was already popped
  # by `walk_due/5` — that is the only caller.)
  defp delete_local(index, session_id) do
    table = records_table(index)
    true = :ets.delete(table, session_id)
    true = :ets.delete(table, {:claim_marker, session_id})
    PushRegistry.release_held(session_id)
    :ok
  end

  # -- Sweep-structure maintenance (PERF-04) ---------------------------------------

  @doc """
  Reconcile this shard's sweep structures with a records-table write of
  `session_id` (`old` → `new`, either side nil): the sweep index gains
  `{anchor, session_id}` for a DISCONNECTED record with an expiry anchor and
  loses it when the record is live or gone; the connected-count row tracks
  live↔dead phase transitions.

  Runs beside EVERY record write — `SessionStore.put/update/update_local/
  delete` in the writer's own process, and this shard's `update_with`,
  `append_offline` and orphan-recovery paths — which is what makes the
  structures sound: for any one record, all writes execute in ONE process at
  a time (the single-writer invariant, see the moduledoc), so the paired
  writes can never interleave. Cost is deliberately zero on the hot path:
  a live→live write (dispatch buffer, heartbeat) touches no ETS here.
  """
  @spec reconcile(non_neg_integer(), String.t(), Session.t() | nil, Session.t() | nil) :: :ok
  def reconcile(index, session_id, old, new) when is_binary(session_id) do
    sweep_index = index_table(index)

    case {sweep_entry(old), sweep_entry(new)} do
      {same, same} ->
        :ok

      # The WHOLE `{anchor, session_id}` pair is the KEY, so the row is the
      # 1-tuple `{entry}`. Inserting `entry` itself would key the row on
      # `anchor` alone: `:ets.first/1` then yields a bare integer that
      # `walk_due/5`'s pattern never matches (nothing is ever reaped), the
      # delete-by-pair below never finds it, and two sessions disconnecting
      # in the same millisecond overwrite each other's entry.
      {old_entry, new_entry} ->
        if old_entry, do: :ets.delete(sweep_index, old_entry)
        if new_entry, do: true = :ets.insert(sweep_index, {new_entry})
        :ok
    end

    bump_connected(records_table(index), live?(old), live?(new))
  end

  # The index entry a record deserves: `{anchor, session_id}` when it is
  # disconnected AND carries an expiry anchor (the `Session.expired?/3` clock:
  # last disconnect, else creation) — `nil` (no entry) when the record is live
  # (never swept), gone, or anchor-less (never expires). Anchors that drift
  # from `Session`'s semantics are harmless: the sweep re-judges with
  # `Session.expired?/3` before reaping.
  defp sweep_entry(%Session{} = s) do
    if Session.live?(s) do
      nil
    else
      case anchor_ms(s) do
        nil -> nil
        anchor -> {anchor, s.session_id}
      end
    end
  end

  defp sweep_entry(nil), do: nil

  # Mirrors `Session`'s private `anchor_ms/1` (last disconnect, else creation).
  # Duplicated here, not reopened there, so the sweep's keying rides the same
  # two fields `expired?/3` reads.
  defp anchor_ms(%Session{last_disconnect_at_ms: d}) when is_integer(d), do: d
  defp anchor_ms(%Session{created_at_ms: c}) when is_integer(c), do: c
  defp anchor_ms(_), do: nil

  defp live?(%Session{} = s), do: Session.live?(s)
  defp live?(nil), do: false

  # +1 on a connect, -1 on a disconnect/delete; a live→live (or dead→dead)
  # write pays nothing. The row is seeded at init; the default covers the
  # one race where a helper writes before the seed lands. An ETS atomic, so
  # the shard's own writes and socket-process helpers can never lose an
  # increment to each other.
  defp bump_connected(_table, same, same), do: :ok

  defp bump_connected(table, false, true),
    do: :ets.update_counter(table, @connected_count_key, 1, {@connected_count_key, 0})

  defp bump_connected(table, true, false),
    do: :ets.update_counter(table, @connected_count_key, -1, {@connected_count_key, 0})

  # The count drives the orphan-scan skip; an absent/odd row reads as zero
  # (the scan is the safe direction to skip INTO being wrong about — see the
  # moduledoc's residual-risk note).
  defp connected_count(table) do
    case :ets.lookup(table, @connected_count_key) do
      [{@connected_count_key, n}] when is_integer(n) and n > 0 -> n
      _ -> 0
    end
  end
end
