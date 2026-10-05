defmodule Cytale.Notifications.Resolver do
  @moduledoc """
  The inheritance walk and the permission question (plan U3, R6/R7/R8/R9).

  Two jobs that must be done by the same code, because they are the same
  answer asked two ways:

    * `resolve/1` — what is this member's effective level for this entity, and
      **which layer decided it**.
    * `allows?/2` — may this event reach the member at that level, and how
      loudly.

  Returning `decided_by` alongside the level is what makes the setting legible.
  The settings surface renders it so an override says which layer it is
  overriding, and the explainer renders it so a member can ask why a message
  did or did not reach them. A readout computed separately from the decision
  would drift, which is how a cascade becomes unpredictable again.

  ## Most specific wins

  Walk from the most specific layer the caller supplied to the least: thread →
  channel → workspace → account. **An absent layer is skipped, not
  terminating** — a member with a workspace setting and nothing at channel
  level gets the workspace level, decided by the workspace. The account layer
  never has an absent value: it falls back to `default_level/0`, which is a
  product default rather than a stored one.

  ## The default

  `"mentions"` — deliberately the middle of the ladder. Discord's
  server-creation default is "all messages", the documented cause of new-member
  notification fatigue, while its post-reset default is mentions-only, so the
  two disagree. A member should be reachable about things addressed to them
  without being reachable about everything.
  """

  alias Cytale.Notifications.{Participations, Preferences}

  @default_level "mentions"

  @typedoc """
  An effective level plus its provenance. `explicit?` is false when the member
  never set this layer, which is what lets a surface distinguish "you chose
  mentions here" from "mentions is what reached you".
  """
  @type resolved :: %{
          level: Preferences.level(),
          decided_by: Preferences.scope(),
          explicit?: boolean()
        }

  @typedoc "What kind of event is being considered."
  @type event_kind :: :message | :dm | :reply_to_me | :mentions_me

  @typedoc "The event facts the permission question reads."
  @type event_facts :: %{
          kind: event_kind(),
          mentions_me: boolean()
        }

  @doc "The level an unconfigured member receives."
  @spec default_level() :: Preferences.level()
  def default_level, do: @default_level

  @doc """
  Resolve a member's effective level.

  Options: `:user_id` (required), `:workspace_id`, `:channel_id`,
  `:thread_id`, `:account_entity`, and `:preferences`. Supplying fewer layers
  is normal — a direct message has no workspace, a channel-level question has
  no thread.

  `:preferences` lets a caller that already holds the member's override map
  (the fan-out path, which decides per recipient) skip the storage read. When
  omitted the map is loaded here, which is the right choice for a one-off
  question such as the settings surface asking what a channel resolves to.
  """
  @spec resolve(keyword()) :: resolved()
  def resolve(opts) do
    user_id = Keyword.fetch!(opts, :user_id)
    account_entity = Keyword.get(opts, :account_entity, Preferences.account_entity())
    preferences = Keyword.get_lazy(opts, :preferences, fn -> Preferences.all(user_id) end)

    candidates =
      [
        {:thread, Keyword.get(opts, :thread_id)},
        {:channel, Keyword.get(opts, :channel_id)},
        {:workspace, Keyword.get(opts, :workspace_id)}
      ]
      |> Enum.reject(fn {_scope, entity_id} -> is_nil(entity_id) end)

    resolved =
      case Enum.find_value(candidates, fn {scope, entity_id} ->
             case Map.fetch(preferences, %{scope: scope, entity_id: entity_id}) do
               {:ok, level} -> {scope, level}
               :error -> nil
             end
           end) do
        {scope, level} ->
          %{level: level, decided_by: scope, explicit?: true}

        nil ->
          case Map.fetch(preferences, %{scope: :account, entity_id: account_entity}) do
            {:ok, level} -> %{level: level, decided_by: :account, explicit?: true}
            :error -> %{level: @default_level, decided_by: :account, explicit?: false}
          end
      end

    sweep_participation(user_id, opts, resolved)
  end

  # R11's sweep: a member who has posted where an event happened hears about a
  # reply there, even if they muted it. Discord and Slack both stop at the mute
  # and drop the reply with no signal, which is the most-cited "I missed
  # something addressed to me" cause.
  #
  # It RAISES only. A member who chose "all activity" keeps it, and one who
  # chose "mentions" keeps that — the sweep exists to undo a broad mute's
  # collateral damage, not to overrule a deliberate level.
  #
  # It raises to "all", not to "mentions", and that is the whole point of the
  # rule: a mute is a statement about a channel, not about being addressed, so
  # what it must stop eating is an ordinary reply from a conversation the
  # member took part in. Raising only as far as mentions would still drop
  # exactly the reply this exists to deliver.
  defp sweep_participation(user_id, opts, %{level: "mute"} = resolved) do
    if participated_where?(user_id, opts) do
      %{resolved | level: "all", decided_by: :participation}
    else
      resolved
    end
  end

  defp sweep_participation(_user_id, _opts, resolved), do: resolved

  # A thread mute is lifted by participation in the thread OR in its parent
  # channel: a member who posted in the channel has plainly taken part, and
  # making them re-earn it thread by thread would reintroduce the same silent
  # miss one level down.
  defp participated_where?(user_id, opts) do
    [Keyword.get(opts, :thread_id), Keyword.get(opts, :channel_id)]
    |> Enum.reject(&is_nil/1)
    |> Enum.any?(fn entity_id -> Participations.participated?(user_id, entity_id) end)
  end

  @doc """
  What a level permits for one event.

  `:push` is "tell the member on a device they are not looking at", `:badge`
  is "show it waiting for them", `:none` is "do not surface it at all". The
  badge tier exists so a member who wants a channel visible without being
  interrupted can have exactly that — it is not a degraded push.
  """
  @spec allows?(Preferences.level() | nil, event_facts()) :: :push | :badge | :none
  def allows?(level, facts)

  def allows?("mute", _facts), do: :none

  # A direct message is addressed to the member by construction, so it is
  # never demoted for lacking a mention token.
  def allows?(_level, %{kind: :dm}), do: :push

  def allows?("all", _facts), do: :push

  def allows?("mentions", %{mentions_me: true}), do: :push
  def allows?("mentions", %{kind: :reply_to_me}), do: :push
  def allows?("mentions", _facts), do: :badge

  def allows?(_level, _facts), do: :badge
end
