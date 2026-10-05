defmodule Cytale.Marks.MetricsTest do
  @moduledoc """
  #54 U8 — the mark outcome counters: set / cancelled / fired / missed by kind,
  labels carrying no identifier, exposed on `/metrics`.
  """

  use Cytale.ScyllaCase, async: false

  alias Cytale.Accounts.User
  alias Cytale.Marks
  alias Cytale.Marks.Metrics
  alias Cytale.Messages
  alias Cytale.Workspaces

  defp run_unique(base), do: base <> "r" <> Cytale.TestNonce.get()

  defp delta(before, key), do: Map.fetch!(Metrics.snapshot(), key) - Map.fetch!(before, key)

  test "set, re-set and cancel are counted by kind; the telemetry carries the kind only" do
    {:ok, owner} = User.create(run_unique("mm"), run_unique("mm@example.com"), "password-123")
    {:ok, ws} = Workspaces.create_workspace(owner.user_id, run_unique("mm-ws"))
    {:ok, ch} = Workspaces.create_channel(ws.workspace_id, run_unique("mm-ch"))

    {:ok, msg} =
      Messages.create_message(%{channel_id: ch.channel_id, author_id: owner.user_id, content: "x", thread_id: nil})

    ref = make_ref()
    me = self()

    :telemetry.attach_many(
      {__MODULE__, ref},
      [[:cytale, :marks, :set], [:cytale, :marks, :cancelled]],
      fn event, measurements, meta, _ -> send(me, {:mark_event, event, measurements, meta}) end,
      nil
    )

    on_exit(fn -> :telemetry.detach({__MODULE__, ref}) end)

    before = Metrics.snapshot()
    now = System.system_time(:millisecond)
    {:ok, _} = Marks.set(owner.user_id, "snooze", msg, now + 60_000, now)
    {:ok, _} = Marks.set(owner.user_id, "snooze", msg, now + 120_000, now)
    :ok = Marks.cancel(owner.user_id, "snooze", msg.id, now)
    # A second cancel is :not_found and counts nothing.
    {:error, :not_found} = Marks.cancel(owner.user_id, "snooze", msg.id, now)

    assert delta(before, {"snooze", :set}) >= 2
    assert delta(before, {"snooze", :cancelled}) >= 1

    assert_receive {:mark_event, [:cytale, :marks, :set], %{count: 1}, meta}
    # R2: the kind, and nothing that names a user, channel or message.
    assert meta == %{kind: "snooze"}
    assert_receive {:mark_event, [:cytale, :marks, :cancelled], %{count: 1}, %{kind: "snooze"}}
  end

  test "an unregistered kind is counted as `other`, keeping the label set bounded" do
    before = Map.get(Metrics.snapshot(), {"other", :fired}, 0)
    :telemetry.execute([:cytale, :marks, :fired], %{count: 1}, %{kind: "user-123", reason: :due})
    assert Map.get(Metrics.snapshot(), {"other", :fired}) == before + 1
    refute Metrics.exposition() =~ "user-123"
  end

  test "the family is on the metrics exposition, every registered kind and state present" do
    text = CytaleWeb.MetricsController.exposition()
    assert text =~ "# TYPE cytale_marks_total counter"

    for state <- ~w(set cancelled fired missed) do
      assert text =~ ~s(cytale_marks_total{kind="snooze",state="#{state}"} )
    end
  end
end
