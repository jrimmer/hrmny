defmodule CytaleWeb.Plugs.Idempotency do
  @moduledoc """
  U9 — Idempotency-Key plug (POST replay protection).

  A mutating POST carrying an `Idempotency-Key` header is keyed on
  `{user_id, key}` in an ETS table (TTL ~24h), whose NAME and LIFETIME are
  owned by `CytaleWeb.Compat.RateTables` — a supervised long-lived process —
  so the store outlives every connection that reads it. The FIRST request
  executes the controller and its response (status + serialized body) is
  stored; a RETRY with the same key returns the stored response verbatim with
  `Idempotency-Replayed: true` — the client sees the original 201, never a
  duplicate resource.

  A same key with a DIFFERENT request body is an `idempotency_conflict`
  409 (API Surface convention).

  Requests without the header pass through untouched (idempotency is
  opt-in per request, per the contract).

  **Message sends are not replayed here.** Every send route
  (`CytaleWeb.SendRoutes`) keys its retries in the send pipeline's DURABLE
  dedupe (`Cytale.Messages.Send` over `Cytale.Messages.Nonces`), which reads
  the same `Idempotency-Key` (or the body `nonce`), survives a restart,
  answers a retry that races the first attempt, and decides a reused key
  with a different message the same way on every route. A second, in-memory
  replay in front of it answered the same retry differently — a stored `201`
  here, the original `200` there, and a different body a `409` only while
  this node remembered the key — so for sends this plug steps aside and the
  pipeline is the one mechanism. Every other keyed POST (thread starts,
  invites, …) is still replayed here.
  """

  @behaviour Plug

  import Plug.Conn

  # The table name lives in ONE place — `CytaleWeb.Compat.RateTables`, which
  # owns and sweeps it. A second copy here is the drift this change removed.
  @ttl_ms 24 * 60 * 60 * 1000

  @impl true
  def init(opts), do: opts

  @impl true
  def call(conn, _opts) do
    # The table is owned by `CytaleWeb.Compat.RateTables` and created at boot, so
    # on a normal boot it is always there. If that owner is absent — a hermetic
    # boot, or its restart window — idempotency degrades to "not enforced",
    # which is the posture this plug had before the table moved, and strictly
    # better than letting the missing table raise and turn a keyed POST into a
    # 500. (`Repo.Statements` documents the same degradation contract for its
    # cache.)
    cond do
      CytaleWeb.SendRoutes.send_route?(conn) -> conn
      :ets.whereis(table()) == :undefined -> conn
      true -> replay_or_register(conn)
    end
  end

  defp replay_or_register(conn) do
    case {conn.method, get_req_header(conn, "idempotency-key")} do
      {"POST", [key | _]} when byte_size(key) > 0 ->
        user_id = current_user_id(conn)
        body_hash = request_body_hash(conn)

        case :ets.lookup(table(), {user_id, key}) do
          [{_k, ^body_hash, status, stored_body, _exp}] ->
            conn
            |> put_resp_content_type("application/json")
            |> put_resp_header("idempotency-replayed", "true")
            |> send_resp(status, stored_body)
            |> halt()

          [{_k, _other_body, _status, _stored, _exp}] ->
            conn
            |> put_resp_content_type("application/json")
            |> send_resp(409, Jason.encode!(conflict_envelope()))
            |> halt()

          [] ->
            register_before_send(conn, user_id, key, body_hash)
        end

      _ ->
        conn
    end
  end

  # Stores the response after the controller has produced it.
  #
  # No sweep here (hardening plan 1.4): this used to run an opportunistic
  # whole-table `:ets.foldl` on a request's critical path, once a minute,
  # whichever request happened to land on the tick. `CytaleWeb.Compat.RateTables`
  # now owns this table AND sweeps it on its own cadence, off the request path.
  defp register_before_send(conn, user_id, key, body_hash) do
    register_before_send_callback(conn, fn status, body ->
      # Only a COMPLETED operation may become a replayable 24h answer.
      #
      # A 5xx must not: the endpoint's 503 (CytaleWeb.Router's Plug.ErrorHandler)
      # travels this same conn, so storing it meant a client that reuses its
      # Idempotency-Key on retry — the documented contract — got the stored 503
      # replayed with `Idempotency-Replayed: true`, the write could never happen,
      # and Retry-After was a lie.
      #
      # try/catch because this runs in before_send, AFTER the controller has
      # committed: if the owner restarted in between, an unguarded insert would
      # raise out of `send_resp` and hand the client a 500 for a write that
      # SUCCEEDED — its retry would then duplicate the write, which is the exact
      # failure item 1.4 exists to remove.
      if status < 500 do
        try do
          :ets.insert(table(), {{user_id, key}, body_hash, status, body, now_ms() + @ttl_ms})
        catch
          :error, :badarg -> :ok
        end
      end
    end)
  end

  defp register_before_send_callback(conn, fun) do
    # Plug.Conn.register_before_send gives one hook; wrap so the FIRST
    # before_send to run captures status+body for storage.
    Plug.Conn.register_before_send(conn, fn conn ->
      body =
        case conn.resp_body do
          bin when is_binary(bin) -> bin
          other -> IO.iodata_to_binary(other)
        end

      fun.(conn.status, body)
      conn
    end)
  end

  defp current_user_id(conn) do
    case conn.assigns[:current_user] do
      %{user_id: id} -> id
      _ -> :anonymous
    end
  end

  # Body hash for conflict detection. Bodies are raw request bodies; the plug
  # pipeline has already parsed JSON into params, so hash the RAW body captured
  # before parsing (Plug.Parsers keeps it via cache_body reading; here we hash
  # the parsed params deterministically instead — same conflict semantics,
  # parser-independent).
  defp request_body_hash(conn) do
    :erlang.phash2({conn.path_info, conn.params})
  end

  # OWNERSHIP (hardening plan 1.4): the table is created at boot by
  # `CytaleWeb.Compat.RateTables`, a supervised long-lived owner, and swept
  # there. This plug only reads and writes it.
  #
  # It used to create the table itself, lazily, from whichever Bandit
  # connection process first carried an `Idempotency-Key` — so the store died
  # with that connection and a client retry after a dropped connection
  # re-executed the controller, duplicating the write the header exists to
  # prevent. That failure is silent: the guarantee becomes unenforceable rather
  # than erroring. The module that documents this exact hazard for the rate
  # tables had already been fixed twice for the same shape (#90); this is the
  # third instance.
  defp table, do: CytaleWeb.Compat.RateTables.idempotency_table()

  defp now_ms, do: System.system_time(:millisecond)

  defp conflict_envelope do
    %{
      "error" => %{
        "key" => "idempotency_conflict",
        "code" => 40_909,
        "message" => "This Idempotency-Key was already used with a different request."
      }
    }
  end
end
