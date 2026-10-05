defmodule Cytale.Backups.SchedulerTest do
  @moduledoc """
  #120 — the backup schedule, driven the way the ticket asks: with an
  INJECTED CLOCK. No test sleeps out an interval.

    * the schedule FIRES when the injected clock says the window was missed
      (hourly plan, last success 2h ago);
    * it stays quiet while the window is open;
    * catch-up-on-boot: the state file's stale anchor makes the FIRST tick
      run, without waiting an interval;
    * prune drops archives past retention (by id date, never touching
      non-backup files);
    * `backups.enabled = false` muzzles everything;
    * a failing run lands as a counted FAILURE on the #87 metrics surface
      (`cytale_backups_total{result="failure"}`), and a success records the
      duration + last-success timestamp — verified through the REAL
      `/metrics` route.
  """

  use Cytale.ScyllaCase, async: false

  alias Cytale.Backups.Metrics
  alias Cytale.{Messages, Workspaces}

  @endpoint CytaleWeb.Endpoint

  setup do
    # Random suffix, NOT unique_integer: fresh test VMs restart the counter,
    # and a reused name would find a STALE state file (and prune) instantly.
    tmp = Path.join(System.tmp_dir!(), "cytale_bk_sched_#{rand_suffix()}")
    File.mkdir_p!(tmp)

    backups_env = Application.get_env(:cytale, :backups)
    clock_env = Application.get_env(:cytale, :backups_clock_fn)
    poll_env = Application.get_env(:cytale, :backups_poll_ms)
    token_env = Application.get_env(:cytale, :metrics_token)

    Application.put_env(:cytale, :backups,
      frequency: "hourly",
      retention: 3,
      enabled: true,
      dir: tmp
    )

    Application.put_env(:cytale, :backups_poll_ms, 10)
    Application.delete_env(:cytale, :backups_clock_fn)

    if :ets.whereis(Metrics) != :undefined, do: :ets.delete_all_objects(Metrics)

    {:ok, ws} = Workspaces.create_workspace(1, "BkSched " <> Cytale.TestNonce.get())
    {:ok, ch} = Workspaces.create_channel(ws.workspace_id, "general")
    {:ok, _} = Messages.create_message(%{channel_id: ch.channel_id, author_id: 1, content: "sched seed"})

    on_exit(fn ->
      Application.put_env(:cytale, :backups, backups_env)
      restore_env(:backups_clock_fn, clock_env)
      Application.put_env(:cytale, :backups_poll_ms, poll_env)
      Application.put_env(:cytale, :metrics_token, token_env)
      File.rm_rf!(tmp)
    end)

    {:ok, tmp: tmp}
  end

  defp rand_suffix, do: :crypto.strong_rand_bytes(8) |> Base.encode16(case: :lower)

  defp restore_env(_key, :bad), do: :ok
  defp restore_env(key, value), do: Application.put_env(:cytale, key, value)

  # The state file is the scheduler's memory across boots; tests write it to
  # position the anchor.
  defp write_state(dir, last_success_at) do
    File.write!(Path.join(dir, ".scheduler-state.json"), Jason.encode!(%{"last_success_at" => last_success_at}))
  end

  defp await_file(path, timeout \\ 20_000) do
    deadline = System.monotonic_time(:millisecond) + timeout

    do_await(path, deadline)
  end

  defp do_await(path, deadline) do
    cond do
      File.exists?(path) ->
        :ok

      System.monotonic_time(:millisecond) > deadline ->
        flunk("expected #{path} to appear")

      true ->
        Process.sleep(20)
        do_await(path, deadline)
    end
  end

  defp await_any_tar(dir, timeout \\ 20_000) do
    deadline = System.monotonic_time(:millisecond) + timeout

    do_await_tar(dir, deadline)
  end

  defp do_await_tar(dir, deadline) do
    cond do
      first_tar(dir) ->
        Path.join(dir, first_tar(dir))

      System.monotonic_time(:millisecond) > deadline ->
        flunk("expected a backup archive to appear in #{dir}")

      true ->
        Process.sleep(20)
        do_await_tar(dir, deadline)
    end
  end

  defp first_tar(dir) do
    dir |> File.ls!() |> Enum.find(&String.ends_with?(&1, ".tar"))
  end

  # -- the schedule ---------------------------------------------------------------

  test "the schedule fires when the injected clock is past the window", %{tmp: tmp} do
    two_hours_ago = DateTime.utc_now() |> DateTime.add(-2, :hour) |> DateTime.to_iso8601()
    write_state(tmp, two_hours_ago)

    start_supervised!(Cytale.Backups.Scheduler)
    # (The test itself wrote a state file above, so the signal that the RUN
    # landed is the archive tar, not the state file.)
    await_any_tar(tmp)
    assert tar = first_tar(tmp)
    assert String.starts_with?(tar, "bk-")

    # A success was recorded with a fresh last-success anchor.
    assert eventually(fn -> Metrics.snapshot().success == 1 end)
    snap = Metrics.snapshot()
    assert snap.failure == 0
    assert snap.last_success_unix > System.system_time(:second) - 60
  end

  test "a fresh install runs its first backup immediately (catch-up-on-boot)", %{tmp: tmp} do
    # No state file at all: the scheduler cannot know the last success, so
    # the first tick runs — the same code path a missed window takes on boot.
    start_supervised!(Cytale.Backups.Scheduler)

    # The state file is written inside finish_run: its appearance means the
    # outcome (not just the tar) has landed.
    await_file(Path.join(tmp, ".scheduler-state.json"))
    assert Metrics.snapshot().success == 1
  end

  test "the scheduler stays quiet while the window is open", %{tmp: tmp} do
    write_state(tmp, DateTime.utc_now() |> DateTime.to_iso8601())
    start_supervised!(Cytale.Backups.Scheduler)

    # Several polls (10ms each) over a half second: an hourly window has
    # hours to run — nothing may fire.
    Process.sleep(400)

    refute first_tar(tmp)
    assert Metrics.snapshot().success == 0
  end

  test "the injected clock alone can make the schedule fire", %{tmp: tmp} do
    write_state(tmp, DateTime.utc_now() |> DateTime.to_iso8601())

    # The clock now reads two hours ahead: the hourly window closed, and the
    # next poll must catch up — no state rewrite, no restart.
    Application.put_env(:cytale, :backups_clock_fn, fn -> DateTime.utc_now() |> DateTime.add(2, :hour) end)

    start_supervised!(Cytale.Backups.Scheduler)
    await_any_tar(tmp)
    assert eventually(fn -> Metrics.snapshot().success == 1 end)
  end

  test "backups.enabled = false muzzles the scheduler", %{tmp: tmp} do
    Application.put_env(:cytale, :backups,
      frequency: "hourly",
      retention: 3,
      enabled: false,
      dir: tmp
    )

    start_supervised!(Cytale.Backups.Scheduler)
    Process.sleep(300)

    refute first_tar(tmp)
    assert Metrics.snapshot().success == 0
  end

  # -- prune ----------------------------------------------------------------------

  test "prune ignores an interrupted archive and keeps the restorable ones", %{tmp: tmp} do
    # Hardening 4.8. The sidecar is written AFTER the tar completes, so a `.tar`
    # with no sidecar is an interrupted backup. Counting it as real let a partial
    # occupy a retention slot and evict the OLDEST RESTORABLE archive — one
    # failed backup destroying a good one. The sibling test below writes a
    # sidecar for every fixture, which is precisely why it never caught this.
    for id <- ~w(bk-20260101T000000Z-aaa bk-20260102T000000Z-bbb bk-20260103T000000Z-ccc) do
      File.write!(Path.join(tmp, "#{id}.tar"), "complete")
      File.write!(Path.join(tmp, "#{id}.manifest.json"), "{}")
    end

    # NEWEST id, but interrupted: no sidecar.
    partial = "bk-20260104T000000Z-ddd.tar"
    File.write!(Path.join(tmp, partial), "half-written")

    # Direct call: `prune/2` is pure filesystem work, so this needs no database
    # and no scheduler run.
    :ok = Cytale.Backups.Scheduler.prune(tmp, 3)

    for id <- ~w(bk-20260101T000000Z-aaa bk-20260102T000000Z-bbb bk-20260103T000000Z-ccc) do
      assert File.exists?(Path.join(tmp, "#{id}.tar")),
             "#{id} must survive — a partial archive must not consume its slot"
    end

    # Left alone deliberately: a sidecar-less tar may be a backup still RUNNING.
    assert File.exists?(Path.join(tmp, partial))
  end

  test "prune keeps retention archives by id date and touches nothing else", %{tmp: tmp} do
    # Three fake, OLD archives (parseable ids) plus an unrelated file.
    for {name, body} <- [
          {"bk-20260101T000000Z-aaa.tar", "old1"},
          {"bk-20260102T000000Z-bbb.tar", "old2"},
          {"bk-20260103T000000Z-ccc.tar", "old3"}
        ] do
      File.write!(Path.join(tmp, name), body)
      File.write!(Path.join(tmp, String.replace_suffix(name, ".tar", ".manifest.json")), "{}")
    end

    File.write!(Path.join(tmp, "operator-notes.txt"), "keep me")

    start_supervised!(Cytale.Backups.Scheduler)

    # Retention is 3: the run's own archive (newest by id) + the two newest
    # fakes stay; the OLDEST fake goes; the unrelated file never moves.
    # The state file signals the run (and its same-pass prune) completed.
    await_file(Path.join(tmp, ".scheduler-state.json"))

    assert eventually(fn ->
             tars = Enum.filter(File.ls!(tmp), &String.ends_with?(&1, ".tar")) |> Enum.sort()

             length(tars) == 3 and "bk-20260102T000000Z-bbb.tar" in tars and
               "bk-20260103T000000Z-ccc.tar" in tars and
               "bk-20260101T000000Z-aaa.tar" not in tars
           end)

    assert File.exists?(Path.join(tmp, "operator-notes.txt"))
    refute File.exists?(Path.join(tmp, "bk-20260101T000000Z-aaa.manifest.json"))
  end

  test "prune bounds the kept pre-restore safety snapshots (plan 4.7)", %{tmp: tmp} do
    # `Restore.apply_staged/2` writes a FULL-database snapshot under
    # `.restore-safety` before its destructive step and KEEPS it when the
    # restore fails — deliberately, so an operator has something to go back to.
    # Nothing else reclaims those: prune lists only the root's `<id>.tar` +
    # sidecar pairs and the staging sweep matches only `.staging-*`, so a
    # repeatedly-failing restore left one more full dump per attempt until the
    # volume filled — which is also the point where the NEXT restore's snapshot
    # degrades to a warning and the safety net is silently gone. Only the newest
    # is a recovery point an operator can still use.
    safety = Path.join(tmp, ".restore-safety")
    File.mkdir_p!(safety)

    for id <- ~w(bk-20260101T000000Z-aaa bk-20260102T000000Z-bbb bk-20260103T000000Z-ccc) do
      File.write!(Path.join(safety, "#{id}.tar"), "snapshot")
      File.write!(Path.join(safety, "#{id}.manifest.json"), "{}")
    end

    # A snapshot build killed mid-write leaves its own staging dir behind.
    stale_staging = Path.join(safety, ".staging-bk-20260103T000000Z-ccc")
    File.mkdir_p!(stale_staging)
    File.touch!(stale_staging, {{2020, 1, 1}, {0, 0, 0}})

    :ok = Cytale.Backups.Scheduler.prune(tmp, 3)

    # The newest survives WITH its sidecar — that pair is the recovery point —
    # and every older one is gone, sidecars included.
    assert File.exists?(Path.join(safety, "bk-20260103T000000Z-ccc.tar"))
    assert File.exists?(Path.join(safety, "bk-20260103T000000Z-ccc.manifest.json"))

    for id <- ~w(bk-20260101T000000Z-aaa bk-20260102T000000Z-bbb) do
      refute File.exists?(Path.join(safety, "#{id}.tar"))
      refute File.exists?(Path.join(safety, "#{id}.manifest.json"))
    end

    refute File.exists?(stale_staging),
           "an abandoned snapshot staging dir must be reclaimed on the same pass"
  end

  # -- failure is counted, never silent ----------------------------------------------

  test "a failing run records the failure family and does not wedge the scheduler", %{tmp: tmp} do
    # The dir is a FILE: Archive.write raises, the task's rescue lands the
    # outcome as a failure, and the scheduler arms for the next tick.
    File.rm_rf!(tmp)
    File.write!(tmp, "not a directory")

    start_supervised!(Cytale.Backups.Scheduler)

    assert eventually(fn -> Metrics.snapshot().failure >= 1 end)
    assert Metrics.snapshot().success == 0

    # The scheduler survived the failure and is still answering.
    assert GenServer.whereis(Cytale.Backups.Scheduler)
  end

  # -- the /metrics families (#87 surface, #120 families) -------------------------------

  test "after a success and a forced failure, /metrics carries the three families", %{
    tmp: tmp
  } do
    start_supervised!(Cytale.Backups.Scheduler)
    await_file(Path.join(tmp, ".scheduler-state.json"))
    assert Metrics.snapshot().success >= 1

    # Force a failure WITHOUT losing the success record and WITHOUT racing the
    # due-check: point the dir at a FILE (the next run cannot even stage) and
    # run now. The state file is gone with the dir, so the run is due.
    blocker = Path.join(System.tmp_dir!(), "cytale_bk_blocker_#{rand_suffix()}")
    File.write!(blocker, "not a directory")

    Application.put_env(:cytale, :backups,
      frequency: "hourly",
      retention: 3,
      enabled: true,
      dir: blocker
    )

    assert :ok = Cytale.Backups.Scheduler.run_now()
    assert eventually(fn -> Metrics.snapshot().failure >= 1 end)

    snap = Metrics.snapshot()

    # Restore the real dir so the remaining assertions (and on_exit) work.
    Application.put_env(:cytale, :backups,
      frequency: "hourly",
      retention: 3,
      enabled: true,
      dir: tmp
    )

    File.rm(blocker)

    exposition = Metrics.exposition()

    # Presence + monotonicity, not exact counts: the counters are global ETS,
    # and another suite's forced failure can land between this test's snapshot
    # and its exposition read (full-gate ordering, 2026-09-15).
    assert exposition =~ ~s(cytale_backups_total{result="success"} #{snap.success})
    assert exposition =~ ~r/cytale_backups_total\{result="failure"\} \d+/

    failure_now =
      Regex.run(~r/cytale_backups_total\{result="failure"\} (\d+)/, exposition)
      |> Enum.at(1)
      |> String.to_integer()

    assert failure_now >= snap.failure

    assert exposition =~ "cytale_backup_duration_ms #{snap.duration_ms}"
    assert exposition =~ "cytale_backup_last_success_timestamp_seconds #{snap.last_success_unix}"
    assert snap.last_success_unix > 0

    # The SAME families ride the real /metrics surface (token-gated).
    Application.put_env(:cytale, :metrics_token, "bk-metrics-token")

    conn =
      build_conn()
      |> put_req_header("authorization", "Bearer bk-metrics-token")
      |> Phoenix.ConnTest.get("/metrics")

    assert conn.status == 200
    assert conn.resp_body =~ ~s(# TYPE cytale_backups_total counter)

    # Same monotonicity rule as the in-process read above, and for the same
    # reason: the scheduler is STILL LIVE with a run dir that is a file, so its
    # tick can record another failure between the snapshot and this request.
    # (Exact equality here failed under full-suite load with `failure 2` against a
    # snapshot of 1; stopping the scheduler instead is not an option — the
    # counters are owned by the subtree that would go with it, which emptied the
    # whole exposition.)
    assert conn.resp_body =~ ~r/cytale_backups_total\{result="success"\} \d+/
    assert conn.resp_body =~ ~r/cytale_backups_total\{result="failure"\} \d+/

    failure_over_http =
      ~r/cytale_backups_total\{result="failure"\} (\d+)/
      |> Regex.run(conn.resp_body)
      |> Enum.at(1)
      |> String.to_integer()

    assert failure_over_http >= snap.failure
    assert conn.resp_body =~ "cytale_backup_last_success_timestamp_seconds #{snap.last_success_unix}"

    # The pre-existing families are untouched by the append.
    assert conn.resp_body =~ "cytale_fanout_dispatch_ms"
  end

  defp eventually(fun, tries \\ 200)

  defp eventually(_fun, 0), do: flunk("condition never became true")

  defp eventually(fun, tries) do
    if fun.(), do: :ok, else: Process.sleep(20) && eventually(fun, tries - 1)
  end
end
