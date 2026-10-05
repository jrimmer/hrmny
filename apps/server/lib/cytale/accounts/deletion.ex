defmodule Cytale.Accounts.Deletion do
  @moduledoc """
  U14 — account-deletion cascade (slice 1: core, no Tantivy).

  On self-delete the cascade, ASYNC and paginated by partition:

    1. mark the user `deleted_at` (soft-delete tombstone; handle NOT freed —
       "handle not reusable" per the plan) AND close the user's OWN live
       gateway sessions with 4004 + purge their resume records — the tombstone
       and the death of the account's own sockets are the SAME instant, never
       "eventually" (the sweep is async; a deleted principal must not keep a
       working socket — and keep receiving dispatches — until it happens to
       disconnect),
    2. tombstone the user's messages via the `author_messages` locator sweep:
       enumerate `(channel_id, bucket)` partitions and `SET content =
       '[message deleted]', author_id = NULL` — no blind scans over unknown
       partitions,
    3. revoke every sub-credential (machine principals parented to the user)
       and close their live gateway sessions with 4004 + purge their resume
       records (KTD6) — sub-identities never outlive their parent's account —
       and revoke the user's OWN credentials (`Auth.revoke_all_sessions/1`):
       the refresh token the account still holds must not keep rotating for up
       to its TTL (the epoch bump also refuses a pre-deletion access token at
       the auth plug and at gateway Identify),
    4. remove the user's workspace memberships and DM access (only the
       deleting user's DM access is removed; the partner's copy of the
       conversation remains — their messages are their own content),
    5. emit `ACCOUNT_DELETE` through the Publish seam,
    6. schedule the 30-day-grace hard-delete (a documented stub a periodic
       job calls — the actual sweep is out of slice-1 scope).

  The cascade returns `:ok` immediately and runs the sweep under
  `Cytale.Accounts.Deletion.SweepSupervisor` (a Task.Supervisor in the app
  tree — a bare spawn's failure was silent and unobserved), so the REST
  response is non-blocking (202 Accepted). A sweep failure is logged loudly
  plus a `[:cytale, :accounts, :deletion_sweep_failure]` telemetry counter.
  At hundreds-scale the sweep runs in seconds.
  """

  alias Cytale.Accounts.Auth
  alias Cytale.Accounts.Principals
  alias Cytale.Accounts.User
  alias Cytale.Gateway.SessionStore
  alias Cytale.Messages.AuthorLocator
  alias Cytale.Permissions.RightsEpoch
  alias Cytale.Publish
  alias Cytale.Repo
  alias Cytale.Search
  alias Cytale.Workspaces

  require Logger

  @tombstone_content "[message deleted]"
  @grace_days 30
  # Discord-shaped auth-failed close: dead credential, non-reconnectable.
  @close_auth_failed 4004
  # The supervised sweep runner (app tree; see Cytale.Application).
  @sweep_supervisor Cytale.Accounts.Deletion.SweepSupervisor

  @doc "The supervision tree entry the async sweep runs under."
  @spec sweep_supervisor() :: module()
  def sweep_supervisor, do: @sweep_supervisor

  @doc "The tombstone content written over a deleted user's messages."
  @spec tombstone_content() :: String.t()
  def tombstone_content, do: @tombstone_content

  @doc "The 30-day grace period before hard-delete (days)."
  @spec grace_days() :: pos_integer()
  def grace_days, do: @grace_days

  @doc """
  Start the account-deletion cascade. Marks the user deleted synchronously
  (so the tombstone is durable before the async sweep), closes the user's own
  live gateway sessions in the same step, then starts the sweep under the
  deletion Task.Supervisor (an isolated, supervised task — never a bare
  spawn). Returns `:ok` immediately — the REST handler answers 202.
  """
  @spec delete_account(integer(), keyword()) :: :ok
  def delete_account(user_id, opts \\ []) when is_integer(user_id) do
    :ok = User.soft_delete!(user_id)

    # 1b. The account's OWN live gateway sessions die WITH the tombstone, in
    #     the caller — deliberately NOT in the async sweep. A tombstoned
    #     principal that keeps a working socket keeps receiving dispatches
    #     until it happens to disconnect; the user who pressed delete must not
    #     be answered with a socket that still talks. Same primitive and same
    #     documented close code the machine-principal cascade (see
    #     revoke_sub_credentials/1 below) and "sign out everywhere"
    #     (AccountController.revoke_all_sessions/2) use: 4004 — dead
    #     credential, non-reconnectable — and the stored records are purged
    #     with it, so Resume cannot resurrect the session either. Idempotent:
    #     an account with no live sessions, or an already-deleted account,
    #     tears down nothing.
    :ok = SessionStore.close_principal_sessions(user_id, @close_auth_failed)

    # Review #24: the sweep is recorded as PENDING before it starts, and the
    # record is cleared only when every step has run. A node that dies
    # mid-sweep (a deploy, a crash, an OOM) used to leave the account
    # tombstoned but half-swept forever; `resume_pending/0` finds the record
    # at the next boot and runs the idempotent sweep again.
    :ok = record_pending(user_id)

    # `sync: true` runs the sweep in the caller — the determinism door tests
    # use; production keeps the supervised async path (a fixed-sleep wait on
    # the async path raced under suite load and flaked the ACCOUNT_DELETE
    # log assertion).
    if Keyword.get(opts, :sync, false) do
      supervised_sweep(user_id)
      :ok
    else
      case Task.Supervisor.start_child(@sweep_supervisor, fn -> supervised_sweep(user_id) end) do
        {:ok, _task} ->
          :ok

        {:error, reason} ->
          # The supervisor itself is unavailable (not running / shutting down):
          # fall back to an in-caller run so the cascade NEVER silently no-ops —
          # the sweep's own supervision/logging applies either way.
          Logger.error(
            "account-deletion sweep supervisor unavailable (#{inspect(reason)}); " <>
              "running sweep in caller for user #{user_id}"
          )

          supervised_sweep(user_id)
          :ok
      end
    end
  end

  # The supervised task body: run the sweep, and on failure log loudly plus
  # count it ([:cytale, :accounts, :deletion_sweep_failure]) — a DB error
  # mid-sweep previously aborted the remaining steps silently. The rescue
  # mirrors the search-step best-effort precedent: observed, never escalated
  # into the caller.
  defp supervised_sweep(user_id) do
    :ok = run_sweep(user_id)
    # Only a sweep that ran to the end clears the pending record; a raise
    # (below) leaves it for the next boot's resume.
    clear_pending(user_id)
  rescue
    e ->
      Logger.error(
        "account-deletion sweep failed for user #{user_id}: " <>
          Exception.format(:error, e, __STACKTRACE__)
      )

      :telemetry.execute(
        [:cytale, :accounts, :deletion_sweep_failure],
        %{count: 1},
        %{user_id: user_id}
      )

      :error
  end

  @doc """
  Resume every account-deletion sweep a previous run left unfinished (review
  #24) — called once at boot, supervised and async like the calls sweep.
  Each resumed sweep runs under the same supervisor and failure accounting as
  a fresh one; a sweep that fails again stays pending for the next boot.
  Returns the number of sweeps started.
  """
  @spec resume_pending() :: non_neg_integer()
  def resume_pending do
    user_ids =
      "SELECT user_id FROM {{K}}.pending_account_sweeps"
      |> Repo.stream_rows!([])
      |> Enum.map(& &1["user_id"])

    Enum.each(user_ids, fn user_id ->
      Logger.warning("account-deletion sweep for user #{user_id} did not finish before the last stop; resuming")

      case Task.Supervisor.start_child(@sweep_supervisor, fn -> supervised_sweep(user_id) end) do
        {:ok, _task} -> :ok
        {:error, _reason} -> supervised_sweep(user_id)
      end
    end)

    length(user_ids)
  end

  @doc "Sweeps recorded as pending (tests, diagnostics)."
  @spec pending() :: [integer()]
  def pending do
    "SELECT user_id FROM {{K}}.pending_account_sweeps"
    |> Repo.stream_rows!([])
    |> Enum.map(& &1["user_id"])
  end

  defp record_pending(user_id) do
    Repo.execute!(
      "INSERT INTO {{K}}.pending_account_sweeps (user_id, requested_at) VALUES (?, ?)",
      [{"bigint", user_id}, {"timestamp", DateTime.utc_now() |> DateTime.truncate(:millisecond)}]
    )

    :ok
  end

  defp clear_pending(user_id) do
    Repo.execute!("DELETE FROM {{K}}.pending_account_sweeps WHERE user_id = ?", [{"bigint", user_id}])
    :ok
  end

  @doc """
  The sweep body (runs in a spawned process). Idempotent and partition-
  paginated: safe to re-run, and safe to call directly for tests.
  """
  @spec run_sweep(integer()) :: :ok
  def run_sweep(user_id) when is_integer(user_id) do
    # 2. Tombstone messages via the locator sweep (no blind scans). Each
    #    authored message is tombstoned by its full primary key.
    messages = AuthorLocator.list_messages(user_id)
    Enum.each(messages, &tombstone_message(&1))

    # 2b. Remove the user's messages from the search index (Tantivy).
    #    Best-effort with documented lag: if delete_by_author fails, the
    #    tombstoning above already succeeded — chat is never lost, search
    #    degrades until the index recovers (plan error path).
    remove_from_search_index(user_id)

    # 2c. The rosters the account leaves — the person in every workspace, and
    #     each of their machines wherever its grant reached — read NOW, while
    #     the membership and principal rows that define them still exist.
    #     Announced after step 4 (a resumed sweep reads an already-emptied set
    #     and announces nothing twice).
    departures = CytaleWeb.MemberEvents.departures(user_id)

    # 3. Sub-credential cascade (bots plan U4, KTD6): every machine principal
    #    parented to the user loses its credential AND its live sessions —
    #    tokens 401 on next use, sockets close 4004, resume records purge.
    revoke_sub_credentials(user_id)

    # 3b. The user's OWN credential dies with the account (#62). The cascade
    #     above is thorough about SUB-credentials but was silent about the
    #     user's own: with the tombstone set and the row still present, the
    #     refresh token the account's browser holds survived (TokenStore rows
    #     are keyed by user_id and nothing swept them), so a DELETED account
    #     kept rotating it and minting access tokens the API accepted — the
    #     privacy guarantee `DELETE /api/v1/account` makes, silently not
    #     holding for up to the 30-day refresh TTL.
    #
    #     Same shape as the password-reset completion path
    #     (Verification.complete_password_reset/2), which revokes as part of
    #     ending a session: revoke-all bumps the credential epoch (the auth
    #     plug and gateway Identify refuse a token minted before the deletion
    #     — the same hole, since Identify carries no account-state check) and
    #     drops every stored refresh-token hash, so `rotate_refresh_token/2`
    #     reads the credential as revoked. The live sockets were already
    #     closed at step 1 — this is the credential half of the same teardown.
    :ok = Auth.revoke_all_sessions(user_id)

    # 4. Remove workspace memberships + DM access.
    remove_memberships(user_id)
    remove_dm_access(user_id)

    # 4a. Every open client drops them from its roster live — the same
    #     MemberRemove a kick or a revoked grant sends (CytaleWeb.MemberEvents).
    :ok = CytaleWeb.MemberEvents.announce_departures(departures)

    # 4b. Drop the member's notification state. Nothing user-visible renders
    #     preferences or subscriptions, but the notification decision reads
    #     both — and a surviving SUBSCRIPTION would keep pushing to a device
    #     belonging to a deleted account (plan U2/U6, R19).
    :ok = Cytale.Notifications.Preferences.clear_all(user_id)
    :ok = Cytale.Notifications.Subscriptions.delete_all_for_user(user_id)
    :ok = Cytale.Notifications.Participations.delete_all_for_user(user_id)

    # 4c. SSH certificate surface (terminal plan U2): the member's stored public
    #     keys, the issuance rows they produced, and the bridge's by-serial rows
    #     all go — R5a's "removal prevents further issuance or authentication"
    #     applies to deletion as much as to a hand removal, and a deleted
    #     account must not keep a mint path.
    #
    #     The AUDIT rows deliberately survive: the trail is the detection path
    #     for a compromise this product cannot prevent, so the account reference
    #     is de-identified rather than the record deleted (R6a/R8b).
    :ok = Cytale.SSH.CertificateStore.delete_all_for_account(user_id)
    :ok = Cytale.SSH.Audit.deidentify_account(user_id)

    # 4d. TOTP two-factor enrollment (#127): the account's second factor dies
    #     with the account, like every other credential (a tombstoned account
    #     can never log in again, but its rows should not outlive it either).
    :ok = Cytale.Accounts.TwoFactor.clear_enrollment(user_id)

    # 4e. Message marks (#54): the account's reminders go with it. Its sweep
    #     index rows are left to their TTLs — the sweep's fence re-reads the
    #     authoritative row, finds none, and fires nothing.
    :ok = Cytale.Marks.delete_all_for_user(user_id)

    # 5. Emit ACCOUNT_DELETE (best-effort; the Publish seam never raises).
    emit_account_delete(user_id)

    # 6. Schedule the 30-day hard-delete (documented stub — a periodic job
    #    calls hard_delete_after_grace/1; the actual sweep is out of scope).
    :ok
  end

  @doc """
  Hard-delete after the 30-day grace period. DOCUMENTED STUB for slice 1:
  the real sweep (removing the user row + any residual locator/index state)
  is a periodic job's responsibility. This function exists so the contract
  is explicit and testable; it currently no-ops.
  """
  @spec hard_delete_after_grace(integer()) :: :ok
  def hard_delete_after_grace(_user_id), do: :ok

  # -- internals ---------------------------------------------------------------

  # Sub-credential cascade: revoke every machine credential parented to the
  # deleting user and tear down its live gateway sessions. Provenance rows
  # survive (U1 revocation semantics — attribution stays), but the tokens die
  # wire-instant (R2): 4004 close + resume purge via the principal→session
  # index in SessionStore. For :webhook-kind principals the URL capability is
  # the LIVE credential (the minted bot_token died at creation) — the
  # webhooks/webhooks_by_channel rows die with the parent's account, so
  # execute 404s from then on (A12: rows must not outlive the account).
  defp revoke_sub_credentials(user_id) do
    user_id
    |> Principals.list_by_parent()
    |> Enum.each(fn principal ->
      if principal.kind == :webhook do
        # webhook_id IS the principal's user_id — Webhooks.delete_webhook/1
        # removes BOTH capability rows. (The admin LEAVING the workspace is
        # deliberately NOT this path — KD8 keeps the webhook alive there.)
        :ok = Cytale.Webhooks.delete_webhook(principal.user_id)
      end

      # Parent account deleted = the sub-identity dies: credential, live
      # sessions, AND provenance rows (liveness hides its commands). The
      # users row stays so historical attribution keeps resolving.
      :ok = Principals.delete_machine_principal!(principal.user_id)
      :ok = SessionStore.close_principal_sessions(principal.user_id, @close_auth_failed)
    end)

    :ok
  end

  # Remove the user's messages from every search index they were a member of
  # (per-workspace indexes) plus the DM segment. Best-effort: each call is
  # wrapped so a Tantivy failure never aborts the cascade — tombstoning
  # already succeeded (plan error path: search degrades, chat persists).
  defp remove_from_search_index(user_id) do
    workspace_ids =
      Repo.execute!(
        "SELECT workspace_id FROM {{K}}.workspaces_of_user WHERE user_id = ?",
        [{"bigint", user_id}]
      )
      |> Enum.to_list()
      |> Enum.map(& &1["workspace_id"])

    Enum.each(workspace_ids, fn ws_id ->
      try do
        :ok = Search.delete_by_author(ws_id, user_id)
      rescue
        _e -> :ok
      end
    end)

    # DM segment: best-effort (documented stub until DM search wiring).
    try do
      :ok = Search.delete_by_author_dm(user_id)
    rescue
      _e -> :ok
    end

    :ok
  end

  # Tombstone one authored message by its full primary key (channel_id,
  # bucket, message_id) — no ALLOW FILTERING, no scan over a partition's
  # other authors.
  defp tombstone_message({channel_id, bucket, message_id}) do
    Repo.execute!(
      "UPDATE {{K}}.messages SET content = ?, author_id = NULL WHERE channel_id = ? AND bucket = ? AND message_id = ?",
      [
        {"text", @tombstone_content},
        {"bigint", channel_id},
        {"int", bucket},
        {"bigint", message_id}
      ]
    )

    :ok
  end

  # Remove the user from every workspace they belong to (workspace_members +
  # workspaces_of_user rows). Each removal bumps that workspace's rights
  # epoch (KTD4) so memoized rights consumers see the membership die.
  defp remove_memberships(user_id) do
    workspace_ids =
      Repo.execute!(
        "SELECT workspace_id FROM {{K}}.workspaces_of_user WHERE user_id = ?",
        [{"bigint", user_id}]
      )
      |> Enum.to_list()
      |> Enum.map(& &1["workspace_id"])

    Enum.each(workspace_ids, fn ws_id ->
      :ok = Workspaces.remove_member(ws_id, user_id)
      RightsEpoch.bump(ws_id)
    end)

    :ok
  end

  # Remove the deleting user's DM access. dm_channels stores user_ids as a
  # list; we rewrite each DM the user is in to drop them. If the user was the
  # only participant, the DM row is removed entirely. The partner's copy of
  # the conversation (their messages) is untouched.
  #
  # PERF-14 verdict — the `user_ids CONTAINS ?` scan STAYS, deliberately. The
  # `dms_of_user` index exists (bots plan B-1: one row per participant, written
  # at open_dm, and NEVER deleted — even a full dm_channels delete leaves both
  # index rows behind), so sourcing candidates from it would be safe in the
  # superset direction: an extra index row just hits a missing dm_channels row
  # and no-ops. It is NOT safe in the missing direction, and the lifecycle has
  # a proven gap there: dm_channels shipped at repo commit 0c43058 (U9) while
  # dms_of_user shipped later at c8c665a (bots B-1), so a keyspace that predates
  # B-1 holds DM rows with NO index row — those DMs would silently drop out of
  # the removal set, leaving the deleted account as a live participant. There
  # is no data-migration framework to backfill them (the same constraint
  # PERF-08's self-healing backfill works around — but there a fresh principal
  # starts empty, while a DM predates its index by construction). Until such a
  # backfill exists, correctness of the deletion set outranks the scan cost:
  # the set of deleted rows must stay IDENTICAL, and only the scan guarantees
  # that.
  defp remove_dm_access(user_id) do
    dms =
      Repo.execute!(
        "SELECT channel_id, user_ids FROM {{K}}.dm_channels WHERE user_ids CONTAINS ? ALLOW FILTERING",
        [{"bigint", user_id}]
      )
      |> Enum.to_list()

    Enum.each(dms, fn dm ->
      remaining = Enum.reject(dm["user_ids"] || [], &(&1 == user_id))

      if remaining == [] do
        Repo.execute!(
          "DELETE FROM {{K}}.dm_channels WHERE channel_id = ?",
          [{"bigint", dm["channel_id"]}]
        )
      else
        Repo.execute!(
          "UPDATE {{K}}.dm_channels SET user_ids = ? WHERE channel_id = ?",
          [{"list<bigint>", remaining}, {"bigint", dm["channel_id"]}]
        )
      end
    end)

    :ok
  end

  defp emit_account_delete(user_id) do
    deleted_at = DateTime.utc_now() |> DateTime.truncate(:millisecond)

    Publish.publish(0, {
      "ACCOUNT_DELETE",
      %{
        "user_id" => Integer.to_string(user_id),
        "deleted_at" => DateTime.to_iso8601(deleted_at)
      }
    })

    :ok
  end
end
