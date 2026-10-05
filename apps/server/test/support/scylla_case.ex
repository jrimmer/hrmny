defmodule Cytale.ScyllaCase do
  @moduledoc """
  Shared setup for DB-backed integration test modules (U8+).

  Hermetic-test policy, made affordable: applying the 20-statement schema
  through the cluster pool costs ~15-20s per run (each CREATE TABLE waits for
  schema agreement), which — under ExUnit's default 60s test timeout on a
  loaded 4-core box — blew up every DB-backed module that re-applied DDL per
  test. This case:

    1. starts the module-owned `Cytale.Repo` pool ONCE per module
       (`setup_all`), exactly like the repo_test pattern;
    2. applies the schema once per module if it is missing
       (`system_schema` check, not blind DDL);
    3. resets DATA between tests by TRUNCATING every known table —
       milliseconds, no DDL, no schema-agreement waits;
    4. drops the keyspace at the suite boundary (async-safe: done in the
       LAST on_exit of the module, after all its tests).

  Modules using this case must NOT `Application.delete_env(:cytale, :auth)`
  in `on_exit` — that deletes shared config other concurrently-running
  modules still read (observed cross-module race). Configure secrets in
  config/test.exs instead.
  """

  use ExUnit.CaseTemplate

  # Runtime resolution, NOT a module attribute: the keyspace is env-namespaced
  # (CYTALE_TEST_KEYSPACE) per invocation, and a compile-time attribute would
  # freeze whichever name was active when the BEAM was built — silently
  # truncating the wrong keyspace across runs.
  def keyspace, do: Cytale.Repo.keyspace()

  @tables ~w(
    messages author_messages thread_messages message_embeds message_components reactions_by_message reaction_counts
    threads thread_members read_state roles
    mention_events
    channel_overwrites channels channels_by_id users users_by_username
    users_by_email refresh_tokens refresh_token_rotations verification_tokens verification_tokens_by_user
    workspaces workspaces_by_name workspace_members workspaces_of_user invites dm_channels
    dms_of_user
    push_subscriptions threads_by_id thread_members_by_user
    principals subs_by_parent bot_tokens bot_tokens_by_principal
    webhooks webhooks_by_channel message_author_overrides application_commands
    calls call_threads open_calls notification_mutes
    message_marks_by_user message_marks_by_channel message_marks_by_due
    workspace_media_settings channel_media_overrides
    notification_preferences notification_participations
    ssh_keys ssh_certificates ssh_certificates_by_serial
    ssh_certificate_audit ssh_bridge_nonces
    webauthn_credentials webauthn_credentials_by_id
    two_factor_enrollments
    client_errors
  )a

  using do
    quote do
      # Excluded from a no-database run (test_helper.exs).
      @moduletag :scylla

      import ExUnit.CaptureLog
      import Phoenix.ConnTest
      import Plug.Conn
      import Cytale.ScyllaCase, only: [truncate_all!: 0]
    end
  end

  setup_all do
    # The pool is started ONCE at test-run boot (test_helper.exs). If it is
    # already running, reuse it; otherwise start it here (older modules that
    # predate the boot reset still work standalone).
    if is_nil(GenServer.whereis(Cytale.Repo)) do
      start_supervised!(Cytale.Repo.child_spec(name: Cytale.Repo))
    end

    assert wait_until(30_000, fn -> Cytale.Repo.connected?() end),
           "Xandra cluster never connected to #{inspect(Cytale.Config.scylla_nodes())}"

    # The keyspace is reset ONCE at test-run boot (test_helper.exs). Here we
    # only guard against drift cheaply — never drop (a per-module drop races
    # concurrent modules). If verify! raises, the boot reset is stale; reapply
    # idempotently (IF NOT EXISTS) to add missing columns without dropping.
    try do
      :ok = Cytale.Migrations.verify!()
    rescue
      _e in Cytale.Migrations.Error ->
        :ok = Cytale.Migrations.apply!()
    end

    # Re-arm the Snowflake cell if another test process cleared persistent_term
    # (cheap and idempotent).
    :ok = Cytale.Snowflake.ensure_init()
    :ok = Cytale.StrictClock.ensure_init()

    # NOTE: NO on_exit keyspace drop here. An on_exit fires asynchronously
    # after THIS module's tests while OTHER modules may still be running —
    # dropping the shared cytale_test keyspace then deletes it out from under
    # them (observed: "Keyspace cytale_test does not exist" cascades). The
    # keyspace persists for the whole run; each module's setup_all self-heals
    # schema drift via verify! and fixtures isolate via unique identifiers.
    :ok
  end

  @doc """
  Milliseconds-fast data reset for tests that explicitly opt in. Requires the
  keyspace to exist (create it via `setup_all` above otherwise). NOTE: on this
  box each TRUNCATE costs 1-3s through the cluster pool — prefer unique
  per-test identifiers over calling this.
  """
  @spec truncate_all!() :: :ok
  def truncate_all! do
    keyspace = keyspace()

    Enum.each(@tables, fn table ->
      Cytale.Repo.execute!("TRUNCATE #{keyspace}.#{table}")
    end)

    :ok
  end

  def keyspace_present? do
    case Cytale.Repo.execute(
           "SELECT keyspace_name FROM system_schema.keyspaces WHERE keyspace_name = ?",
           [{"text", keyspace()}]
         ) do
      {:ok, page} -> Enum.to_list(page) != []
      {:error, _} -> false
    end
  end

  defp wait_until(timeout, _fun) when timeout <= 0, do: false

  defp wait_until(timeout, fun) do
    if fun.(),
      do: true,
      else:
        (
          Process.sleep(200)
          wait_until(timeout - 200, fun)
        )
  end
end
