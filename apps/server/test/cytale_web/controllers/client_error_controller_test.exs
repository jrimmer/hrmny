defmodule CytaleWeb.Controllers.ClientErrorControllerTest do
  @moduledoc """
  #88 — the client-error ingest and the operator read.

  The claims this suite proves, in the ticket's order:

    1. the ingest accepts an UNAUTHENTICATED post (the login-page crash) and
       stores it tagged anonymous; with a credential it stores the account id;
    2. every response carries the server's `x-request-id`, and a report carrying
       that value is exactly what makes a client failure traceable into the
       server logs — the same string is in the response header AND in the
       stored row, next to the report the maintainer then reads;
    3. a report can carry no message content — by construction, asserted
       against the stored row and the table's column set;
    4. the anonymous path is rate-limited tightly per IP;
    5. the operator read is refused without the operator gate, and groups the
       last N reports by fingerprint when it is permitted.

  Isolation follows the house convention (`Cytale.ScyllaCase`): tests do NOT
  truncate — they use a per-test unique fingerprint and filter to it, so this
  module is safe beside any other suite in the same keyspace.
  """

  use Cytale.ScyllaCase, async: false

  import Phoenix.ConnTest
  import Plug.Conn

  alias Cytale.Accounts.{Auth, User}
  alias Cytale.Observability.ClientErrors

  @endpoint CytaleWeb.Endpoint

  defp run_nonce, do: "r" <> Cytale.TestNonce.get()
  defp run_unique(base), do: base <> run_nonce()

  # Today's rows for ONE fingerprint — the suite must see what was actually
  # STORED, not what the read route chose to render back, and it must see only
  # its own rows (the keyspace is shared, and persists across runs).
  defp stored_rows(fingerprint) do
    statement =
      "SELECT report_id, account_id, fingerprint, client, source, route, version, message, stack, status, request_id, detail, occurred_at " <>
        "FROM #{Cytale.Repo.keyspace()}.client_errors WHERE day = ?"

    Cytale.Repo.execute!(statement, [{"int", ClientErrors.day_of(DateTime.utc_now())}])
    |> Enum.filter(&(&1["fingerprint"] == fingerprint))
  end

  defp payload(fingerprint, overrides \\ %{}) do
    Map.merge(
      %{
        "client" => "web",
        "source" => "unhandledrejection",
        "fingerprint" => fingerprint,
        "message" => "TypeError: undefined is not a function",
        "stack" => "TypeError: undefined is not a function\n  at handler (bundle.js:12:5)",
        "route" => "#/workspaces/:id/channels/:id",
        "version" => "va08ce92"
      },
      overrides
    )
  end

  defp post_report(conn, body), do: post(conn, "/api/v1/client-errors", body)

  defp bare_conn do
    Phoenix.ConnTest.build_conn()
    |> put_req_header("accept", "application/json")
  end

  setup do
    conn = put_req_header(bare_conn(), "content-type", "application/json")

    {:ok, owner} = User.create(run_unique("ce_owner"), run_unique("ce_owner@example.com"), "password-123")
    {:ok, other} = User.create(run_unique("ce_other"), run_unique("ce_other@example.com"), "password-123")

    Application.put_env(:cytale, :operator_user_ids, [owner.user_id])
    on_exit(fn -> Application.put_env(:cytale, :operator_user_ids, []) end)

    owner_conn =
      put_req_header(
        conn,
        "authorization",
        "Bearer " <> Auth.issue_access_token(owner.user_id, owner.username, true)
      )

    other_conn =
      put_req_header(
        conn,
        "authorization",
        "Bearer " <> Auth.issue_access_token(other.user_id, other.username, true)
      )

    {:ok, conn: conn, owner_conn: owner_conn, other_conn: other_conn, owner: owner}
  end

  # -- 1. anonymous by design --------------------------------------------------

  describe "unauthenticated ingest (the login-page crash)" do
    test "accepts an anonymous post and stores it tagged anonymous", %{conn: conn} do
      fingerprint = run_unique("fp_anon")

      response = post_report(conn, payload(fingerprint))

      assert response.status == 204
      assert response.resp_body == ""

      assert [row] = stored_rows(fingerprint)
      assert row["account_id"] == nil
      assert row["client"] == "web"
      assert row["source"] == "unhandledrejection"
      assert row["message"] == "TypeError: undefined is not a function"
      assert row["version"] == "va08ce92"
    end

    test "stores the account id when a credential IS presented", %{owner_conn: conn, owner: owner} do
      fingerprint = run_unique("fp_user")

      assert post_report(conn, payload(fingerprint)).status == 204

      assert [row] = stored_rows(fingerprint)
      assert row["account_id"] == owner.user_id
    end

    test "an expired or malformed credential still STORES the report (anonymous), never 401s", %{
      conn: conn
    } do
      # A crash report produced by a client whose access token just lapsed is
      # exactly the report a plain auth gate would throw away.
      fingerprint = run_unique("fp_stale")

      stale =
        put_req_header(conn, "authorization", "Bearer eyJhbGciOiJIUzI1NiJ9.expired.signature")

      assert post_report(stale, payload(fingerprint)).status == 204
      assert [row] = stored_rows(fingerprint)
      assert row["account_id"] == nil
    end
  end

  # -- 2. the request id, end to end -------------------------------------------

  describe "request-id traceability (the point of the ticket)" do
    test "every ingest response carries the server's x-request-id", %{conn: conn} do
      response = post_report(conn, payload(run_unique("fp_hdr")))

      assert [request_id] = get_resp_header(response, "x-request-id")
      assert byte_size(request_id) in 20..200
    end

    test "the request id is IN the log text — grep finds the failing request", %{conn: conn} do
      # The claim is not "the client can read an id", it is "an operator can
      # follow the report INTO the logs". That requires the id to appear in the
      # formatted log line, which is `config :logger, :default_formatter,
      # metadata: [:request_id]` — without it the id exists but is invisible.
      parent = self()
      fingerprint = run_unique("fp_log")

      log =
        ExUnit.CaptureLog.capture_log(fn ->
          response = post_report(conn, payload(fingerprint))
          send(parent, {:request_id, hd(get_resp_header(response, "x-request-id"))})
        end)

      assert_received {:request_id, request_id}
      assert log =~ "request_id=#{request_id}"
    end

    test "a report carrying a request id stores it verbatim — the trace handle", %{
      conn: conn,
      owner_conn: operator
    } do
      fingerprint = run_unique("fp_traced")

      # Stand in for the failing call's request id: take one from a real
      # response header, which is where the client reads it (Plug.RequestId
      # sets it on every Phoenix response).
      failing_call = post_report(conn, payload(run_unique("fp_seed")))
      assert [request_id] = get_resp_header(failing_call, "x-request-id")

      assert post_report(
               conn,
               payload(fingerprint, %{"request_id" => request_id, "status" => 500})
             ).status == 204

      # The id is stored verbatim: grepping the server logs for it finds the
      # same request, because Plug.RequestId put the identical string in the
      # log metadata.
      assert [row] = stored_rows(fingerprint)
      assert row["request_id"] == request_id
      assert row["status"] == 500

      # ...and it is rendered back on the operator read, so a maintainer gets
      # from "a user reported a crash" to the log line without devtools.
      read = get(operator, "/api/v1/admin/client-errors")
      assert read.status == 200

      group =
        read.resp_body
        |> Jason.decode!()
        |> Map.fetch!("groups")
        |> Enum.find(&(&1["fingerprint"] == fingerprint))

      assert group["example"]["request_id"] == request_id
    end
  end

  # -- 3. content-blind, by construction ---------------------------------------

  describe "no message content can be captured" do
    test "a payload carrying content stores nothing content-shaped", %{conn: conn} do
      # The tempting thing to attach on a failed POST is its body. Send one:
      # there is no column for it, and the store only reads named fields.
      fingerprint = run_unique("fp_content")

      body =
        payload(fingerprint, %{
          "body" => %{"content" => "the-secret-message-text"},
          "request_body" => "the-secret-message-text",
          "headers" => %{"authorization" => "Bearer the-secret-token"},
          "message_content" => "the-secret-message-text"
        })

      assert post_report(conn, body).status == 204

      assert [row] = stored_rows(fingerprint)
      stored = inspect(row)
      refute stored =~ "the-secret-message-text"
      refute stored =~ "the-secret-token"
      refute Map.has_key?(row, "body")
      assert row["message"] == "TypeError: undefined is not a function"
    end

    test "the table has no column that could hold content" do
      for forbidden <- ~w(body content message_content headers cookies token email password) do
        refute forbidden in Enum.map(ClientErrors.columns(), &Atom.to_string/1)
      end
    end

    test "a client-supplied timestamp is ignored (the server stamps the day partition)", %{
      conn: conn
    } do
      fingerprint = run_unique("fp_time")
      ancient = DateTime.utc_now() |> DateTime.add(-5 * 86_400, :second) |> DateTime.to_iso8601()

      assert post_report(conn, payload(fingerprint, %{"occurred_at" => ancient})).status == 204

      # It landed in TODAY's partition, read by the default (today-anchored)
      # query — a wrong client clock cannot scatter rows across partitions.
      assert [row] = stored_rows(fingerprint)
      assert DateTime.diff(DateTime.utc_now(), row["occurred_at"], :second) < 60
    end
  end

  # -- 4. the anonymous dam ----------------------------------------------------

  describe "rate limiting" do
    test "the anonymous path is limited tightly per IP", %{conn: conn} do
      fingerprint = run_unique("fp_over")
      key = {:client_errors, {:ip, CytaleWeb.Compat.RateLimit.ip_key(conn.remote_ip)}}
      table = CytaleWeb.Compat.RateTables.native_table()

      # Seed the bucket AT its (test-overridden) limit: the next consume
      # saturates and refuses. The deterministic seed the rate-limit suite uses
      # — never "send 11 real requests and hope nothing else shares the IP".
      limit = Application.get_env(:cytale, :rate_limit_overrides) |> Keyword.fetch!(:client_errors)
      :ets.insert(table, {key, limit, System.system_time(:millisecond) + 60_000})
      on_exit(fn -> :ets.delete(table, key) end)

      response = post_report(conn, payload(fingerprint))

      assert response.status == 429
      assert Jason.decode!(response.resp_body)["error"]["key"] == "rate_limited"
      assert stored_rows(fingerprint) == []
    end
  end

  # -- storage failures never break the client ---------------------------------

  describe "the ingest never breaks the client" do
    test "validation failures are a 400 with the standard envelope", %{conn: conn} do
      response = post_report(conn, %{"client" => "web", "source" => "window.onerror"})

      assert response.status == 400
      assert Jason.decode!(response.resp_body)["error"]["key"] == "validation_failed"
      assert Jason.decode!(response.resp_body)["error"]["code"] == 40_001
    end

    test "an unknown source or client is refused", %{conn: conn} do
      assert post_report(conn, payload(run_unique("fp_src"), %{"source" => "sentry"})).status == 400
      assert post_report(conn, payload(run_unique("fp_cli"), %{"client" => "toaster"})).status == 400
    end

    test "a storage failure is logged and STILL answers 204", %{conn: conn} do
      fingerprint = run_unique("fp_down")
      Application.put_env(:cytale, :client_error_writer, fn _attrs -> {:error, :scylla_down} end)
      on_exit(fn -> Application.delete_env(:cytale, :client_error_writer) end)

      log =
        ExUnit.CaptureLog.capture_log(fn ->
          assert post_report(conn, payload(fingerprint)).status == 204
        end)

      assert log =~ "client error report was NOT stored"
      assert stored_rows(fingerprint) == []
    end
  end

  # -- 5. the operator read ----------------------------------------------------

  describe "GET /api/v1/admin/client-errors" do
    test "is refused without the operator gate", %{conn: conn, other_conn: non_operator} do
      assert get(conn, "/api/v1/admin/client-errors").status == 401
      assert get(non_operator, "/api/v1/admin/client-errors").status == 403
    end

    test "groups the last N reports by fingerprint for an operator", %{
      conn: conn,
      owner_conn: operator
    } do
      repeated = run_unique("fp_repeat")
      single = run_unique("fp_once")

      assert post_report(conn, payload(repeated)).status == 204
      assert post_report(conn, payload(repeated, %{"message" => "second"})).status == 204
      assert post_report(conn, payload(single)).status == 204

      response = get(operator, "/api/v1/admin/client-errors")
      assert response.status == 200

      body = Jason.decode!(response.resp_body)
      assert body["retention_days"] == 30
      # The retention is restated where the operator is actually reading.
      assert body["note"] =~ "30 days"
      assert body["note"] =~ "no message content"

      groups = body["groups"]
      group = Enum.find(groups, &(&1["fingerprint"] == repeated))
      assert group["count"] == 2
      assert group["example"]["anonymous"] == true
      assert group["last_seen_at"]
      assert Enum.any?(groups, &(&1["fingerprint"] == single))
    end

    test "the read is bounded by its query params", %{owner_conn: operator} do
      # Out-of-range and garbage values fall back to the bounds rather than
      # erroring: a diagnostic read must not be a puzzle.
      assert get(operator, "/api/v1/admin/client-errors?days=9999&groups=nonsense").status == 200
      assert Jason.decode!(get(operator, "/api/v1/admin/client-errors?days=2").resp_body)["days"] == 2
      assert Jason.decode!(get(operator, "/api/v1/admin/client-errors?days=9999").resp_body)["days"] == 30
    end
  end
end
