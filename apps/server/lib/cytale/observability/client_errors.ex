defmodule Cytale.Observability.ClientErrors do
  @moduledoc """
  The client-error sink (#88): the storage behind `POST /api/v1/client-errors`
  and the operator read behind `GET /api/v1/admin/client-errors`.

  ## Why ScyllaDB alone

  This is the repo's established call for low-volume append-only events — the
  same conclusion the audit-trail discussion reached. A handful of reports per
  client per day does not justify a second datastore: no ClickHouse, no vendor
  collector, no analytics pipeline. One table, day-partitioned, TTL'd, read by
  an operator route. The privacy decision therefore lives in this repository
  (`priv/scylla_schema.cql`) instead of in someone else's retention policy.

  ## The write is content-blind BY CONSTRUCTION

  `record/1` names its columns EXPLICITLY in the INSERT statement. A payload
  carrying a `body`, `headers` or `message_content` key cannot reach a column
  even if a future client sends one: the key is never read. That is the server
  half of the ticket's no-message-content guarantee — the client half is
  `ClientErrorPayload`'s field set in `@cytale/api-client`.

  ## Retention

  30 days, enforced by the row's own TTL (`USING TTL`), the same writer-side
  convention every other TTL'd table in this repo uses. Restated for an
  operator in `docs/protocol/rest.md`.

  ## Reads

  `recent_grouped/1` walks the last N day partitions newest-first, reads a
  bounded number of rows from each, and groups in Elixir by fingerprint. There
  is no grouping engine, no dashboard and no alerting — those are explicitly
  out of scope for v1, and a "top errors this week" list is what the operator
  route returns.

  All queries use typed Xandra param tuples (`{"int", ...}`, `{"bigint", ...}`,
  `{"text", ...}`, `{"timestamp", ...}`) — bare values raise FunctionClauseError
  in Xandra 0.20.
  """

  alias Cytale.{Repo, Snowflake}

  # The retention bound, in days. Stated once, used for the TTL on every write.
  @retention_days 30
  @retention_ms @retention_days * 24 * 60 * 60 * 1000
  @ms_per_day 86_400_000

  # Server-side truncation backstops. The client already truncates (500 / 4000
  # chars), but a non-first-party client is not obliged to, and an unbounded
  # text column fed by the open internet is how a diagnosis table becomes a
  # liability.
  @max_message 1_000
  @max_stack 8_000
  @max_route 500
  @max_detail 500
  @max_short 64

  # The row's column set — the allowlist the INSERT statement names literally,
  # and the ONLY keys `record/1` reads. Anything else a caller hands in is
  # ignored rather than stored.
  @columns ~w(
    day report_id account_id fingerprint client source route version message stack
    status request_id detail occurred_at
  )a

  @clients ~w(web desktop mobile)
  @sources ~w(window.onerror unhandledrejection error-boundary api.request gateway.telemetry)

  @doc "The retention an operator reads, in days."
  @spec retention_days() :: pos_integer()
  def retention_days, do: @retention_days

  @doc "The capture points this sink accepts; anything else is refused."
  @spec sources() :: [String.t()]
  def sources, do: @sources

  @doc "The client kinds this sink accepts; anything else is refused."
  @spec clients() :: [String.t()]
  def clients, do: @clients

  @typedoc "One stored report, as returned by the read side."
  @type report :: %{
          report_id: integer(),
          account_id: integer() | nil,
          fingerprint: String.t(),
          client: String.t() | nil,
          source: String.t() | nil,
          route: String.t() | nil,
          version: String.t() | nil,
          message: String.t() | nil,
          stack: String.t() | nil,
          status: integer() | nil,
          request_id: String.t() | nil,
          detail: String.t() | nil,
          occurred_at: DateTime.t() | nil
        }

  @typedoc "One fingerprint's rollup: how often, and the newest example of it."
  @type group :: %{
          fingerprint: String.t(),
          count: non_neg_integer(),
          last_seen_at: DateTime.t() | nil,
          example: report()
        }

  # ---------------------------------------------------------------------------
  # Write
  # ---------------------------------------------------------------------------

  @doc """
  Store one report. `attrs` is the validated payload map from the controller;
  unknown keys are IGNORED (see the moduledoc).

  `:account_id` is the caller's snowflake, or nil for an anonymous report — the
  distinction the ticket asks for, and the one that makes a login-page crash
  storable at all. `:occurred_at` defaults to now (the SERVER's clock: a
  client's clock can be wrong, and the day partition must agree with the
  timestamp it is derived from).

  Returns the stored report's snowflake, or `{:error, reason}` — the caller
  decides how loud a storage failure is (the ingest route stays a 204).
  """
  @spec record(map(), keyword()) :: {:ok, integer()} | {:error, term()}
  def record(attrs, _opts \\ []) when is_map(attrs) do
    occurred_at = Map.get(attrs, :occurred_at) || DateTime.utc_now()
    report_id = Snowflake.next()
    day = day_of(occurred_at)

    params = [
      {"int", day},
      {"bigint", report_id},
      {"bigint", Map.get(attrs, :account_id)},
      {"text", text(attrs[:fingerprint], @max_short)},
      {"text", text(attrs[:client], @max_short)},
      {"text", text(attrs[:source], @max_short)},
      {"text", text(attrs[:route], @max_route)},
      {"text", text(attrs[:version], @max_short)},
      {"text", text(attrs[:message], @max_message)},
      {"text", text(attrs[:stack], @max_stack)},
      {"int", integer_or_nil(attrs[:status])},
      {"text", text(attrs[:request_id], 128)},
      {"text", text(attrs[:detail], @max_detail)},
      {"timestamp", occurred_at},
      {"int", ttl_seconds()}
    ]

    case Repo.execute(insert_statement(), params) do
      {:ok, _result} -> {:ok, report_id}
      {:error, reason} -> {:error, reason}
    end
  end

  # The insert names its columns EXPLICITLY — this is the allowlist made
  # literal, and the reason a content-bearing key in the payload has nowhere
  # to go.
  defp insert_statement do
    """
    INSERT INTO {{K}}.client_errors
      (day, report_id, account_id, fingerprint, client, source, route, version, message, stack, status, request_id, detail, occurred_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) USING TTL ?
    """
  end

  @doc "The columns a stored report can occupy (the write allowlist, literally)."
  @spec columns() :: [atom()]
  def columns, do: @columns

  # ---------------------------------------------------------------------------
  # Read (operator surface)
  # ---------------------------------------------------------------------------

  @doc """
  The last N reports, grouped by fingerprint.

  Walks `:days` day partitions (default 3) newest-first and reads at most
  `:per_day_limit` rows (default 200) from each, then groups in Elixir. Groups
  are ordered by count DESC then newest-first, and capped at `:groups`
  (default 50). `truncated` says whether any day partition filled its read
  budget — the honest signal that "what I see" is not "all there was".
  """
  @spec recent_grouped(keyword()) :: %{
          days: pos_integer(),
          groups: [group()],
          reports: non_neg_integer(),
          truncated: boolean()
        }
  def recent_grouped(opts \\ []) do
    days = Keyword.get(opts, :days, 3)
    per_day_limit = Keyword.get(opts, :per_day_limit, 200)
    max_groups = Keyword.get(opts, :groups, 50)
    today = opts |> Keyword.get(:now, DateTime.utc_now()) |> day_of()

    {rows, truncated?} =
      0..(days - 1)
      |> Enum.reduce({[], false}, fn offset, {acc, truncated} ->
        {day_rows, day_truncated} = rows_for_day(today - offset, per_day_limit)
        {acc ++ day_rows, truncated or day_truncated}
      end)

    groups =
      rows
      |> Enum.group_by(& &1.fingerprint)
      |> Enum.map(fn {fingerprint, grouped} ->
        # Newest first inside a fingerprint: the partitions are walked
        # newest-first and each day's rows arrive DESC, so the head is the most
        # recent example of this bug.
        %{
          fingerprint: fingerprint,
          count: length(grouped),
          last_seen_at: grouped |> List.first() |> Map.get(:occurred_at),
          example: List.first(grouped)
        }
      end)
      |> Enum.sort_by(&{&1.count, &1.last_seen_at}, :desc)
      |> Enum.take(max_groups)

    %{days: days, groups: groups, reports: length(rows), truncated: truncated?}
  end

  defp rows_for_day(day, limit) do
    statement =
      """
      SELECT report_id, account_id, fingerprint, client, source, route, version, message, stack, status, request_id, detail, occurred_at
      FROM {{K}}.client_errors WHERE day = ? LIMIT #{limit}
      """

    rows =
      Repo.execute!(statement, [{"int", day}])
      |> Enum.map(&to_report/1)

    # A full read budget is reported, not silently treated as the whole day.
    {rows, length(rows) >= limit}
  end

  # ---------------------------------------------------------------------------
  # Helpers
  # ---------------------------------------------------------------------------

  @doc """
  The day partition for a timestamp: floor(unix_ms / 86_400_000). Exposed so
  the read side and the tests derive the partition the same way the writer did.
  """
  @spec day_of(DateTime.t() | integer()) :: integer()
  def day_of(%DateTime{} = at), do: day_of(DateTime.to_unix(at, :millisecond))
  def day_of(ms) when is_integer(ms), do: div(ms, @ms_per_day)

  defp ttl_seconds, do: div(@retention_ms, 1000)

  # Bounded text: nil stays nil (absent, not empty), a non-binary is dropped
  # rather than inspected — a Map or a struct reaching a text column is a bug
  # upstream, not a value to store.
  defp text(nil, _max), do: nil
  defp text(value, max) when is_binary(value), do: binary_part(value, 0, min(byte_size(value), max))
  defp text(_other, _max), do: nil

  defp integer_or_nil(nil), do: nil
  defp integer_or_nil(value) when is_integer(value), do: value
  defp integer_or_nil(_other), do: nil

  defp to_report(row) do
    %{
      report_id: row["report_id"],
      account_id: row["account_id"],
      fingerprint: row["fingerprint"],
      client: row["client"],
      source: row["source"],
      route: row["route"],
      version: row["version"],
      message: row["message"],
      stack: row["stack"],
      status: row["status"],
      request_id: row["request_id"],
      detail: row["detail"],
      occurred_at: row["occurred_at"]
    }
  end
end
