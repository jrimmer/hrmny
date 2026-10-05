defmodule Cytale.Marks.Kinds.Snooze do
  @moduledoc """
  The first mark kind (#54 v1): a private "remind me at T" on one message.

  Named `snooze` in code and storage; the action reads "Remind me…" (Slack's
  own snooze is a global do-not-disturb pause, so the product label says what
  this does). When it comes due the target becomes unread for its owner
  through the read state's exclusive floor — the same watermark the away-unread
  uses, set by assignment instead of by reading (KD1).
  """

  @behaviour Cytale.Marks.Kind

  # The furthest ahead a reminder may be set (R13's bounded growth): the row's
  # TTL follows its due time, so an unbounded horizon is unbounded storage.
  @horizon_ms 365 * 24 * 60 * 60 * 1000

  @impl true
  def id, do: "snooze"

  @impl true
  def visibility, do: :private

  @impl true
  def read_model_effect, do: :moves_floor

  @impl true
  def lifecycle, do: :one_shot

  @impl true
  def validate_due(nil, _now_ms), do: {:error, :due_at_required}
  def validate_due(due_ms, now_ms) when due_ms <= now_ms, do: {:error, :due_at_in_past}
  def validate_due(due_ms, now_ms) when due_ms - now_ms > @horizon_ms, do: {:error, :due_at_beyond_horizon}
  def validate_due(_due_ms, _now_ms), do: :ok

  @doc "The maximum horizon, for the API to report and tests to pin."
  def horizon_ms, do: @horizon_ms
end
