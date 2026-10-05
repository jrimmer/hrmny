defmodule Cytale.Marks.Kind do
  @moduledoc """
  One kind of message mark (#54, KTD1/KD2).

  A mark is `(target message, kind, due_at?)`, and a kind is fully described by
  three properties plus two hooks — which is what keeps a new state from being
  a new feature. Adding a kind adds a module implementing this behaviour and a
  line in `Cytale.Marks.kinds/0`; it adds no table, no route family and no
  component tree (R3).

    * `visibility/0` — `:private` (the owner's alone: stored per user, never
      fanned out, never counted where another principal can see it — KD4) or
      `:shared` (a channel's list, e.g. pins; stored per channel).
    * `read_model_effect/0` — `:moves_floor` (a due mark makes its target
      unread through the read state's exclusive floor — the ONE unread
      behaviour, KD1) or `:none`.
    * `lifecycle/0` — `:one_shot` (consumed at its due time) or
      `:open_ended` (lives in a list until removed).
  """

  @type visibility :: :private | :shared
  @type effect :: :moves_floor | :none
  @type lifecycle :: :one_shot | :open_ended

  @doc "The kind's stable id — the `kind` column and the route segment."
  @callback id() :: String.t()
  @callback visibility() :: visibility()
  @callback read_model_effect() :: effect()
  @callback lifecycle() :: lifecycle()

  @doc """
  Whether a timed mark with this `due_at` is acceptable at `now` (both in
  unix milliseconds). An `:open_ended` kind receives `nil`.
  """
  @callback validate_due(due_ms :: integer() | nil, now_ms :: integer()) :: :ok | {:error, atom()}
end
