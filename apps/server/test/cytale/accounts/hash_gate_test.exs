defmodule Cytale.Accounts.HashGateTest do
  @moduledoc """
  Tier 3 (B) finding 8 — the Argon2 concurrency gate: at most N computations
  at once, a short queue, then `Busy` (a 503 + Retry-After at the router).
  """

  use Cytale.ScyllaCase, async: false

  alias Cytale.Accounts.{HashGate, User}

  @endpoint CytaleWeb.Endpoint

  setup do
    saved = Application.get_env(:cytale, :auth)
    on_exit(fn -> Application.put_env(:cytale, :auth, saved) end)
    :ok
  end

  defp put_auth(kv), do: Application.put_env(:cytale, :auth, Keyword.merge(Application.get_env(:cytale, :auth, []), kv))

  # Hold `n` slots from other processes until told to let go (and always on
  # test exit, so a failed test cannot leak held slots into the next one).
  defp hold_slots(n) do
    parent = self()

    holders =
      for _ <- 1..n do
        spawn(fn ->
          HashGate.run(fn ->
            send(parent, {:holding, self()})

            receive do
              :release -> :ok
            end
          end)
        end)
      end

    on_exit(fn -> release(holders) end)
    for _ <- holders, do: assert_receive({:holding, _}, 2_000)
    holders
  end

  defp release(holders), do: Enum.each(holders, &send(&1, :release))

  test "admits up to the limit, queues briefly, then raises Busy" do
    put_auth(argon2_max_concurrency: 2, argon2_queue_ms: 100)
    holders = hold_slots(2)

    started = System.monotonic_time(:millisecond)
    assert_raise HashGate.Busy, fn -> HashGate.run(fn -> :never end) end
    assert System.monotonic_time(:millisecond) - started >= 100

    release(holders)
    assert HashGate.run(fn -> :ran end) == :ran
  end

  test "a queued caller gets the slot when one frees inside the window" do
    put_auth(argon2_max_concurrency: 1, argon2_queue_ms: 2_000)
    [holder] = hold_slots(1)

    Process.send_after(holder, :release, 100)
    assert HashGate.run(fn -> :ran end) == :ran
  end

  test "a login while Argon2 is saturated is a 503 with Retry-After, not a wrong password" do
    name = "hg" <> Cytale.TestNonce.get() <> Integer.to_string(System.unique_integer([:positive]))
    {:ok, user} = User.create(name, name <> "@example.com", "password-123")

    put_auth(argon2_max_concurrency: 1, argon2_queue_ms: 50)
    holders = hold_slots(1)

    # The router's error handler SENDS the 503 and re-raises (Plug.ErrorHandler),
    # hence assert_error_sent.
    {503, headers, body} =
      assert_error_sent(503, fn ->
        build_conn()
        |> put_req_header("content-type", "application/json")
        |> post("/api/v1/auth/login", %{"identifier" => user.username, "password" => "password-123"})
      end)

    assert {"retry-after", "1"} in headers
    assert %{"error" => %{"key" => "service_busy"}} = Jason.decode!(body)

    # Not counted as a wrong password against the account's dam.
    assert Cytale.Accounts.AttemptGuard.check(Cytale.Accounts.AttemptGuard.identifier_key(user.username)) == :ok

    # The unknown-account branch's dummy verify is gated the same way: a full
    # gate is a 503 there too, never a 401 that would count against the dam.
    {503, _headers, _body} =
      assert_error_sent(503, fn ->
        build_conn()
        |> put_req_header("content-type", "application/json")
        |> post("/api/v1/auth/login", %{"identifier" => "nobody-" <> name, "password" => "password-123"})
      end)

    release(holders)
    put_auth(argon2_max_concurrency: 4, argon2_queue_ms: 2_000)

    ok =
      build_conn()
      |> put_req_header("content-type", "application/json")
      |> post("/api/v1/auth/login", %{"identifier" => user.username, "password" => "password-123"})

    assert ok.status == 200
  end
end
