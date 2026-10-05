defmodule Cytale.Observability.ErrorAlerts do
  @moduledoc """
  The client-error recurrence alerter (#138): one pass that reads the error
  store, decides which fingerprints have earned a DM, and tells the server's
  admin — at most once per fingerprint per window.

  This module is the PASS (pure-ish, synchronous, directly testable);
  `Cytale.Observability.ErrorAlerts.Scheduler` is the OTP cron that runs it on
  the configured cadence, and `Ledger`/`Metrics` are its memory and its
  conscience.

  ## The pass

    1. Aggregate `Cytale.Observability.ClientErrors.recent_grouped/1` over
       `observability.error_alert_window_hours` (default 24h — read at the
       store's day-partition granularity).
    2. Keep only ALERT-WORTHY groups: `count >= threshold` AND carrying a
       stack. The stack guard is a finding from the ticket, not decoration:
       in the 7-day window the loudest groups were `gateway.telemetry`
       COUNTERS with no stack — a count-only rule would have alerted about
       telemetry on day one and never about a real crash. Only a group with a
       stack can satisfy "the DM alone identifies the failing code path".
    3. Dedupe through `ErrorAlerts.Ledger` (one entry per fingerprint, the
       last-alerted window bucket): `:already_alerted` is silence, a one-bucket
       gap is "still broken", a multi-bucket gap is "returned after going
       quiet" — the regression wording, distinct on purpose.
    4. Render and deliver each alert through the EXISTING notifications
       pipeline — `Policy.decide/3` with `kind: :dm` (a DM is addressed by
       construction, so preferences may mute it but never demote it) and the
       pluggable `Delivery` implementation — addressed to the operator
       allowlist (`operator_user_ids`, `CYTALE_ADMIN_USER_IDS`). NO admin
       configured is silence, not error (but it is COUNTED — see Metrics).
    5. Update the ledger, record the outcome on Metrics + the log. A raised
       pass is the CALLER's failure to record ("failure is never silent").

  ## Deliberate departures from the fan-out path, and why

    * NO focus check: `Dispatcher` withholds when the recipient is looking at
      the app, because the member is already seeing the message. An admin
      looking at the app is NOT already seeing a crash report — there is no
      in-app surface for one — so withholding would be losing the alert.
    * `Delivery.impl().deliver/1` is called DIRECTLY, not through
      `Delivery.deliver/1`: that wrapper deliberately rescues everything
      (correct for mentions — a lost notification is recoverable), which is
      exactly what an alerting path cannot afford. The rescue lives HERE
      instead, where the outcome is counted and logged.
    * The Focus/dispatcher audience machinery (membership, live sessions,
      participation) is message-fan-out vocabulary; the alert's audience is
      the operator allowlist, resolved per pass.

  ## The rate cap

  A bad build can mint many new fingerprints at once. At most
  `@max_alerts_per_run` DMs go out per pass — the loudest groups first (the
  aggregation already sorts by count DESC) — and the remainder is counted in
  the summary (`:suppressed`) and logged, never silently dropped.
  """

  require Logger

  alias Cytale.Notifications.{Delivery, Policy, Preferences}
  alias Cytale.Observability.ClientErrors
  alias Cytale.Observability.ErrorAlerts.{Ledger, Metrics}
  alias Cytale.ServerConfig

  # The per-pass DM cap: the loudest fingerprints speak, the tail is counted.
  @max_alerts_per_run 5

  # The stack head is the identifying line; anything longer stops being one.
  @max_stack_head 200

  @typedoc "One alert's alert_kind — the ledger's gap, made a word."
  @type alert_kind :: :new | :still_broken | :returned

  @typedoc "What one pass did."
  @type summary :: %{
          result: :alert | :quiet | :no_admin,
          dms: non_neg_integer(),
          fingerprints: [String.t()],
          suppressed: non_neg_integer(),
          truncated: boolean(),
          window_hours: pos_integer(),
          threshold: pos_integer()
        }

  # -- The pass -------------------------------------------------------------------

  @doc """
  Run one pass NOW. Raises on storage failure — the scheduler's task owns the
  rescue, so a Scylla hiccup lands as a counted, logged failure and the next
  tick retries; it never crash-loops the tree. The enabled switch is the
  SCHEDULER's gate; this function is the capability itself.
  """
  @spec run() :: {:ok, summary()}
  def run do
    clock = now()
    window_hours = ServerConfig.error_alert_window_hours()
    threshold = ServerConfig.error_alert_threshold()
    ledger = Ledger.load()
    bucket = Ledger.bucket(clock, window_hours)

    grouped =
      ClientErrors.recent_grouped(
        days: days_for_window(window_hours),
        now: clock
      )

    # Dedupe BEFORE the cap: the cap bounds what actually SPEAKS this pass,
    # so an already-alerted fingerprint must not spend a slot. What the cap
    # cuts is counted, never dropped silently.
    candidates =
      grouped.groups
      |> Enum.filter(&alertworthy?(&1, threshold))
      |> Enum.filter(fn group ->
        Ledger.decide(ledger, group.fingerprint, bucket) != :already_alerted
      end)

    to_alert = Enum.take(candidates, @max_alerts_per_run)
    suppressed = max(0, length(candidates) - length(to_alert))

    {result, dms, new_entries} =
      cond do
        admins() == [] ->
          Logger.warning(
            "error alerts: #{length(to_alert)} fingerprint(s) earned a DM but NO operator is " <>
              "configured (operator_user_ids / CYTALE_ADMIN_USER_IDS) — silenced, not sent"
          )

          {:no_admin, 0, %{}}

        to_alert == [] ->
          {:quiet, 0, %{}}

        true ->
          {dms, entries} =
            deliver_all(to_alert, ledger, bucket, clock, window_hours, grouped.truncated)

          {if(dms > 0, do: :alert, else: :quiet), dms, entries}
      end

    Metrics.record(result, dms)

    # The ledger write (new alert anchors + the due anchor) happens on EVERY
    # completed pass — quiet included: last_run_at must advance when the pass
    # SUCCEEDED, which is what makes a failed pass retry on the next tick
    # instead of waiting out the interval. The alert anchors are what dedupe
    # every pass after an alert into silence for the rest of the window.
    Ledger.save(
      %{ledger | last_run_at: clock, alerts: Map.merge(ledger.alerts, new_entries)},
      bucket
    )

    {:ok,
     %{
       result: result,
       dms: dms,
       fingerprints: Enum.map(to_alert, & &1.fingerprint),
       suppressed: suppressed,
       truncated: grouped.truncated,
       window_hours: window_hours,
       threshold: threshold
     }}
  end

  # -- Delivery -------------------------------------------------------------------

  defp deliver_all(groups, ledger, bucket, clock, window_hours, truncated?) do
    admins = admins()

    groups
    |> Enum.map(fn group ->
      kind =
        case Ledger.decide(ledger, group.fingerprint, bucket) do
          {:alert, kind} -> kind
          :already_alerted -> :new
        end

      notification =
        render(group,
          window_hours: window_hours,
          truncated: truncated?,
          alert_kind: kind,
          at: clock
        )

      dms = send_dm(admins, notification)

      entry = %{
        bucket: bucket,
        alerted_at: clock,
        count: group.count,
        kind: kind
      }

      {dms, {group.fingerprint, entry}}
    end)
    |> Enum.reduce({0, %{}}, fn {dms, {fp, entry}}, {total, entries} ->
      {total + length(dms), Map.put(entries, fp, entry)}
    end)
  end

  # The notifications pipeline, addressed to the operators. Each admin gets
  # their OWN policy decision — an admin who muted operational DMs (or all
  # of them) is not nagged, which is the "policy and preferences apply for
  # free" half of the ticket. The Focus check is deliberately absent (see
  # the moduledoc).
  defp send_dm(admins, notification) do
    notifications =
      for admin_id <- admins,
          resolved =
            Policy.decide(
              %{kind: :dm, author_id: nil, content: notification.content},
              admin_id,
              preferences: Preferences.all(admin_id)
            ),
          resolved.verdict == :push do
        %{
          user_id: admin_id,
          verdict: :push,
          rule: resolved.rule,
          level: resolved.level,
          decided_by: resolved.decided_by,
          event_name: "ClientErrorAlert",
          payload: notification.payload
        }
      end

    case notifications do
      [] ->
        Logger.info("error alerts: every configured operator withheld the alert (preferences)")
        []

      dms ->
        # DIRECT impl call — Delivery.deliver/1's blanket rescue is the fan-out's
        # correct failure direction and the alerting path's wrong one (the ticket's
        # finding). Anything the impl raises lands in run/0's caller, counted.
        Delivery.impl().deliver(dms)
        dms
    end
  end

  @doc """
  The operator allowlist, normalized to integer ids. Reads the SAME storage
  `CytaleWeb.Plugs.RequireOperator` gates the admin tier with
  (`operator_user_ids` — env `CYTALE_ADMIN_USER_IDS` seeds it, the config file
  hot-applies it), so "the server admin" is whoever can already reach
  /api/v1/admin, including the operators the environment adds (#170). Empty =
  no admin configured = silence.
  """
  @spec admins() :: [integer()]
  def admins do
    (List.wrap(Application.get_env(:cytale, :operator_user_ids, [])) ++
       List.wrap(Application.get_env(:cytale, :env_operator_user_ids, [])))
    |> Enum.map(fn
      id when is_integer(id) ->
        id

      id when is_binary(id) ->
        case Integer.parse(String.trim(id)) do
          {int, ""} -> int
          _ -> nil
        end

      _ ->
        nil
    end)
    |> Enum.reject(&is_nil/1)
    |> Enum.uniq()
  end

  # -- Rendering ------------------------------------------------------------------

  @typedoc "The rendered alert: the human text plus the structured payload."
  @type rendered :: %{
          content: String.t(),
          payload: %{optional(String.t()) => term()}
        }

  @doc """
  Render ONE fingerprint's DM. Everything the ticket names is here — message,
  fingerprint, count (honest about truncation: "≥N", never a precise-looking
  number the store cannot back), window, version, route, source, and the HEAD
  of the stack — in the human `content` AND as structured payload keys, so a
  future surface can render it without re-parsing prose.

  `:alert_kind` picks the wording: `:new` ("is repeating"), `:still_broken`
  ("STILL repeating" — the once-per-window nag), `:returned` ("RETURNED after
  going quiet" — a regression, the #137 signal).
  """
  @spec render(ClientErrors.group(), keyword()) :: rendered()
  def render(group, opts) do
    window_hours = Keyword.fetch!(opts, :window_hours)
    truncated? = Keyword.get(opts, :truncated, false)
    kind = Keyword.get(opts, :alert_kind, :new)
    at = Keyword.get(opts, :at) || now()
    example = group.example

    head = stack_head(example.stack, example.message)
    count_text = if truncated?, do: ">=#{group.count} (store truncated — approximate)", else: "#{group.count}"

    content = """
    #{headline(kind)} in the last #{window_hours}h — #{example.message || "client error"}

    count: #{count_text}
    fingerprint: #{group.fingerprint}
    route: #{example.route || "unknown"}
    source: #{example.source || "unknown"}#{client_text(example.client)}
    version: #{example.version || "unknown"}
    stack head: #{head || "(none retained)"}\
    """

    content = String.trim_trailing(content)

    payload = %{
      "content" => content,
      "workspace_id" => nil,
      "channel_id" => nil,
      "thread_id" => nil,
      "author_id" => nil,
      "alert" => "client_error_repeats",
      "fingerprint" => group.fingerprint,
      "count" => group.count,
      "count_truncated" => truncated?,
      "window_hours" => window_hours,
      "route" => example.route,
      "source" => example.source,
      "client" => example.client,
      "version" => example.version,
      "message" => example.message,
      "stack_head" => head,
      "last_seen_at" => example.occurred_at && DateTime.to_iso8601(example.occurred_at),
      "alert_kind" => Atom.to_string(kind),
      "alerted_at" => DateTime.to_iso8601(at)
    }

    %{content: content, payload: payload}
  end

  defp headline(:new), do: "Client error is repeating"
  defp headline(:still_broken), do: "Client error STILL repeating"
  defp headline(:returned), do: "Client error RETURNED after going quiet (regression)"

  defp client_text(nil), do: ""
  defp client_text(client), do: " (#{client})"

  @doc """
  The stack's identifying line: the first frame, skipping a first line that
  merely repeats the error message (JS stacks lead with "TypeError: …"; the
  FRAME below it is what names the code path). Bounded, blank-free, nil-safe.
  """
  @spec stack_head(String.t() | nil, String.t() | nil) :: String.t() | nil
  def stack_head(stack, message \\ nil)

  def stack_head(stack, message) when is_binary(stack) do
    lines =
      stack
      |> String.split(["\r\n", "\n"])
      |> Enum.map(&String.trim/1)
      |> Enum.reject(&(&1 == ""))

    case lines do
      [] ->
        nil

      [only] ->
        clip(only)

      [first | rest] ->
        cond do
          is_binary(message) and message != "" and String.contains?(first, message) and rest != [] ->
            clip(hd(rest))

          true ->
            clip(first)
        end
    end
  end

  def stack_head(_stack, _message), do: nil

  defp clip(nil), do: nil

  defp clip(line) when is_binary(line) do
    if String.length(line) > @max_stack_head do
      String.slice(line, 0, @max_stack_head) <> "…"
    else
      line
    end
  end

  # -- Internals -------------------------------------------------------------------

  # Alert-worthy: past threshold AND carrying a stack (see the moduledoc —
  # the telemetry-counter finding). One predicate, stated once.
  defp alertworthy?(group, threshold) do
    group.count >= threshold and is_binary(group.example.stack) and group.example.stack != ""
  end

  # The window is read at the store's day-partition granularity: the smallest
  # partition count that covers the window. A 24h window walks today's
  # partition (plus nothing older); 25h walks two. Over-covering risks one
  # early alert (the ledger dedupes); under-covering risks never alerting at
  # all — so it always rounds UP.
  defp days_for_window(window_hours) when is_integer(window_hours) and window_hours >= 1 do
    div(window_hours + 23, 24)
  end

  # Injectable clock: tests freeze or skew time without sleeping (the backups
  # scheduler's own seam, same name).
  defp now do
    case Application.get_env(:cytale, :error_alerts_clock_fn) do
      fun when is_function(fun, 0) -> fun.()
      _ -> DateTime.utc_now()
    end
  end
end
