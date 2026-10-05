defmodule Cytale.Marks.Metrics do
  @moduledoc """
  Mark outcome counters (#54 U8) — how many reminders are set, cancelled,
  fired and missed, made scrapeable.

  One family, `cytale_marks_total{kind, state}`, where `state` is `set`,
  `cancelled` (by the member), `fired` or `missed`. The counters are fed by
  the `[:cytale, :marks, state]` telemetry events that `Cytale.Marks` and the
  sweeper emit. Labels are the registered kind and the state ONLY — never a
  user, channel or message id (R2: an operator surface must not learn who
  marked what). A kind outside the registry is counted as `other`, so the
  label set stays bounded.

  The table is a tiny public ETS set owned by `Cytale.Telemetry.Stats` (always
  supervised), the `Cytale.Observability.ErrorAlerts.Metrics` shape: the
  `/metrics` scrape never calls into a process mailbox. With no table, the
  exposition renders nothing.
  """

  @table __MODULE__
  @states [:set, :cancelled, :fired, :missed]

  @doc "Create the table and attach the handlers (idempotent — the owner calls this at init)."
  @spec init() :: :ok
  def init do
    if :ets.whereis(@table) == :undefined do
      :ets.new(@table, [:set, :named_table, :public, write_concurrency: true])
    end

    :telemetry.detach({__MODULE__, :marks})

    :telemetry.attach_many(
      {__MODULE__, :marks},
      Enum.map(@states, &[:cytale, :marks, &1]),
      &__MODULE__.handle_event/4,
      nil
    )

    :ok
  end

  @doc false
  def handle_event([:cytale, :marks, state], measurements, meta, _config) do
    if :ets.whereis(@table) != :undefined do
      n = Map.get(measurements, :count, 1)
      key = {label_kind(meta[:kind]), state}
      :ets.update_counter(@table, key, {2, n}, {key, 0})
    end

    :ok
  end

  defp label_kind(kind) when is_binary(kind) do
    if Map.has_key?(Cytale.Marks.kinds(), kind), do: kind, else: "other"
  end

  defp label_kind(_), do: "other"

  @doc "`%{{kind, state} => count}` — every registered kind and state, zeros included."
  @spec snapshot() :: %{{String.t(), atom()} => non_neg_integer()}
  def snapshot do
    base = for kind <- Map.keys(Cytale.Marks.kinds()), state <- @states, into: %{}, do: {{kind, state}, 0}

    if :ets.whereis(@table) == :undefined do
      base
    else
      Enum.reduce(:ets.tab2list(@table), base, fn {key, n}, acc -> Map.put(acc, key, n) end)
    end
  end

  @doc "The family in Prometheus text format (appended to `/metrics`)."
  @spec exposition() :: String.t()
  def exposition do
    if :ets.whereis(@table) == :undefined do
      ""
    else
      rows =
        snapshot()
        |> Enum.sort_by(fn {{kind, state}, _} -> {kind, Enum.find_index(@states, &(&1 == state)) || 99} end)
        |> Enum.map_join("", fn {{kind, state}, n} ->
          ~s(cytale_marks_total{kind="#{kind}",state="#{state}"} #{n}\n)
        end)

      "# HELP cytale_marks_total Message marks by kind and outcome: set, cancelled by the member, fired, missed (#54).\n" <>
        "# TYPE cytale_marks_total counter\n" <> rows
    end
  end
end
