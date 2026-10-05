defmodule Cytale.MarksTest do
  @moduledoc """
  #54 U2 — the mark primitive: the kind registry, the two stores, and every
  lifecycle transition the plan's state diagram names.
  """

  use Cytale.ScyllaCase, async: false

  alias Cytale.Marks
  alias Cytale.Marks.Kinds.Snooze
  alias Cytale.Messages

  @minute 60_000
  @hour 60 * @minute

  defp message!(opts \\ []) do
    {:ok, m} =
      Messages.create_message(%{
        channel_id: Keyword.get(opts, :channel_id, Cytale.Snowflake.next()),
        author_id: Cytale.Snowflake.next(),
        content: "a message worth coming back to",
        thread_id: Keyword.get(opts, :thread_id)
      })

    m
  end

  defp user, do: Cytale.Snowflake.next()
  defp now, do: System.system_time(:millisecond)

  defp due_row(mark) do
    "SELECT state, user_id, target_id FROM {{K}}.message_marks_by_due WHERE due_bucket = ? AND due_at = ? AND mark_id = ?"
    |> Cytale.Repo.execute!([
      {"bigint", Marks.due_bucket(DateTime.to_unix(mark.due_at, :millisecond))},
      {"timestamp", mark.due_at},
      {"bigint", mark.mark_id}
    ])
    |> Enum.to_list()
  end

  describe "the kind registry" do
    test "snooze is the one v1 kind: private, moves the floor, one-shot" do
      assert {:ok, Snooze} = Marks.kind("snooze")
      assert Snooze.visibility() == :private
      assert Snooze.read_model_effect() == :moves_floor
      assert Snooze.lifecycle() == :one_shot
    end

    test "an unknown kind is refused and never reaches storage" do
      u = user()
      assert {:error, :unknown_kind} = Marks.set(u, "pin-everything", message!(), now() + @hour)
      assert Marks.list_pending(u) == []
    end
  end

  describe "set / get / list" do
    test "a mark round-trips with kind, channel, target and due time, and lists as pending" do
      u = user()
      m = message!()
      due = now() + @hour

      assert {:ok, mark} = Marks.set(u, "snooze", m, due)
      assert mark.kind == "snooze"
      assert mark.channel_id == m.channel_id
      assert mark.target_id == m.id
      assert DateTime.to_unix(mark.due_at, :millisecond) == due
      assert mark.state == "pending"

      assert [listed] = Marks.list_pending(u)
      assert listed.target_id == m.id
      assert [%{"state" => "pending", "user_id" => ^u}] = due_row(mark)
    end

    test "a second mark on the same target RE-SETS it: one row, new due, same identity" do
      u = user()
      m = message!()
      {:ok, first} = Marks.set(u, "snooze", m, now() + @hour)
      {:ok, second} = Marks.set(u, "snooze", m, now() + 3 * @hour)

      assert [only] = Marks.list_pending(u)
      assert only.due_at == second.due_at
      assert second.mark_id == first.mark_id
      # The superseded index row is marked, and the new one is pending.
      assert [%{"state" => "cancelled"}] = due_row(first)
      assert [%{"state" => "pending"}] = due_row(second)
    end

    test "two users' marks due in the same minute both survive" do
      m = message!()
      due = now() + @hour
      {a, b} = {user(), user()}
      {:ok, ma} = Marks.set(a, "snooze", m, due)
      {:ok, mb} = Marks.set(b, "snooze", m, due)
      assert ma.mark_id != mb.mark_id
      assert [_] = due_row(ma)
      assert [_] = due_row(mb)
    end

    test "privacy shape: a list is only ever the caller's own" do
      m = message!()
      {a, b} = {user(), user()}
      {:ok, _} = Marks.set(a, "snooze", m, now() + @hour)
      assert Marks.list_pending(b) == []
    end
  end

  describe "refusals — each without a row" do
    test "past, beyond the horizon, a thread-reply target" do
      u = user()
      t = now()

      assert {:error, :due_at_in_past} = Marks.set(u, "snooze", message!(), t - 1, t)
      assert {:error, :due_at_in_past} = Marks.set(u, "snooze", message!(), t, t)
      assert {:error, :due_at_beyond_horizon} = Marks.set(u, "snooze", message!(), t + Snooze.horizon_ms() + 1, t)
      assert {:error, :due_at_required} = Marks.set(u, "snooze", message!(), nil, t)

      reply = message!(thread_id: Cytale.Snowflake.next())
      assert {:error, :thread_target} = Marks.set(u, "snooze", reply, t + @hour, t)

      assert Marks.list_pending(u) == []
    end

    test "the horizon boundary itself is accepted" do
      t = now()
      assert {:ok, _} = Marks.set(user(), "snooze", message!(), t + Snooze.horizon_ms(), t)
    end

    test "the per-user cap refuses a NEW mark but never a re-set" do
      u = user()
      cap = Marks.max_pending_per_user()

      # Fill the cap cheaply: the cap reads the owner's pending rows, so seed
      # them straight into the owner's partition.
      for i <- 1..cap do
        Cytale.Repo.execute!(
          "INSERT INTO {{K}}.message_marks_by_user (user_id, kind, target_id, channel_id, mark_id, due_at, state) VALUES (?, 'snooze', ?, 1, ?, ?, 'pending')",
          [{"bigint", u}, {"bigint", i}, {"bigint", i}, {"timestamp", DateTime.from_unix!(now() + @hour, :millisecond)}]
        )
      end

      assert {:error, :cap_reached} = Marks.set(u, "snooze", message!(), now() + @hour)

      # Re-setting one of the existing marks is not a new mark.
      existing = %{id: 1, channel_id: 1, thread_id: nil}
      assert {:ok, _} = Marks.set(u, "snooze", existing, now() + 2 * @hour)
    end
  end

  describe "cancel" do
    test "a cancelled mark leaves the pending list, its index row is cancelled, and a second cancel is not_found" do
      u = user()
      m = message!()
      {:ok, mark} = Marks.set(u, "snooze", m, now() + @hour)

      assert :ok = Marks.cancel(u, "snooze", m.id)
      assert Marks.list_pending(u) == []
      assert Marks.get(u, "snooze", m.id).state == "cancelled"
      assert [%{"state" => "cancelled"}] = due_row(mark)
      assert {:error, :not_found} = Marks.cancel(u, "snooze", m.id)
    end

    test "a cancelled mark set again is pending again (the same row, a fresh due)" do
      u = user()
      m = message!()
      {:ok, _} = Marks.set(u, "snooze", m, now() + @hour)
      :ok = Marks.cancel(u, "snooze", m.id)
      assert {:ok, %{state: "pending"}} = Marks.set(u, "snooze", m, now() + 2 * @hour)
    end
  end

  describe "TTLs" do
    test "the index row outlives its due time by the sweep interval plus the lookback" do
      u = user()
      due = now() + @hour
      {:ok, mark} = Marks.set(u, "snooze", message!(), due)

      [%{"ttl(state)" => ttl}] =
        "SELECT TTL(state) FROM {{K}}.message_marks_by_due WHERE due_bucket = ? AND due_at = ? AND mark_id = ?"
        |> Cytale.Repo.execute!([
          {"bigint", Marks.due_bucket(due)},
          {"timestamp", mark.due_at},
          {"bigint", mark.mark_id}
        ])
        |> Enum.to_list()

      assert ttl * 1000 >= @hour + Marks.sweep_interval_ms() + Marks.lookback_ms() - 5_000
    end

    test "a transition on an OVERDUE mark still writes a positive TTL (no raise)" do
      u = user()
      t = now()
      {:ok, mark} = Marks.set(u, "snooze", message!(), t + @minute, t)
      # Transition as if long after the due time.
      assert :ok = Marks.transition(mark, "missed", t + 30 * 24 * @hour)
      assert Marks.get(u, "snooze", mark.target_id).state == "missed"
    end
  end
end
