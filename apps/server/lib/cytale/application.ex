defmodule Cytale.Application do
  @moduledoc """
  Root of the Cytale supervision tree.

  Current shape (U4 skeleton + U10 gateway machinery):

      Cytale.Supervisor
      ├── Cytale.WorkspaceRegistry       (Registry, unique names per workspace)
      ├── Cytale.Workspaces.Quarantine   (crash-looping workspace registry, 4.6)
      ├── Cytale.WorkspaceSupervisor     (DynamicSupervisor of per-workspace subtrees, 4.6)
      ├── Cytale.Gateway.SessionStore    (supervisor: 8 record shards + principal tables, per-shard expiry sweepers)
      ├── Cytale.Gateway.PushRegistry    (fan-out target bookkeeping)
      ├── Cytale.Gateway.AdmissionLimiter (per-IP reconnect-storm damping)
      ├── Cytale.Permissions.RightsEpoch (per-workspace rights epoch owner, U3)
      ├── CytaleWeb.Compat.RateTables    (rate-limit ETS table owner, KTD9)
      ├── Task.Supervisor                (account-deletion sweep runner, U14)
      ├── Cytale.Calls.RoomRegistry      (one-live-per-channel room registry, voice U3)
      ├── Cytale.Calls.RoomSupervisor     (DynamicSupervisor for live-call rooms, voice U3)
      ├── Task.Supervisor                (calls boot-sweep runner, voice U3)
      ├── Cytale.Repo                    (Xandra cluster pool, async connect)
      └── CytaleWeb.Endpoint             (Bandit-backed Phoenix endpoint)

  Later units extend this tree: the Xandra cluster (U6), auth (U8), REST (U9),
  workspace processes (U11), search writers (U13), and metrics (U11).
  """

  use Application

  @impl true
  def start(_type, _args) do
    # #121: the config/secrets files load FIRST — before any child can read a
    # migrated key (the session bridge's enabled? probe reads its credential
    # during child construction below). Never fails the boot: corrupt file →
    # last-good → regenerate from env, each loudly logged.
    :ok = Cytale.ServerConfig.boot!()

    scylla_pool? = Application.get_env(:cytale, :start_scylla_pool, true)

    # #120 RESTORE MODE: a marker beside the config file means an operator
    # staged a backup restore and restarted us. That boot runs the supervised
    # restore BEFORE the endpoint exists to serve anything (and before the
    # backup scheduler could tick a backup OVER the half-restored data): the
    # tree below starts without the endpoint/scheduler, and the boot task
    # adds them back only when the restore fully applied. Validation failure
    # = the node stays up but refuses to serve, loudly, with the staged
    # archive intact.
    restore_mode? = Cytale.Backups.Restore.marker_present?()

    backups_scheduler? =
      not restore_mode? and Application.get_env(:cytale, :start_backups_scheduler, scylla_pool?)

    # #138: the client-error alerter — same boot posture as the backup
    # scheduler (pool present, never in restore mode: alerting over
    # half-restored data would be noise).
    error_alerts_scheduler? =
      not restore_mode? and Application.get_env(:cytale, :start_error_alerts_scheduler, scylla_pool?)

    # Hardening 4.5: does this boot gate the endpoint behind the schema
    # lifecycle? Computed here because the children list below needs it.
    schema_on_boot? = Application.get_env(:cytale, :apply_scylla_schema_on_boot, false)
    defer_endpoint? = not restore_mode? and schema_on_boot?

    # Hardening plan 1.8: the prepared-statement cache owner. Started
    # unconditionally and BEFORE the pool, because it holds only a table —
    # `Cytale.Repo.query/3` degrades to a fresh prepare when it is absent,
    # so ordering is a preference, not a dependency.
    # #120: the scheduler never boots in restore mode — a backup that ran
    # mid-restore would archive the half-wiped tables.
    # #138: the client-error alerter rides the same conditional-start
    # seam (its pass needs the pool; the hermetic test boot runs none).
    # Restore mode boots WITHOUT the endpoint; the boot task starts it
    # in the tree only after the restore fully applied.
    # Deferred in restore mode (nothing serves during a restore) AND when
    # the schema lifecycle gates the boot (hardening 4.5) — the endpoint is
    # added by `Supervisor.start_child/2` below, only after apply+verify.
    # Review #24: the Snowflake high-water lease — seeds the id
    # generator's floor from the previous run's mark (monotonic ids across
    # a clock step-back) and keeps the mark refreshed. Needs the pool.
    # #54 U4: the due-time sweeper (message marks). After the pool, never in
    # restore mode; its own `:marks_sweeper` switch stops fires without a
    # redeploy, and its first tick IS the boot catch-up.
    children =
      [
        {Registry, keys: :unique, name: Cytale.WorkspaceRegistry},
        # CONTAINMENT, not just tolerance (hardening plan 4.6). The registry of
        # crash-looping workspaces, started BEFORE the workspace supervisor so
        # every subtree can be watched from the moment it starts. On shutdown it
        # is torn down AFTER `Cytale.WorkspaceSupervisor` (reverse start order),
        # and `Application.prep_stop/1` marks the planned stop first, so a
        # graceful stop is never mistaken for a quarantine.
        Cytale.Workspaces.Quarantine,
        # Hardening plan 4.6: ONE budget per workspace. Each child of this
        # DynamicSupervisor is a `Cytale.Workspaces.SubtreeSupervisor` holding
        # exactly one workspace process, with its own generous restart budget
        # (see that module). A poison workspace spends only its own budget; the
        # outer budget here is a backstop for the subtree supervisors
        # themselves. When a subtree exhausts its budget it terminates
        # `:shutdown`, which is normal for a `:transient` child — the spec is
        # dropped, the workspace is recorded quarantined by
        # `Cytale.Workspaces.Quarantine`, and every other workspace, session and
        # the endpoint keep serving. The crash loop is CONTAINED and ended, not
        # merely tolerated.
        {DynamicSupervisor,
         name: Cytale.WorkspaceSupervisor, strategy: :one_for_one, max_restarts: 1_000, max_seconds: 5},
        {Registry, keys: :unique, name: Cytale.Search.IndexWriterRegistry},
        {DynamicSupervisor, name: Cytale.Search.IndexWriterSupervisor},
        # #89: search-index maintenance — the single-flight rebuild runner
        # (ONE rebuild at a time in total: this box also runs ScyllaDB under a
        # documented memory confinement) and the supervisor its long walk runs
        # under, so a crashed rebuild is logged and terminal, never silent.
        Cytale.Search.RebuildRunner,
        {Task.Supervisor, name: Cytale.Search.RebuildTaskSupervisor},
        # #116: workspace data exports — the export twin of the rebuild
        # runner above: one archive build at a time in total (same box, same
        # ScyllaDB memory confinement) and the supervisor its streaming walk
        # runs under, so a crashed export is terminal + logged, never a job
        # pinned :running.
        # #120: server backups — the backup job's supervisor (the scheduled
        # run and the boot restore-mode task both walk whole tables, so a
        # crash must be logged + terminal, never silent). The scheduler
        # GenServer joins conditionally at the tail of the list.
        {Task.Supervisor, name: Cytale.Backups.TaskSupervisor},
        Cytale.Gateway.SessionStore,
        Cytale.Gateway.PresenceStatus,
        Cytale.Telemetry.Stats,
        # The media proxy's disk cache: running byte total, LRU eviction, the
        # hourly expiry sweep, and the brief failed-fetch memory (ETS).
        Cytale.MediaProxy.Cache,
        Cytale.Gateway.PushRegistry,
        Cytale.Gateway.AdmissionLimiter,
        # U3 (bots plan, KTD4): the rights-epoch ETS owner — every rights/
        # membership mutation bumps through it; consumers recompute on move.
        Cytale.Permissions.RightsEpoch,
        # U8 (bots plan, KTD13): the interaction-token ETS owner — the
        # short-lived callback credentials (15-min life, revocation purge).
        Cytale.Interactions.TokenStore,
        # #36: the WebAuthn challenge store — single-use ceremony challenges
        # (~2-min life; consumed on use; sweep keeps the table bounded).
        Cytale.Accounts.WebAuthn.ChallengeStore,
        # #127: the two-factor grant store — the short-lived single-purpose
        # tickets the 2FA gate mints at password login (enrollment walk +
        # TOTP challenge; ~5-min life, failure-budgeted, consumed on
        # success; the same ETS-not-Scylla posture as the challenge store).
        Cytale.Accounts.TwoFactor.Grants,
        # S3 (hardening audit): the per-account brute-force dam — fixed-window
        # failure counting keyed by the ATTEMPTED identifier (login, 2FA,
        # password-reset requests). Same ETS-not-Scylla posture as the stores
        # above; the sweep that bounds the table runs in this process.
        Cytale.Accounts.AttemptGuard,
        # Review #19: the per-request credential-epoch memo (written through
        # by every epoch bump, so a revocation is seen on the next request).
        Cytale.Accounts.EpochCache,
        # #12: instance OIDC federated sign-in — the single-use ceremony
        # transactions (state/nonce/PKCE, ~10-min life, consumed on use, same
        # ETS-not-Scylla posture as the challenge store above), the provider
        # discovery/JWKS cache (per-issuer TTL), and the HTTP pool their
        # provider fetches and the token exchange go through.
        Cytale.OIDC.Transactions,
        Cytale.OIDC.Discovery,
        {Finch, name: Cytale.OIDC.Finch},
        # KTD9: the long-lived owner of the compat + webhook rate-limit ETS
        # tables (a request-process-owned table died with the connection).
        CytaleWeb.Compat.RateTables,
        # U14: the account-deletion sweep runner — a supervised task, never a
        # bare spawn (failures are logged + counted, never silent).
        {Task.Supervisor, name: Cytale.Accounts.Deletion.SweepSupervisor},
        # U3 (voice plan, KTD4): live-call machinery — the one-live-per-channel
        # room registry (its unique key IS the policy) and the rooms'
        # DynamicSupervisor.
        {Registry, keys: :unique, name: Cytale.Calls.RoomRegistry},
        Cytale.Calls.RoomSupervisor,
        # U3 (voice plan): the calls boot-sweep runner — same supervised-task
        # discipline as the deletion sweep (failures are logged, never
        # boot-wedging: the Xandra pool starts async by design).
        {Task.Supervisor, name: Cytale.Calls.SweepSupervisor},
        # U5 (notifications plan): the focused-session store. Owned here so the
        # table has a long-lived owner and the staleness sweep keeps running.
        # Delivery reads the table directly rather than calling in, because it
        # asks once per recipient on the fan-out path.
        Cytale.Notifications.Focus,
        # U6 (notifications plan): the push-send task supervisor. Sends run off
        # the fan-out path, so a slow push service adds no latency to message
        # delivery — and a supervised task means a crash is logged, never
        # silent. `max_children` (review finding #11): the fan-out's
        # notification+index leg rides here too, and it used to be a bare
        # `Task.start` per event with no ceiling — a burst could spawn unbounded
        # processes, each issuing up to ~4N queries against the 10-connection
        # pool. At the cap the supervisor returns `{:error, :max_children}` and
        # the fan-out sheds that best-effort leg loudly.
        {Task.Supervisor, name: Cytale.Notifications.TaskSupervisor, max_children: 200},
        # U6 (notifications plan): the HTTP pool web push sends through. Finch
        # was already a direct dependency but nothing had ever started a pool —
        # the push sender is its first real consumer.
        {Finch, name: Cytale.Notifications.WebPush.Finch}
      ] ++
        bridge_children() ++
        [
          Cytale.Repo.Statements,
          Cytale.Publish.ChannelRoutes,
          # Review #18: the native send's deferred, coalesced last_message_id
          # pointer writes (off the 201's path; synchronous when absent).
          Cytale.Messages.PointerWriter,
          # Review #20: the gateway read-ack's storage leg, off the socket
          # process — per-user ordered partitions (synchronous when absent).
          Cytale.Messages.AckWriter,
          # Review #24: the recount job for denormalized counts a writer
          # flagged as drifted (thread message_count, reaction tallies).
          Cytale.Maintenance.Recount
        ] ++
        if(scylla_pool?, do: [Cytale.Repo], else: []) ++
        if(scylla_pool?, do: [Cytale.Snowflake.Clock], else: []) ++
        if(scylla_pool? and not restore_mode?, do: [Cytale.Marks.Sweeper], else: []) ++
        if(backups_scheduler?, do: [Cytale.Backups.Scheduler], else: []) ++
        if(error_alerts_scheduler?, do: [Cytale.Observability.ErrorAlerts.Scheduler], else: []) ++
        if(restore_mode? or defer_endpoint?, do: [], else: [CytaleWeb.EndpointStarter])

    # Snowflake generator (U5): validate the worker id (0..1023) fail-fast at
    # boot and arm the atomics cell before anything can mint an id.
    :ok = Cytale.Snowflake.ensure_init()
    :ok = Cytale.StrictClock.ensure_init()
    :ok = Cytale.Snowflake.validate_worker_id!()

    # #118: say which key opaque permalinks are minted with. One line, never a
    # failure — the DERIVED case is the one an operator has to know about (the
    # key then moves with `secret_key_base`, and changing either invalidates
    # every link already copied).
    :ok = Cytale.Permalinks.log_key_source()

    # Boot-time schema lifecycle (hardening plan 4.5): apply (idempotent) +
    # verify, and it must complete BEFORE the endpoint accepts traffic. The
    # endpoint used to sit in `children` while these ran after
    # `Supervisor.start_link/3` returned, so a deploy answered requests during
    # the ALTER/verify window — and a failing verify crash-looped a node that
    # had ALREADY served. Flag-driven, not Mix.env-driven: releases ship without
    # Mix (Mix.env/0 would crash the boot), and the portable single-node deploy
    # opts :prod in via CYTALE_APPLY_SCHEMA_ON_BOOT (runtime.exs). dev.exs sets
    # the flag; :test never does (hermetic boot; repo_test drives migrations).
    #
    # Migrations need the Repo pool, which is a CHILD — so the ordering cannot
    # simply move above `start_link`. Instead the tree starts WITHOUT the
    # endpoint, the schema converges, and only then is the endpoint added. This
    # is the same sequencing restore mode already uses. `schema_on_boot?` and
    # `defer_endpoint?` are bound ONCE, next to the children list, because both
    # this gate and that list read them.

    result =
      Supervisor.start_link(
        children,
        strategy: :one_for_one,
        name: Cytale.Supervisor,
        # Tolerant of transient endpoint flap (e.g. listen-socket churn on
        # restart) without escalating to whole-tree shutdown.
        max_restarts: 20,
        max_seconds: 5
      )

    if schema_on_boot? do
      :ok = Cytale.Migrations.apply!()
      :ok = Cytale.Migrations.verify!()
    end

    # Only now does the node accept traffic. A verify failure above raised
    # before this line, so the node stays up WITHOUT a listener — loudly
    # unserved, never serving against a drifted or half-migrated schema.
    if defer_endpoint? do
      # Review #24: no request mints an id before the generator's floor is
      # seeded from the previous run's high-water mark (bounded wait; the
      # node still comes up when the mark is unreadable).
      :ok = Cytale.Snowflake.Clock.await_restored()
      # Through the bind-retrying start (CytaleWeb.EndpointStarter): a restart
      # after a crash must not burn the root restart budget on :eaddrinuse.
      {:ok, _pid} = Supervisor.start_child(Cytale.Supervisor, CytaleWeb.EndpointStarter)
    end

    # Dev-loop hygiene: a leaked-keyspace buildup is a working-but-slowly-dying
    # database, and its only other signal is a boot that has quietly gone from
    # seconds to minutes. Warn-only (never fails a boot) and opt-in via dev.exs,
    # so releases stay quiet.
    if Application.get_env(:cytale, :warn_on_scylla_keyspace_bloat, false) do
      :ok = Cytale.Migrations.warn_if_keyspace_count_high()
    end

    # U3 (voice plan, R8): the calls boot sweep — close `calls` rows orphaned
    # by a crash or restart (reason `swept`) before the node serves call
    # traffic. Runs supervised + async (the pool connects async by design;
    # a briefly-unreachable Scylla must never wedge the boot), and skips any
    # channel that already has a live room.
    if scylla_pool? do
      {:ok, _} =
        Task.Supervisor.start_child(Cytale.Calls.SweepSupervisor, fn ->
          closed = Cytale.Calls.sweep_stale()

          if closed > 0 do
            require Logger
            Logger.info("calls boot sweep closed #{closed} stale call row(s)")
          end
        end)
    end

    # Review #24: resume account-deletion sweeps a previous run left
    # unfinished (a deploy or crash mid-sweep). Supervised + async + patient
    # (the pool connects async; a briefly-unreachable Scylla must never wedge
    # the boot or lose the resume).
    if scylla_pool? and not restore_mode? do
      {:ok, _} =
        Task.Supervisor.start_child(Cytale.Accounts.Deletion.SweepSupervisor, fn ->
          resume_deletion_sweeps(30)
        end)
    end

    # #120 RESTORE MODE: run the staged restore now that the tree is up (the
    # Repo pool connects async inside it and the search writers exist for the
    # rebuild). While it runs NOTHING serves — the endpoint is not in the
    # tree. Success adds the endpoint (and the backup scheduler) back; any
    # failure leaves the node up, unserved, and loud, with the staged archive
    # intact for a fixed-and-retry.
    if restore_mode? do
      {:ok, _} =
        Task.Supervisor.start_child(Cytale.Backups.TaskSupervisor, fn ->
          Cytale.Backups.Restore.boot_task(Cytale.Supervisor)
        end)
    end

    result
  end

  @impl true
  def prep_stop(state) do
    # Hardening plan 4.6: a graceful stop tears down every live workspace's
    # subtree, and that teardown is `:shutdown` — the same reason a
    # budget-exhausted subtree uses. Mark the planned stop first so
    # `Cytale.Workspaces.Quarantine` does not read the teardown as a crash-loop
    # quarantine (and log an alarm) on the way out.
    Cytale.Workspaces.Quarantine.begin_shutdown()
    state
  end

  @impl true
  def config_change(changed, _new, removed) do
    # Phoenix 1.8 endpoints expose config_change/2; releases invoke the
    # Application callback with the full (changed, new, removed) triple.
    CytaleWeb.Endpoint.config_change(changed, removed)
    :ok
  end

  # U2 (terminal plan, R8a): the session bridge is its OWN plug server with its
  # own route table, so the bridge path is served on a listener the public edge
  # does not proxy. Started only when configured (it needs a provisioned
  # credential — `Cytale.SessionBridge.credential_source/0`), so an unconfigured
  # node loses only the terminal, exactly like the certificate surface itself.
  defp bridge_children do
    if CytaleWeb.BridgeServer.enabled?(), do: [CytaleWeb.BridgeServer], else: []
  end

  # The boot resume of unfinished account-deletion sweeps, retried while the
  # pool (or, on a first boot, the table) is not there yet.
  defp resume_deletion_sweeps(0) do
    require Logger
    Logger.error("account-deletion resume: the pending-sweep table stayed unreadable; resume skipped this boot")
  end

  defp resume_deletion_sweeps(attempts) do
    resumed = Cytale.Accounts.Deletion.resume_pending()

    if resumed > 0 do
      require Logger
      Logger.info("account-deletion resume: restarted #{resumed} unfinished sweep(s)")
    end
  rescue
    _ ->
      Process.sleep(1_000)
      resume_deletion_sweeps(attempts - 1)
  end
end
