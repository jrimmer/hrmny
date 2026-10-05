defmodule CytaleWeb.ErrorHandlerTest do
  @moduledoc """
  Hardening plan 1.7 — a database that cannot answer is 503 + Retry-After, and
  nothing else changes.

  Pure and database-free by design: "the handler fires when the database is
  down" is a claim that deserves a test, and no test should have to stop
  ScyllaDB to make it. The transient reason list is checked against Xandra's own
  protocol code table (`xandra/protocol/protocol.ex`), so these cases pin the
  mapping rather than restating a guess.
  """

  use ExUnit.Case, async: true

  import Plug.Conn
  import Plug.Test

  alias CytaleWeb.ErrorHandler

  # A real stacktrace, so the handler's `reraise/2` contract and the type
  # checker are both satisfied (an empty list is a lie about the argument).
  defp stacktrace do
    try do
      raise "stacktrace probe"
    rescue
      _ -> __STACKTRACE__
    end
  end

  describe "database_unavailable?/1 — the classification" do
    test "a connection error is transient only when its reason says so" do
      assert ErrorHandler.database_unavailable?(%Xandra.ConnectionError{
               action: "checkout from cluster",
               reason: :closed
             })

      assert ErrorHandler.database_unavailable?(%Xandra.ConnectionError{
               action: "connect",
               reason: {:tcp_connect, :econnrefused}
             })

      # A ConnectionError is NOT uniformly transient: Xandra documents
      # `{:unsupported_compression, algorithm}` as one, and that is a
      # configuration defect which can never succeed on a retry. Answering 503 +
      # Retry-After for it forever would contradict this module's own rule.
      refute ErrorHandler.database_unavailable?(%Xandra.ConnectionError{
               action: "connect",
               reason: {:unsupported_compression, :zstd}
             })
    end

    test "Xandra's transient READ reasons map to unavailable" do
      # Reads only. The write-unknown family is asserted NOT retryable below.
      for reason <- [
            :unavailable,
            :overloaded,
            :bootstrapping,
            :read_timeout,
            :read_failure
          ] do
        assert ErrorHandler.database_unavailable?(%Xandra.Error{reason: reason}),
               "#{inspect(reason)} must be treated as retryable"
      end
    end

    test "a write whose OUTCOME IS UNKNOWN is not answered with retryable 503" do
      # Correction from review: :write_timeout, :write_failure and
      # :server_failure mean the coordinator may already have applied the write.
      # 503 + Retry-After tells the client to retry, and the retry can then
      # duplicate the write. 500 is the honest answer.
      for reason <- [:write_timeout, :write_failure, :server_failure] do
        refute ErrorHandler.database_unavailable?(%Xandra.Error{reason: reason}),
               "#{inspect(reason)} must NOT become 503 + Retry-After"
      end
    end

    test "a parametrized server-error reason is not a shape this driver produces" do
      # Xandra 0.20 decodes server error reasons as BARE ATOMS (the parameters
      # ride the message string, not the reason), so a tuple reason cannot come
      # from traffic. The classifier stays total instead of crashing on it — and
      # this pins that the impossible shape is treated as NOT retryable rather
      # than accidentally matching.
      refute ErrorHandler.database_unavailable?(%Xandra.Error{
               reason: {:unavailable, :quorum, 1, 0}
             })

      refute ErrorHandler.database_unavailable?(%Xandra.Error{
               reason: {:invalid, "bad column"}
             })
    end

    test "caller errors and genuine bugs are NOT masked as unavailable" do
      # Answering 503 for these would hide a real defect behind a "try again"
      # that can never succeed.
      for reason <- [:invalid_syntax, :unauthorized, :invalid, :already_exists, :invalid_config] do
        refute ErrorHandler.database_unavailable?(%Xandra.Error{reason: reason}),
               "#{inspect(reason)} must not be reported as a database outage"
      end

      refute ErrorHandler.database_unavailable?(%RuntimeError{message: "a real bug"})
      refute ErrorHandler.database_unavailable?(:not_an_exception)
      refute ErrorHandler.database_unavailable?(nil)
    end
  end

  describe "handle_errors/2 — the response" do
    test "a database outage becomes 503 + Retry-After + the documented envelope" do
      http_conn = conn(:get, "/api/v1/channels/1/messages")

      sent =
        ErrorHandler.handle_errors(http_conn, %{
          kind: :error,
          reason: %Xandra.ConnectionError{action: "checkout", reason: :closed},
          stack: stacktrace()
        })

      assert sent.status == 503
      assert get_resp_header(sent, "retry-after") == ["1"]

      assert [content_type] = get_resp_header(sent, "content-type")
      assert content_type =~ "application/json"

      # docs/protocol/rest.md: one error envelope, {key, code, message}, with the
      # code mirroring the status the way 40001 does for 400.
      body = Jason.decode!(sent.resp_body)
      assert body["error"]["key"] == "service_unavailable"
      assert body["error"]["code"] == 50_301
      assert is_binary(body["error"]["message"])
    end

    test "a genuine bug is re-raised, not converted to a response" do
      http_conn = conn(:get, "/api/v1/x")

      assert_raise RuntimeError, "a real bug", fn ->
        ErrorHandler.handle_errors(http_conn, %{
          kind: :error,
          reason: %RuntimeError{message: "a real bug"},
          stack: stacktrace()
        })
      end
    end

    # Hardening R-7: the 503 must not cost the request its trace identity.
    # `Plug.RequestId` puts `x-request-id` on the RESPONSE header early in the
    # endpoint pipeline (before the raise), and `send_resp/3` writes whatever
    # headers the conn already accumulated — so preservation is the handler
    # not DROPPING them. If this ever regresses, every 503 becomes
    # un-correlatable with the request logs that triggered the alert.
    test "a request id set before the raise survives the 503" do
      http_conn =
        conn(:get, "/api/v1/channels/1/messages")
        |> put_resp_header("x-request-id", "req-test-123")

      sent =
        ErrorHandler.handle_errors(http_conn, %{
          kind: :error,
          reason: %Xandra.ConnectionError{action: "checkout", reason: :closed},
          stack: stacktrace()
        })

      assert sent.status == 503
      assert get_resp_header(sent, "x-request-id") == ["req-test-123"]
      assert get_resp_header(sent, "retry-after") == ["1"]
    end

    test "a throw is re-raised with its kind preserved" do
      http_conn = conn(:get, "/api/v1/x")

      assert catch_throw(
               ErrorHandler.handle_errors(http_conn, %{
                 kind: :throw,
                 reason: :not_an_exception,
                 stack: stacktrace()
               })
             ) == :not_an_exception
    end
  end

  describe "the response DIALECT" do
    test "a compat request gets the bare Discord error object, not the native envelope" do
      # docs/protocol/compat.md binds a bare `{code, message}`. A discord.js
      # client reads `res.code`; the native shape leaves it undefined and the
      # library throws inside its own error branch.
      compat_conn = Plug.Conn.assign(Plug.Test.conn(:get, "/api/v10/channels/1"), :error_dialect, :compat)

      sent =
        ErrorHandler.handle_errors(compat_conn, %{
          kind: :error,
          reason: %Xandra.ConnectionError{action: "checkout", reason: {:cluster, :not_connected}},
          stack: stacktrace()
        })

      assert sent.status == 503
      body = Jason.decode!(sent.resp_body)
      assert body["code"] == 0
      assert is_binary(body["message"])
      refute Map.has_key?(body, "error")
    end

    test "the native surface keeps its documented envelope" do
      native_conn = Plug.Test.conn(:get, "/api/v1/channels/1/messages")

      sent =
        ErrorHandler.handle_errors(native_conn, %{
          kind: :error,
          reason: %Xandra.ConnectionError{action: "checkout", reason: {:cluster, :not_connected}},
          stack: stacktrace()
        })

      assert sent.status == 503
      assert Jason.decode!(sent.resp_body)["error"]["code"] == 50_301
    end

    test "the compat pipelines mark the dialect for both spellings" do
      # The marker must be wired, or the branch above is unreachable in
      # production while the unit test still passes (the same trap the endpoint
      # placement fell into).
      source = File.read!("lib/cytale_web/router.ex")

      assert length(Regex.scan(~r/plug\(:assign_compat_dialect\)/, source)) == 2,
             "both the :compat and :compat_json pipelines must mark the dialect"
    end
  end

  describe "the classifier against the driver's real reasons" do
    test "a cluster checkout with no reachable node is transient" do
      # THE reason a total ScyllaDB outage produces, and the one the generic
      # tuple clause missed: it tested `elem(reason, 0)` = `:cluster`, which is
      # deliberately not listed, while `:not_connected` was listed only as a bare
      # atom and so never matched a tuple. Two reviewers found this
      # independently; one verified it against a dead-port cluster. Without it,
      # item 1.7's whole purpose — an outage answering 503 — fails.
      assert ErrorHandler.database_unavailable?(%Xandra.ConnectionError{
               action: "checkout from cluster Cytale.Repo",
               reason: {:cluster, :not_connected}
             })

      assert ErrorHandler.database_unavailable?(%Xandra.ConnectionError{
               action: "checkout from cluster Cytale.Repo",
               reason: {:cluster, :pool_closed}
             })
    end
  end

  describe "wiring: the handler must run BEFORE Phoenix renders" do
    test "the ROUTER's own delegate answers 503 for the real outage reason" do
      # Through `CytaleWeb.Router.handle_errors/2` — the function Plug actually
      # invokes now — so this covers the delegate AND the classifier together.
      #
      # Deliberately NOT driving `Router.call/2`: Plug.ErrorHandler re-raises
      # after handling, and pinning which exception shape survives that
      # re-raise couples this test to a Plug implementation detail rather than
      # to our behaviour. The full request-level assertion is recorded as a
      # testing gap instead.
      http_conn = Plug.Test.conn(:get, "/api/v1/channels/1/messages")

      sent =
        CytaleWeb.Router.handle_errors(http_conn, %{
          kind: :error,
          reason: %Xandra.ConnectionError{
            action: "checkout from cluster Cytale.Repo",
            reason: {:cluster, :not_connected}
          },
          stack: stacktrace()
        })

      assert sent.status == 503
      assert Plug.Conn.get_resp_header(sent, "retry-after") == ["1"]
      assert Jason.decode!(sent.resp_body)["error"]["code"] == 50_301
    end

    test "the ROUTER owns the handler and the ENDPOINT does not" do
      # This pair is the whole point. At the endpoint, Plug.ErrorHandler is the
      # outermost wrapper and Phoenix.Endpoint.RenderErrors catches the
      # exception inside it, sends a 500, then re-raises — so Plug.ErrorHandler
      # sees `{:plug_conn, :sent}` and skips handle_errors/2. The callback
      # existed and was never invoked: the earlier `function_exported?/3`
      # assertion passed against dead code. Placement is the contract now.
      #
      # `Code.ensure_loaded?/1` first: `function_exported?/3` returns FALSE for a
      # module that is not yet loaded, so without this the assertion reports a
      # false negative on whichever module nothing else has referenced.
      assert Code.ensure_loaded?(CytaleWeb.Router)
      assert Code.ensure_loaded?(CytaleWeb.Endpoint)

      assert function_exported?(CytaleWeb.Router, :handle_errors, 2),
             "CytaleWeb.Router must own the error handler (inside Phoenix's render try)"

      refute function_exported?(CytaleWeb.Endpoint, :handle_errors, 2),
             "the endpoint must NOT own it — that placement is unreachable"
    end
  end
end
