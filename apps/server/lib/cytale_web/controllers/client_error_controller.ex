defmodule CytaleWeb.ClientErrorController do
  @moduledoc """
  The client-error ingest (#88): `POST /api/v1/client-errors`.

  A client report is the only path a user-facing JavaScript exception, a failed
  API call or a dead socket has to the maintainer — before this, a client-side
  bug was discovered only when a human mentioned it (which is how the compat
  bugs #69–#77 were found by an external client operator rather than by us).

  ## Unauthenticated by design, attributed when it can be

  The route rides `CytaleWeb.Plugs.OptionalAuth`: the most valuable report is
  the login-page crash, which by definition has no session. When the caller
  DOES present a valid credential, `account_id` is filled from the resolved
  claims, so the row is user-attributed; otherwise it is `nil` — anonymous —
  and the rate bucket is keyed per IP (the pipeline's tight `:client_errors`
  bucket).

  ## Content-blind, and it must never break the client

  The stored row's columns are a closed set (see
  `Cytale.Observability.ClientErrors`) and this controller only ever reads
  named fields: a payload carrying a request body, headers or message content
  has nowhere to put them. `client` and `source` are checked against the sink's
  vocabulary so an operator's read surface stays honest; `message` and
  `fingerprint` are required because a row without them cannot be grouped or
  deduped. Everything else is optional.

  A **client-supplied timestamp is ignored**: `occurred_at` is the server's
  clock, because the day partition is derived from it and a wrong client clock
  would scatter rows across partitions (or write into the future).

  Storage failures are LOGGED and answered 204 anyway — an error-reporting
  route that fails loudly on its own storage problem turns a diagnosis gap into
  a second incident, and the client (which never retries) could do nothing with
  the status code. A validation failure is a 400: it is a developer signal on a
  write path, and the client ignores the response either way.
  """

  use CytaleWeb, :controller

  require Logger

  alias Cytale.Observability.ClientErrors
  import CytaleWeb.API.Error, only: [error: 4]

  @doc """
  POST /api/v1/client-errors — store one report.

  Responds `204 No Content` on success (including when storage failed, which is
  logged): there is nothing useful to tell the caller, and nothing the caller
  could do with it.
  """
  def create(conn, params) when is_map(params) do
    case validate(params) do
      {:ok, attrs} ->
        attrs
        |> Map.put(:account_id, account_id(conn))
        |> persist()

        send_resp(conn, 204, "")

      {:error, message} ->
        error(conn, 400, "validation_failed", message)
    end
  end

  def create(conn, _params),
    do: error(conn, 400, "validation_failed", "a JSON object body is required")

  @doc """
  GET /api/v1/admin/client-errors — the OPERATOR read: the last N reports,
  grouped by fingerprint.

  Mounted on the `:operator` tier (auth + `CytaleWeb.Plugs.RequireOperator`),
  because a client error's route is a map of where people were and its message
  can name a workspace. Deliberately the whole surface: a grouped list with
  counts, a newest example per fingerprint and the server's request id next to
  each — no dashboard, no grouping engine, no alerting (explicitly out of scope
  for v1). A maintainer greps the server logs for `request_id` and is inside
  the failing request.

  Query params, both bounded: `?days=` (1..30, default 3) and
  `?groups=` (1..200, default 50).
  """
  def read(conn, params) do
    report =
      ClientErrors.recent_grouped(
        days: bounded(params["days"], 3, 1, ClientErrors.retention_days()),
        groups: bounded(params["groups"], 50, 1, 200)
      )

    json(conn, %{
      "days" => report.days,
      "reports" => report.reports,
      "truncated" => report.truncated,
      "retention_days" => ClientErrors.retention_days(),
      # Says what the reader must not expect, where the reader is looking.
      "note" =>
        "Client error reports only; no message content, request bodies, headers or " <>
          "cookies are ever captured. Reports expire #{ClientErrors.retention_days()} days " <>
          "after they are written (ScyllaDB row TTL).",
      "groups" =>
        Enum.map(report.groups, fn group ->
          %{
            "fingerprint" => group.fingerprint,
            "count" => group.count,
            "last_seen_at" => iso(group.last_seen_at),
            "example" => report_json(group.example)
          }
        end)
    })
  end

  # A query parameter is untrusted input: anything unparseable or out of range
  # falls back to the default rather than erroring. The read is a diagnostic,
  # and a typo in `?days=x` should not be a 400 an operator has to think about.
  defp bounded(raw, default, min, max) do
    case raw && Integer.parse(to_string(raw)) do
      {n, ""} when is_integer(n) -> n |> max(min) |> min(max)
      _ -> default
    end
  end

  defp report_json(example) do
    %{
      "report_id" => to_string(example.report_id),
      "account_id" => example.account_id && to_string(example.account_id),
      "anonymous" => is_nil(example.account_id),
      "client" => example.client,
      "source" => example.source,
      "route" => example.route,
      "version" => example.version,
      "message" => example.message,
      "stack" => example.stack,
      "status" => example.status,
      "request_id" => example.request_id,
      "detail" => example.detail,
      "occurred_at" => iso(example.occurred_at)
    }
  end

  defp iso(nil), do: nil
  defp iso(%DateTime{} = dt), do: DateTime.to_iso8601(dt)

  # -- storage ---------------------------------------------------------------

  # Injectable (like the readiness probe's check) so "a storage failure still
  # answers 204" is a claim the suite can prove without breaking ScyllaDB.
  defp persist(attrs) do
    case writer().(attrs) do
      {:ok, _report_id} ->
        :ok

      {:error, reason} ->
        Logger.warning(
          "client error report was NOT stored (fingerprint=#{inspect(attrs[:fingerprint])} " <>
            "source=#{inspect(attrs[:source])}): #{inspect(reason)}"
        )
    end
  end

  defp writer do
    Application.get_env(:cytale, :client_error_writer, &ClientErrors.record/1)
  end

  # -- validation ------------------------------------------------------------

  # Only named fields are read: an unrecognized key in the payload is ignored
  # rather than stored, which is the controller half of the content-blind
  # guarantee.
  defp validate(params) do
    with {:ok, message} <- required_text(params, "message", 1_000),
         {:ok, fingerprint} <- required_text(params, "fingerprint", 64),
         {:ok, client} <- member(params, "client", ClientErrors.clients()),
         {:ok, source} <- member(params, "source", ClientErrors.sources()) do
      {:ok,
       %{
         message: message,
         fingerprint: fingerprint,
         client: client,
         source: source,
         route: optional_text(params, "route", 500),
         version: optional_text(params, "version", 64),
         stack: optional_text(params, "stack", 8_000),
         detail: optional_text(params, "detail", 500),
         status: optional_integer(params, "status"),
         request_id: optional_text(params, "request_id", 128)
       }}
    end
  end

  defp required_text(params, key, max) do
    case optional_text(params, key, max) do
      nil -> {:error, "#{key} is required and must be a non-empty string"}
      value -> {:ok, value}
    end
  end

  defp optional_text(params, key, max) do
    case params[key] do
      value when is_binary(value) and byte_size(value) > 0 -> binary_part(value, 0, min(byte_size(value), max))
      _ -> nil
    end
  end

  defp optional_integer(params, key) do
    case params[key] do
      value when is_integer(value) -> value
      _ -> nil
    end
  end

  # A closed vocabulary: the sink's read surface is an operator tool, and a
  # report it cannot classify is not one it should accept. Both clients are
  # ours, so the refusal is a developer signal, not a compatibility hazard.
  defp member(params, key, allowed) do
    case params[key] do
      value when is_binary(value) ->
        if value in allowed do
          {:ok, value}
        else
          {:error, "#{key} must be one of #{Enum.join(allowed, ", ")}"}
        end

      _ ->
        {:error, "#{key} is required and must be one of #{Enum.join(allowed, ", ")}"}
    end
  end

  # The ticket's anonymous-vs-user tag: the account that produced the report
  # when a session was resolvable, nil when it was not.
  defp account_id(%{assigns: %{current_user: %{user_id: user_id}}}), do: user_id
  defp account_id(_conn), do: nil

  # The standard `/api/v1` envelope: `code` is `status * 100 + 1`, the same
  # convention every other controller uses (a 400 reads 40001).
end
