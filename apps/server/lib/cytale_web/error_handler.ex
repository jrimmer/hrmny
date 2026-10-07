defmodule CytaleWeb.ErrorHandler do
  @moduledoc """
  The endpoint's `Plug.ErrorHandler` (hardening plan 1.7): a database that
  cannot answer is `503` + `Retry-After`, not an opaque `500`.

  Before this existed the endpoint registered no error handler at all, so a
  ScyllaDB outage surfaced as a generic 500 with no retry signal — a client
  cannot tell "the server is broken, don't retry" from "the database is
  briefly unreachable, retry now", and the two want opposite behavior.

  ## Everything else is RE-RAISED, deliberately

  The handler converts only the database being unavailable (and its two
  relatives: a full database disk, `storage_full?/1`, and Argon2 at capacity)
  and re-raises every other exception, so behavior for genuine bugs is byte-identical
  to before this module existed (which is also what the plan asks: "leaving
  genuine bugs as 500"). Re-raising rather than synthesizing a 500 keeps the
  existing contract that a server-side bug is a raised exception, which the SSH
  and `Plug.Parsers` paths already depend on.

  ## Scope: the retry half lives in the Repo

  The OTHER half of 1.7 — retrying transient failures — now exists, placed at
  the Repo seam rather than as a Xandra `:retry_strategy`: idempotent reads
  retry inside `Cytale.Repo.execute/3`/`query/3` (hardening R-7,
  `Cytale.Repo.with_read_retry/2`), bounded by `Cytale.Config.repo_read_retries/0`.
  Writes are never retried (non-idempotent — an unknown-outcome write must not
  be re-asked), so this module's write/500 discipline above is unchanged: a
  client that heeds `Retry-After` can only ever be retrying something the
  server itself deemed safe to re-ask.
  """

  @behaviour Plug.ErrorHandler

  import Plug.Conn

  # Xandra error reasons that mean "come back later", from the protocol's own
  # code table (`xandra/protocol/protocol.ex`): not enough replicas, too much
  # load, still bootstrapping, and the timeout/replica-failure family.
  #
  # Deliberately NOT included: :invalid_syntax, :unauthorized, :invalid,
  # :already_exists, and the rest of the 0x2xxx family — those are bugs or
  # caller errors, and answering 503 for them would hide a real defect behind a
  # "try again" that can never succeed.
  @transient_reasons [
    :unavailable,
    :overloaded,
    :bootstrapping,
    :read_timeout,
    :read_failure
  ]

  # Deliberately NOT transient, and this is a correction: `:write_timeout`,
  # `:write_failure` and `:server_failure` mean the OUTCOME OF A WRITE IS
  # UNKNOWN — the coordinator may already have applied it. Answering 503 +
  # `Retry-After` tells the client to retry, and a retry can therefore duplicate
  # the write. The honest answer for an unknown-outcome write is 500.
  #
  # Reads keep the 503: they are safe to retry and the retry is the whole point.

  # Xandra's ConnectionError is NOT uniformly transient: its documented reasons
  # include `{:unsupported_compression, algorithm}`, a configuration defect that
  # can never succeed on a retry. Matching the struct wholesale would have
  # answered 503 + Retry-After for it forever, contradicting this module's own
  # rule above. Unreachable today (this Repo configures no :compressor), but the
  # classification is what the module is for.
  @transient_connection_reasons [
    :closed,
    :timeout,
    :disconnected,
    :connection_shutdown,
    :schema_agreement_timeout,
    :not_connected,
    :connection_process_crashed,
    # A TCP-level connect/recv failure IS "the database is unreachable".
    :tcp_connect,
    :tcp_recv
  ]

  # Hardening R-7 pairs this with the read retries the Repo now runs
  # internally (`Cytale.Repo.with_read_retry/2`): by the time a 503 reaches a
  # client the server has already re-asked a transient read failure twice, so
  # the hint shortens to ONE second — retry soon, the outage is usually
  # shorter than an eyeball blink of backoff.
  @retry_after_seconds 1

  @impl true
  # Argon2 at capacity (`Cytale.Accounts.HashGate`): the same 503 +
  # Retry-After shape — the request is safe to re-ask once a slot frees.
  def handle_errors(conn, %{kind: :error, reason: %Cytale.Accounts.HashGate.Busy{}}) do
    conn
    |> put_resp_content_type("application/json")
    |> put_resp_header("retry-after", Integer.to_string(@retry_after_seconds))
    |> send_resp(503, Jason.encode!(busy_envelope(conn)))
  end

  def handle_errors(conn, %{kind: :error, reason: reason, stack: stack}) do
    cond do
      # Checked FIRST: a full disk arrives as a write-failure reason, which the
      # transient classifier below rightly refuses. No Retry-After — nothing
      # changes until an operator frees space, and the write rule above still
      # holds, so the client gets no hint to re-send.
      storage_full?(reason) ->
        conn
        |> put_resp_content_type("application/json")
        |> send_resp(503, Jason.encode!(storage_full_envelope(conn)))

      database_unavailable?(reason) ->
        conn
        |> put_resp_content_type("application/json")
        |> put_resp_header("retry-after", Integer.to_string(@retry_after_seconds))
        |> send_resp(503, Jason.encode!(envelope(conn)))

      true ->
        reraise reason, stack
    end
  end

  def handle_errors(_conn, %{kind: kind, reason: reason, stack: stack}) do
    # :throw / :exit are not exceptions — preserve the pre-handler behavior.
    :erlang.raise(kind, reason, stack)
  end

  @doc """
  Is this exception the database being unavailable, as opposed to a bug?

  Public and pure so the classification is unit-testable without a database:
  "the probe fails when the database is down" is a claim that deserves a test,
  and no test should have to stop ScyllaDB to make it (the same reasoning
  `CytaleWeb.HealthController` records for its injectable readiness check).
  """
  @spec database_unavailable?(term()) :: boolean()
  def database_unavailable?(%Xandra.ConnectionError{reason: reason}),
    do: transient_connection?(reason)

  def database_unavailable?(%Xandra.Error{reason: reason}), do: transient?(reason)
  def database_unavailable?(_other), do: false

  @doc """
  Is this ScyllaDB refusing writes because its disk is nearly full?

  Past its critical utilization level (98% by default) ScyllaDB rejects every
  write mutation with this message, so each write-path request — logging in
  included, since that writes a session — failed as a bare 500 with nothing to
  tell the user or the operator why (2026-10-06: a full root filesystem on the
  production host broke every login). Matched on the message, not the reason:
  the driver reports it as a plain `:write_failure`, which also covers
  failures whose outcome is genuinely unknown.
  """
  @spec storage_full?(term()) :: boolean()
  def storage_full?(%Xandra.Error{message: message}) when is_binary(message),
    do: String.contains?(message, "Critical disk utilization")

  def storage_full?(_other), do: false

  # Xandra's ACTUAL "all nodes are down" reason. The generic tuple clause below
  # tests `elem(reason, 0)`, which is `:cluster` for this pair — and `:cluster`
  # is deliberately not in the list, so a total outage fell straight through and
  # re-raised. `:not_connected` is listed as a bare atom, which never matches a
  # tuple. Found by review (two reviewers independently, one verifying live
  # against a dead-port cluster, which returns exactly this shape).
  defp transient_connection?({:cluster, :not_connected}), do: true
  defp transient_connection?({:cluster, :pool_closed}), do: true

  defp transient_connection?(reason) when is_atom(reason),
    do: reason in @transient_connection_reasons

  defp transient_connection?({kind, _detail}) when is_atom(kind),
    do: kind in @transient_connection_reasons

  defp transient_connection?(_reason), do: false

  # Xandra 0.20 decodes server error reasons as BARE ATOMS — the parameters live
  # in the message string, not the reason (`v4.ex:417` -> `Error.new/3`, which
  # guards `is_atom(reason)`). The atom/other split below is therefore
  # defensive: it keeps the classifier total rather than crashing on a shape the
  # pinned driver cannot produce.
  defp transient?(reason) when is_atom(reason), do: reason in @transient_reasons
  defp transient?(_reason), do: false

  # TWO DIALECTS, two envelopes. The native surface binds
  # `{error: {key, code, message}}` (docs/protocol/rest.md); the Discord compat
  # surface binds a BARE `{code, message}` with Discord numeric codes
  # (docs/protocol/compat.md). Sending the native shape to a discord.js client
  # makes it read `res.code` === undefined and throw inside its own error
  # branch — so the dialect is a correctness requirement, not cosmetics.
  #
  # The discriminator is the `:error_dialect` assign set by the compat pipelines'
  # plug, NOT a path prefix: `/api/v10` carries both native and compat scopes,
  # and the bare `/api` alias serves compat while `/api/v1` and `/api/webhooks`
  # are native. Plug.Builder captures the conn at the raise point, so an assign
  # made by an already-run pipeline plug IS visible here.
  #
  # Code 0 is the compat convention for "no specific Discord code" (its 429/401
  # rows use it).
  defp envelope(%{assigns: %{error_dialect: :compat}}) do
    %{"code" => 0, "message" => "503: Service Unavailable"}
  end

  # The documented native envelope (docs/protocol/rest.md): key + numeric code
  # + message, with the code mirroring the status exactly as 40001 does for 400.
  defp envelope(_conn) do
    %{
      "error" => %{
        "key" => "service_unavailable",
        "code" => 50_301,
        "message" => "The database is temporarily unavailable. Retry shortly."
      }
    }
  end

  defp storage_full_envelope(%{assigns: %{error_dialect: :compat}}),
    do: %{"code" => 0, "message" => "503: Service Unavailable"}

  defp storage_full_envelope(_conn) do
    %{
      "error" => %{
        "key" => "storage_full",
        "code" => 50_302,
        "message" =>
          "The server is out of storage space, so it can't save changes right now. " <>
            "An administrator needs to free up disk space."
      }
    }
  end

  defp busy_envelope(%{assigns: %{error_dialect: :compat}}),
    do: %{"code" => 0, "message" => "503: Service Unavailable"}

  defp busy_envelope(_conn) do
    %{
      "error" => %{
        "key" => "service_busy",
        "code" => 50_301,
        "message" => "The server is busy. Retry shortly."
      }
    }
  end
end
