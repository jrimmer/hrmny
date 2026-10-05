defmodule Cytale.Observability.ErrorAlerts.LedgerTest do
  @moduledoc """
  #138 — the ledger's pure and file-level behavior, without a database:

    * window bucketing (floor-to-the-grid, the dedupe's foundation);
    * the decision table: new / already-alerted / still-broken / returned;
    * save + load round-trip, and ANY corruption reads as fresh (loud, never
      a crash);
    * the prune bound (old entries go, recent history stays);
    * the stack-head rule: the FRAME identifies the code path, the message
      line above it does not.
  """

  use ExUnit.Case, async: false

  alias Cytale.Observability.ErrorAlerts
  alias Cytale.Observability.ErrorAlerts.Ledger

  @window 24

  setup do
    tmp =
      Path.join(System.tmp_dir!(), "cytale_err_ledger_#{:crypto.strong_rand_bytes(8) |> Base.encode16(case: :lower)}")

    File.mkdir_p!(tmp)
    Application.put_env(:cytale, :error_alerts_ledger_path, Path.join(tmp, "ledger.json"))

    on_exit(fn ->
      Application.delete_env(:cytale, :error_alerts_ledger_path)
      File.rm_rf!(tmp)
    end)

    %{tmp: tmp}
  end

  # -- bucketing -----------------------------------------------------------------

  test "bucket/2 floors unix time by the window length" do
    t = ~U[2026-09-18 12:00:00.000Z]
    day_ms = 86_400_000

    # A 24h window's buckets ARE the UTC day partitions (epoch-aligned).
    assert Ledger.bucket(t, 24) == div(DateTime.to_unix(t, :millisecond), day_ms)
    # Within the same day, every moment shares the bucket.
    assert Ledger.bucket(DateTime.add(t, 11, :hour), 24) == Ledger.bucket(t, 24)
    # Past midnight the bucket moves — exactly once per window.
    assert Ledger.bucket(DateTime.add(t, 13, :hour), 24) == Ledger.bucket(t, 24) + 1

    # A 1-hour window buckets hourly.
    assert Ledger.bucket(t, 1) == div(DateTime.to_unix(t, :millisecond), 3_600_000)
    assert Ledger.bucket(DateTime.add(t, 59, :minute), 1) == Ledger.bucket(t, 1)
    assert Ledger.bucket(DateTime.add(t, 61, :minute), 1) == Ledger.bucket(t, 1) + 1
  end

  # -- the decision table ----------------------------------------------------------

  test "decide/3: new, already-alerted, still-broken and returned, in one table" do
    b = 900

    ledger = %{
      last_run_at: nil,
      alerts: %{
        "steady" => %{bucket: b, alerted_at: DateTime.utc_now(), count: 3, kind: :new},
        "returned" => %{bucket: b - 2, alerted_at: DateTime.utc_now(), count: 3, kind: :new}
      }
    }

    assert {:alert, :new} = Ledger.decide(ledger, "fresh", b)
    assert :already_alerted = Ledger.decide(ledger, "steady", b)
    assert {:alert, :still_broken} = Ledger.decide(ledger, "steady", b + 1)
    assert {:alert, :returned} = Ledger.decide(ledger, "returned", b + 1)
  end

  # -- the file ----------------------------------------------------------------------

  test "save + load round-trips the anchors and the entries" do
    t = ~U[2026-09-18 12:00:00.000Z]
    bucket = Ledger.bucket(t, @window)

    ledger = %{
      last_run_at: t,
      alerts: %{
        "fp-a" => %{bucket: bucket, alerted_at: t, count: 3, kind: :still_broken}
      }
    }

    :ok = Ledger.save(ledger, bucket)

    loaded = Ledger.load()
    assert loaded.last_run_at == t
    assert loaded.alerts["fp-a"].bucket == bucket
    assert loaded.alerts["fp-a"].count == 3
    assert loaded.alerts["fp-a"].kind == :still_broken
  end

  test "any unreadable file reads as a FRESH ledger, never a crash" do
    File.write!(Ledger.path(), "this is not json {")
    assert %{last_run_at: nil, alerts: alerts} = Ledger.load()
    assert alerts == %{}

    File.write!(Ledger.path(), Jason.encode!(%{"version" => 99, "alerts" => []}))
    assert %{last_run_at: nil, alerts: %{}} = Ledger.load()
  end

  test "an absent file is a fresh ledger (a first install answers honestly)" do
    assert %{last_run_at: nil, alerts: %{}} = Ledger.load()
  end

  test "save prunes entries older than the keep bound and keeps recent history" do
    t = ~U[2026-09-18 12:00:00.000Z]
    now_bucket = 1_000

    ledger = %{
      last_run_at: t,
      alerts: %{
        "ancient" => %{bucket: 1, alerted_at: t, count: 9, kind: :new},
        "recent" => %{bucket: now_bucket - 5, alerted_at: t, count: 3, kind: :returned}
      }
    }

    :ok = Ledger.save(ledger, now_bucket)

    loaded = Ledger.load()
    assert loaded.alerts["ancient"] == nil
    assert loaded.alerts["recent"].bucket == now_bucket - 5
  end

  # -- the stack head ------------------------------------------------------------

  @message "TypeError: Cannot read properties of null (reading 'scrollTop')"

  @stack """
  #{@message}
      at MessageList.scrollToBottom (MessageList.tsx:87:9)
      at commitAttachRef (react-dom.development.js:123:4)
  """

  test "stack_head returns the first FRAME, skipping the message line" do
    assert ErrorAlerts.stack_head(@stack, @message) ==
             "at MessageList.scrollToBottom (MessageList.tsx:87:9)"
  end

  test "stack_head keeps a stack whose first line is already the frame" do
    stack = "at rawFrame (app.js:1:1)\nat second (app.js:2:1)"
    assert ErrorAlerts.stack_head(stack, "some other message") == "at rawFrame (app.js:1:1)"
  end

  test "stack_head degrades: single line, no stack at all, blank lines" do
    assert ErrorAlerts.stack_head("only a message line", @message) == "only a message line"
    assert ErrorAlerts.stack_head(nil, @message) == nil
    assert ErrorAlerts.stack_head("\n\n  \n", @message) == nil
  end

  test "stack_head clips absurd lines" do
    long = "at " <> String.duplicate("x", 500) <> " (boom.js:1:1)"
    head = ErrorAlerts.stack_head(long, nil)
    assert String.length(head) <= 201
    assert String.ends_with?(head, "…")
  end

  # -- the admins resolution --------------------------------------------------------

  test "admins/0 normalizes ints and decimal strings, drops garbage, dedupes" do
    prev = Application.get_env(:cytale, :operator_user_ids)

    on_exit(fn ->
      if prev do
        Application.put_env(:cytale, :operator_user_ids, prev)
      else
        Application.delete_env(:cytale, :operator_user_ids)
      end
    end)

    Application.put_env(:cytale, :operator_user_ids, [42, "1042", "not-a-snowflake", 42, nil])
    assert ErrorAlerts.admins() == [42, 1042]

    Application.put_env(:cytale, :operator_user_ids, [])
    assert ErrorAlerts.admins() == []

    Application.delete_env(:cytale, :operator_user_ids)
    assert ErrorAlerts.admins() == []
  end

  # -- the render's truncation honesty ------------------------------------------------

  test "a truncated store renders an HONEST count (≥N), never a precise-looking one" do
    group = %{
      fingerprint: "fp-trunc",
      count: 200,
      last_seen_at: DateTime.utc_now(),
      example: %{
        report_id: 1,
        account_id: nil,
        fingerprint: "fp-trunc",
        client: "web",
        source: "window.onerror",
        route: "/x",
        version: "1.4.2",
        message: @message,
        stack: @stack,
        status: nil,
        request_id: nil,
        detail: nil,
        occurred_at: DateTime.utc_now()
      }
    }

    rendered = ErrorAlerts.render(group, window_hours: 24, truncated: true, alert_kind: :new)

    assert rendered.payload["content"] =~ ">=200 (store truncated — approximate)"
    assert rendered.payload["count_truncated"] == true

    plain = ErrorAlerts.render(group, window_hours: 24, truncated: false, alert_kind: :new)
    assert plain.payload["content"] =~ "count: 200\n"
  end

  test "render wordings are distinct per alert_kind" do
    group = %{
      fingerprint: "fp-word",
      count: 3,
      last_seen_at: DateTime.utc_now(),
      example: %{
        report_id: 1,
        account_id: nil,
        fingerprint: "fp-word",
        client: nil,
        source: nil,
        route: nil,
        version: nil,
        message: "boom",
        stack: "at x (y:1)",
        status: nil,
        request_id: nil,
        detail: nil,
        occurred_at: DateTime.utc_now()
      }
    }

    new = ErrorAlerts.render(group, window_hours: 24, alert_kind: :new)
    still = ErrorAlerts.render(group, window_hours: 24, alert_kind: :still_broken)
    returned = ErrorAlerts.render(group, window_hours: 24, alert_kind: :returned)

    assert new.content =~ "Client error is repeating"
    assert still.content =~ "Client error STILL repeating"
    assert returned.content =~ "Client error RETURNED after going quiet (regression)"

    # Degrades to "unknown", never to a crash, when the example is sparse.
    assert new.content =~ "route: unknown"
    assert new.content =~ "stack head: at x (y:1)"
  end
end
