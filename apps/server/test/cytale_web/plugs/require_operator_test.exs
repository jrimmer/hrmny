defmodule CytaleWeb.Plugs.RequireOperatorTest do
  @moduledoc """
  #170 — the environment always ADDS operators to the config file's list.

  The first boot writes /etc/cytale/config.json from the environment and the
  file wins afterwards, so the file froze `operator_user_ids` as it stood
  before any account existed: a fresh install could never name its first
  operator through `CYTALE_ADMIN_USER_IDS`. The env list is kept apart
  (`:env_operator_user_ids`) and merged in by every reader: the admin gate,
  `is_operator`, and the error alerter.

  DB-free: the plug is called directly on a bare conn.
  """

  use ExUnit.Case, async: false

  import Plug.Test, only: [conn: 2]
  import Plug.Conn, only: [assign: 3]

  alias CytaleWeb.Plugs.RequireOperator
  alias Cytale.Observability.ErrorAlerts

  setup do
    saved = for key <- [:operator_user_ids, :env_operator_user_ids], do: {key, Application.get_env(:cytale, key)}

    on_exit(fn ->
      for {key, value} <- saved do
        if is_nil(value), do: Application.delete_env(:cytale, key), else: Application.put_env(:cytale, key, value)
      end
    end)

    :ok
  end

  defp lists(file, env) do
    Application.put_env(:cytale, :operator_user_ids, file)
    Application.put_env(:cytale, :env_operator_user_ids, env)
  end

  defp gate(user_id) do
    conn(:get, "/api/v1/admin/config")
    |> assign(:current_user, %{user_id: user_id})
    |> RequireOperator.call([])
  end

  test "an operator named only by the environment passes, though the file's list is empty" do
    lists([], [101])
    refute gate(101).halted
    assert RequireOperator.operator_ids() == [101]
  end

  test "the environment never removes an operator the file names" do
    lists([202], [])
    refute gate(202).halted
  end

  test "the two lists merge without duplicates; anyone else is still refused" do
    lists([101, 202], [202, 303])
    assert Enum.sort(RequireOperator.operator_ids()) == [101, 202, 303]
    for id <- [101, 202, 303], do: refute(gate(id).halted)
    denied = gate(404)
    assert denied.halted
    assert denied.status == 403
  end

  test "both lists empty still denies everyone (fail-closed)" do
    lists([], [])
    assert gate(101).halted
  end

  test "a nil list (hand-edited config) reads as empty instead of crashing" do
    lists(nil, [101])
    assert RequireOperator.operator_ids() == [101]
  end

  test "the error alerter's admins include the environment's operators" do
    lists(["202"], [101])
    assert Enum.sort(ErrorAlerts.admins()) == [101, 202]
  end
end
