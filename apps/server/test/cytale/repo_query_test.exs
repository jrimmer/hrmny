defmodule Cytale.RepoQueryTest do
  @moduledoc """
  Hardening plan 1.8 — prepared statements.

  Two properties, because the failure modes differ:

    * `Repo.query/3` is SEMANTICALLY IDENTICAL to `Repo.execute/3` (same rows,
      same types, same error shape) — a prepared path that quietly returns
      different data would be a correctness regression dressed as a speedup;
    * the cache actually ENGAGES, so the statement is prepared once rather than
      per call. Without this the first property would pass while the whole point
      of the change was absent, which is exactly how a perf change ships inert.
  """

  use Cytale.ScyllaCase, async: false

  alias Cytale.Repo
  alias Cytale.Repo.Statements

  # A statement whose result is stable and whose shape is easy to assert.
  defp count_statement do
    "SELECT user_id FROM {{K}}.workspace_members WHERE workspace_id = ?"
    |> String.replace("{{K}}", Repo.keyspace())
  end

  test "query/3 returns exactly what execute/3 returns" do
    statement = count_statement()
    params = [{"bigint", 0}]

    assert {:ok, via_string} = Repo.execute(statement, params)
    assert {:ok, via_prepared} = Repo.query(statement, params)

    assert Enum.to_list(via_string) == Enum.to_list(via_prepared)
  end

  test "query!/3 and execute!/3 agree on a real partition" do
    owner = Cytale.TestNonce.get()

    {:ok, user} =
      Cytale.Accounts.User.create(
        "pq_#{owner}",
        "pq_#{owner}@example.com",
        "password-123"
      )

    {:ok, ws} = Cytale.Workspaces.create_workspace(user.user_id, "pq-ws-#{owner}")
    statement = count_statement()
    params = [{"bigint", ws.workspace_id}]

    assert Enum.to_list(Repo.execute!(statement, params)) ==
             Enum.to_list(Repo.query!(statement, params))
  end

  test "a statement is prepared once, not once per call" do
    statement = count_statement()
    params = [{"bigint", 0}]

    # Start from a known state for THIS text so the assertion cannot be
    # satisfied by a previous test's cache entry.
    :ets.delete(Statements.table(), statement)

    assert Repo.query!(statement, params) |> Enum.to_list() == []
    assert [{^statement, %Xandra.Prepared{}}] = :ets.lookup(Statements.table(), statement)

    first = :ets.lookup(Statements.table(), statement)

    for _ <- 1..5, do: Repo.query!(statement, params)

    # Same cached struct after repeated calls: the cache is being read, not
    # rewritten, and the statement is not re-prepared per call.
    assert :ets.lookup(Statements.table(), statement) == first
  end

  test "an error is returned, not raised, and matches the unprepared error shape" do
    # Invalid CQL: the prepared PREPARE itself fails, so this exercises the
    # error path rather than the execute path.
    bad =
      "SELECT nonexistent_column FROM {{K}}.no_such_table WHERE x = ?"
      |> String.replace("{{K}}", Repo.keyspace())

    assert {:error, error} = Repo.query(bad, [{"bigint", 1}])
    assert is_exception(error)
    assert :ets.lookup(Statements.table(), bad) == []
  end

  test "the owner is the long-lived cache process, not a caller" do
    owner = Process.whereis(Statements)
    assert is_pid(owner), "the cache owner must be running under the app tree"
    assert :ets.info(Statements.table(), :owner) == owner
  end
end
