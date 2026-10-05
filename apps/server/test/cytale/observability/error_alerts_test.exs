defmodule Cytale.Observability.ErrorAlertsTest do
  @moduledoc """
  #138 — the client-error recurrence alerter, driven the way the ticket's
  acceptance criteria read, with an INJECTED CLOCK (no test sleeps out a
  window):

    * threshold crossed inside a window → EXACTLY ONE DM (not per occurrence,
      not once per pass — the ledger's bucket dedupe);
    * a second window with continuing occurrences → exactly ONE more DM,
      worded "STILL" — not silence, not a flood;
    * quiet a full window and back → one more DM worded "RETURNED" (the
      regression, distinct on purpose);
    * below threshold → nothing;
    * the off switch → nothing, while the error store keeps recording;
    * the DM alone identifies the failing code path;
    * no admin configured → silence, not error (but counted);
    * telemetry-shaped groups (no stack) never alert, however loud;
    * the per-pass cap bounds a fingerprint storm;
    * a muted admin is not nagged (policy + preferences apply for free);
    * the injected clock alone drives the tick cadence; a restart with the
      persisted ledger stays silent.
  """

  use Cytale.ScyllaCase, async: false

  alias Cytale.Accounts.User
  alias Cytale.Notifications.{Delivery, Preferences}
  alias Cytale.Observability.ClientErrors
  alias Cytale.Observability.ErrorAlerts
  alias Cytale.Observability.ErrorAlerts.{Ledger, Metrics, Scheduler}

  # Every test gets its OWN UTC day (nonce-derived, spaced 3 apart): the
  # error store is NOT truncated between tests (ScyllaCase truncation is
  # opt-in), and the aggregation reads whole day partitions — so the only
  # rows a pass can ever see are the ones THIS test wrote into ITS day.
  # Fixed clocks would leak earlier tests' fingerprints into every count.
  @day_ms 86_400_000

  setup do
    tmp = Path.join(System.tmp_dir!(), "cytale_err_alerts_#{rand_suffix()}")
    File.mkdir_p!(tmp)

    prev = %{
      ledger: Application.get_env(:cytale, :error_alerts_ledger_path),
      clock: Application.get_env(:cytale, :error_alerts_clock_fn),
      poll: Application.get_env(:cytale, :error_alerts_poll_ms),
      offset: Application.get_env(:cytale, :error_alerts_test_clock_offset_ms),
      base: Application.get_env(:cytale, :error_alerts_test_base),
      delivery: Application.get_env(:cytale, Delivery),
      operators: Application.get_env(:cytale, :operator_user_ids),
      observability: Application.get_env(:cytale, :observability)
    }

    # The injected clock: this test's base day + a test-owned offset.
    # Advancing the clock is one put_env — no sleeping, the backups
    # scheduler's own seam.
    base = test_base()
    Application.put_env(:cytale, :error_alerts_test_base, base)
    Application.put_env(:cytale, :error_alerts_test_clock_offset_ms, 0)

    Application.put_env(:cytale, :error_alerts_clock_fn, fn ->
      DateTime.add(base, clock_offset_ms(), :millisecond)
    end)

    Application.put_env(:cytale, :error_alerts_ledger_path, Path.join(tmp, "ledger.json"))
    Application.put_env(:cytale, :error_alerts_poll_ms, 10)
    Application.put_env(:cytale, Delivery, Delivery.Recorder)
    :ok = Delivery.Recorder.start()
    :ok = Metrics.init()
    if :ets.whereis(Metrics) != :undefined, do: :ets.delete_all_objects(Metrics)

    {:ok, admin} =
      User.create(
        "erradmin#{Cytale.TestNonce.get()}",
        "erradmin#{Cytale.TestNonce.get()}@example.com",
        "password-123"
      )

    Application.put_env(:cytale, :operator_user_ids, [admin.user_id])

    on_exit(fn ->
      restore(:error_alerts_ledger_path, prev.ledger)
      restore(:error_alerts_clock_fn, prev.clock)
      restore(:error_alerts_poll_ms, prev.poll)
      restore(:error_alerts_test_clock_offset_ms, prev.offset)
      restore(:error_alerts_test_base, prev.base)
      restore(:operator_user_ids, prev.operators)

      if prev.observability do
        Application.put_env(:cytale, :observability, prev.observability)
      else
        Application.delete_env(:cytale, :observability)
      end

      if prev.delivery do
        Application.put_env(:cytale, Delivery, prev.delivery)
      else
        Application.delete_env(:cytale, Delivery)
      end

      File.rm_rf!(tmp)
    end)

    %{admin: admin, tmp: tmp}
  end

  # -- helpers ---------------------------------------------------------------------

  defp rand_suffix, do: :crypto.strong_rand_bytes(8) |> Base.encode16(case: :lower)

  # nil restores as ABSENT: a key present with value nil defeats every
  # get_env/3 default downstream (observed cross-test, this suite).
  defp restore(_key, :bad), do: :ok
  defp restore(_key, nil), do: :ok
  defp restore(key, value), do: Application.put_env(:cytale, key, value)

  defp clock_offset_ms, do: Application.get_env(:cytale, :error_alerts_test_clock_offset_ms) || 0

  # This test's exclusive day: nonce-spaced (×3) so no other test's rows —
  # this run's OR a residue run's — can share a partition with it. Days
  # advance at most 2 within any single test (the 50h regression jump).
  defp test_base do
    slot = rem(String.to_integer(Cytale.TestNonce.get()), 300_000)
    ~U[2100-01-01 12:00:00.000Z] |> DateTime.add(slot * 3 * @day_ms, :millisecond)
  end

  defp now do
    base = Application.get_env(:cytale, :error_alerts_test_base)
    DateTime.add(base, clock_offset_ms(), :millisecond)
  end

  defp advance_ms(ms), do: Application.put_env(:cytale, :error_alerts_test_clock_offset_ms, ms)

  defp hours(h), do: h * 3_600_000

  @stack """
  TypeError: Cannot read properties of null (reading 'scrollTop')
      at MessageList.scrollToBottom (MessageList.tsx:87:9)
      at commitAttachRef (react-dom.development.js:123:4)
  """

  defp record_error(fingerprint, occurred_at, extra \\ []) do
    attrs =
      Map.merge(
        %{
          fingerprint: fingerprint,
          occurred_at: occurred_at,
          client: "web",
          source: "window.onerror",
          route: "/channels/9/messages",
          version: "1.4.2",
          message: "TypeError: Cannot read properties of null (reading 'scrollTop')",
          stack: @stack
        },
        Map.new(extra)
      )

    assert {:ok, _id} = ClientErrors.record(attrs)
  end

  # `n` occurrences of one fingerprint inside the CURRENT window.
  defp repeat_error(fingerprint, n, extra \\ []) do
    for i <- 1..n do
      record_error(fingerprint, DateTime.add(now(), -i, :hour), extra)
    end
  end

  defp alerts_for(fingerprint) do
    Delivery.Recorder.notifications()
    |> Enum.filter(&(&1.payload["fingerprint"] == fingerprint))
  end

  defp eventually(fun, tries \\ 250)

  defp eventually(_fun, 0), do: flunk("condition never became true")

  defp eventually(fun, tries) do
    if fun.(), do: :ok, else: Process.sleep(20) && eventually(fun, tries - 1)
  end

  # -- acceptance: exactly one DM per window -----------------------------------------

  test "threshold crossed inside a window produces EXACTLY ONE DM, and further passes stay silent" do
    repeat_error("fp-accept-1", 3)

    assert {:ok, summary} = ErrorAlerts.run()
    assert summary.result == :alert
    assert summary.dms == 1
    assert summary.fingerprints == ["fp-accept-1"]

    assert [dm] = alerts_for("fp-accept-1")
    assert dm.rule == :direct_message
    assert dm.verdict == :push
    assert dm.user_id != nil

    # The next pass — seconds later in the SAME window — is silence, not a
    # second copy: the ledger bucket has not moved.
    assert {:ok, summary2} = ErrorAlerts.run()
    assert summary2.dms == 0
    assert length(alerts_for("fp-accept-1")) == 1

    # And a running scheduler's ticks stay equally silent in this window.
    start_supervised!(Scheduler)
    Process.sleep(300)
    assert length(alerts_for("fp-accept-1")) == 1
    assert Metrics.snapshot().alert == 1
    assert Metrics.snapshot().dms == 1
  end

  # -- acceptance: second window → one more DM, distinct wording -----------------------

  test "a second window with continuing occurrences produces exactly one more DM, worded STILL" do
    repeat_error("fp-accept-2", 3)
    assert {:ok, _} = ErrorAlerts.run()

    # 25h later: a new window, new occurrences of the same bug.
    advance_ms(hours(25))
    repeat_error("fp-accept-2", 3)

    assert {:ok, summary} = ErrorAlerts.run()
    assert summary.dms == 1

    alerts = alerts_for("fp-accept-2")
    assert length(alerts) == 2

    second = alerts |> Enum.reverse() |> hd()
    assert second.payload["alert_kind"] == "still_broken"
    assert second.payload["content"] =~ "STILL repeating"

    # Not a flood: one more, and the window is quiet again.
    assert {:ok, %{dms: 0}} = ErrorAlerts.run()
    assert length(alerts_for("fp-accept-2")) == 2
  end

  test "a fingerprint gone quiet a FULL window and back alerts as a regression (RETURNED)" do
    repeat_error("fp-regress", 3)
    assert {:ok, _} = ErrorAlerts.run()

    # Two windows pass with NO occurrences (one quiet window, at least), then
    # the bug returns — #137's exact shape.
    advance_ms(hours(50))
    repeat_error("fp-regress", 3)

    assert {:ok, summary} = ErrorAlerts.run()
    assert summary.dms == 1

    second = alerts_for("fp-regress") |> Enum.reverse() |> hd()
    assert second.payload["alert_kind"] == "returned"
    assert second.payload["content"] =~ "RETURNED after going quiet (regression)"
  end

  # -- acceptance: below threshold → nothing -------------------------------------------

  test "a fingerprint below threshold produces nothing (positive control included)" do
    repeat_error("fp-quiet", 2)
    repeat_error("fp-loud", 3)

    assert {:ok, summary} = ErrorAlerts.run()
    assert summary.fingerprints == ["fp-loud"]
    assert alerts_for("fp-quiet") == []
    assert length(alerts_for("fp-loud")) == 1
  end

  # -- acceptance: the off switch silences; the store keeps recording --------------------

  test "disabling via config produces nothing, and the error store keeps recording" do
    Application.put_env(:cytale, :observability, error_alerts_enabled: false)
    repeat_error("fp-switch", 3)

    start_supervised!(Scheduler)

    # The off switch holds for ticks AND for an operator's run_now.
    assert {:error, :not_enabled} = Scheduler.run_now()
    Process.sleep(200)
    assert Delivery.Recorder.notifications() == []

    # The store never stopped being the source of truth (read through the
    # SAME injected clock the alerter aggregates with).
    grouped = ClientErrors.recent_grouped(days: 2, now: now())
    group = Enum.find(grouped.groups, &(&1.fingerprint == "fp-switch"))
    assert group.count == 3

    # Flipping the switch back is hot: the next pass sees the accumulated
    # occurrences and alerts once.
    Application.put_env(:cytale, :observability, error_alerts_enabled: true)
    assert :ok = Scheduler.run_now()

    eventually(fn -> length(alerts_for("fp-switch")) == 1 end)
  end

  # -- acceptance: the DM is actionable on its own ---------------------------------------

  test "the DM alone identifies the failing code path" do
    repeat_error("fp-actionable", 3)
    assert {:ok, _} = ErrorAlerts.run()

    assert [dm] = alerts_for("fp-actionable")
    payload = dm.payload
    content = payload["content"]

    assert content =~ "TypeError: Cannot read properties of null (reading 'scrollTop')"
    assert content =~ "fp-actionable"
    assert content =~ "last 24h"
    assert content =~ "count: 3"
    assert content =~ "/channels/9/messages"
    assert content =~ "window.onerror"
    assert content =~ "1.4.2"
    # The HEAD of the stack — the frame, not the message line above it.
    assert content =~ "at MessageList.scrollToBottom (MessageList.tsx:87:9)"
    refute content =~ "commitAttachRef"

    # The same facts ride as structured keys (a future surface renders them
    # without re-parsing prose).
    assert payload["fingerprint"] == "fp-actionable"
    assert payload["count"] == 3
    assert payload["count_truncated"] == false
    assert payload["window_hours"] == 24
    assert payload["route"] == "/channels/9/messages"
    assert payload["source"] == "window.onerror"
    assert payload["version"] == "1.4.2"
    assert payload["stack_head"] == "at MessageList.scrollToBottom (MessageList.tsx:87:9)"
    assert payload["alert_kind"] == "new"
  end

  # -- the edges the ticket names ---------------------------------------------------------

  test "no admin configured is silence, not error — and it is counted" do
    Application.put_env(:cytale, :operator_user_ids, [])
    repeat_error("fp-no-admin", 3)

    assert {:ok, summary} = ErrorAlerts.run()
    assert summary.result == :no_admin
    assert Delivery.Recorder.notifications() == []
    assert Metrics.snapshot().no_admin == 1

    # A stale non-integer id in the allowlist degrades to silence too.
    Application.put_env(:cytale, :operator_user_ids, ["not-a-snowflake"])
    assert {:ok, %{result: :no_admin}} = ErrorAlerts.run()
  end

  test "telemetry-shaped groups (no stack) never alert, however loud" do
    repeat_error("fp-telemetry", 5, source: "gateway.telemetry", stack: nil, message: nil)

    assert {:ok, summary} = ErrorAlerts.run()
    assert summary.result == :quiet
    assert Delivery.Recorder.notifications() == []
  end

  test "the per-pass cap bounds a storm and counts the tail" do
    for i <- 1..7 do
      repeat_error("fp-storm-#{i}", 3)
    end

    assert {:ok, summary} = ErrorAlerts.run()
    assert summary.dms == 5
    assert summary.suppressed == 2
    assert length(Delivery.Recorder.notifications()) == 5

    # The cap is per PASS, not per lifetime: the tail speaks next window.
    advance_ms(hours(25))

    for i <- 1..7 do
      repeat_error("fp-storm-#{i}", 3)
    end

    assert {:ok, summary2} = ErrorAlerts.run()
    assert summary2.dms == 5
    assert summary2.suppressed == 2
  end

  test "a muted admin is not nagged — policy and preferences apply for free" do
    :ok = Preferences.set_level(context_admin_id(), :account, 0, "mute")
    repeat_error("fp-muted-admin", 3)

    assert {:ok, summary} = ErrorAlerts.run()
    assert summary.dms == 0
    assert Delivery.Recorder.notifications() == []
  end

  defp context_admin_id do
    Application.get_env(:cytale, :operator_user_ids) |> hd()
  end

  # -- scheduler mechanics: injected clock, ledger, restart silence --------------------

  test "the injected clock alone drives the cadence (catch-up within one poll)" do
    repeat_error("fp-clock", 3)

    # The anchor says this window already had its pass: ticks stay quiet.
    ledger = %{last_run_at: now(), alerts: %{}}
    Ledger.save(ledger, Ledger.bucket(now(), 24))
    start_supervised!(Scheduler)
    Process.sleep(300)
    assert Delivery.Recorder.notifications() == []

    # The clock moves past the interval AND the window: the next poll catches
    # up — no restart, no run_now. (The fresh occurrences are written into
    # the NEXT partition BEFORE the clock moves: a poll firing mid-write
    # would be an honest quiet pass, advancing the anchor and starving this
    # test of its alert. Units stay explicit: DateTime.add defaults to
    # seconds, and a bare ms amount is a thousand-day typo.)
    for i <- 1..3 do
      record_error("fp-clock", DateTime.add(now(), hours(25) - i * hours(1), :millisecond))
    end

    advance_ms(hours(25))

    eventually(fn -> length(alerts_for("fp-clock")) == 1 end)
    assert Metrics.snapshot().alert == 1
  end

  test "restart silence: a persisted ledger keeps a redeploy quiet" do
    repeat_error("fp-restart", 3)
    assert {:ok, _} = ErrorAlerts.run()
    assert length(alerts_for("fp-restart")) == 1

    # The ledger is on disk; a "restart" (a fresh scheduler over the same
    # file) may not re-alert: the act of deploying must not DM the admin.
    start_supervised!(Scheduler)
    Process.sleep(200)

    # A FORCED pass after the restart runs — and lands quiet, because every
    # candidate's ledger bucket is still the current one.
    quiet_before = Metrics.snapshot().quiet
    assert :ok = Scheduler.run_now()
    eventually(fn -> Metrics.snapshot().quiet > quiet_before end)
    assert length(alerts_for("fp-restart")) == 1
  end

  # -- the families are scrapeable -------------------------------------------------------

  test "the outcome families land on the metrics exposition" do
    repeat_error("fp-metrics", 3)
    assert {:ok, _} = ErrorAlerts.run()

    exposition = Metrics.exposition()
    assert exposition =~ ~s(cytale_error_alerts_total{result="alert"} 1)
    assert exposition =~ ~r/cytale_error_alerts_total\{result="quiet"\} \d+/
    assert exposition =~ "cytale_error_alerts_dm_total 1"
    assert exposition =~ ~r/cytale_error_alerts_last_run_timestamp_seconds \d{10}/
  end
end
