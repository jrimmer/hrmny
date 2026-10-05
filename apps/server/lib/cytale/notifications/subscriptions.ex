defmodule Cytale.Notifications.Subscriptions do
  @moduledoc """
  The web-push subscription store's read side and lifecycle (plan U6, R18/R19/R20).

  Registration already existed (`Workspaces.put_push_subscription/3`); what did
  not exist was any way to READ a member's subscriptions, which is why nothing
  could ever be sent, and no way to remove a dead one by push-service
  response, which is the quiet-failure trap: a browser that unsubscribes (or
  is uninstalled, or clears its storage) makes its endpoint start returning
  404/410, and a store that keeps it forever fails silently on every send
  without ever surfacing an error.

  ## A subscription is a security surface, not a preference

  The browser's `PushSubscription` lives in the browser's push manager, not in
  page storage — so clearing storage on sign-out does NOT remove it. A row
  that outlives the session that created it would deliver the previous
  member's notifications to a signed-out browser, which is why revocation
  attaches to session revocation and account deletion (R19/R20) and not only
  to the client's own unsubscribe.

  ## Target type

  Rows carry a `target_type` so a mobile device token is a second kind of
  target rather than a second table (R14). Only `web` has a sender today;
  `mobile` rows are storable and selectable, and the dispatcher reports them
  as not-yet-delivered rather than erroring.
  """

  alias Cytale.Repo

  @target_web "web"
  @target_mobile "mobile"

  @type subscription :: %{
          endpoint: String.t(),
          keys: String.t(),
          target_type: String.t()
        }

  @doc "The target type for browser push subscriptions."
  @spec target_web() :: String.t()
  def target_web, do: @target_web

  @doc "The target type for mobile device tokens (no sender yet)."
  @spec target_mobile() :: String.t()
  def target_mobile, do: @target_mobile

  @doc "Every subscription a member holds, across all target types."
  @spec list_for_user(integer()) :: [subscription()]
  def list_for_user(user_id) when is_integer(user_id) do
    Repo.execute!(
      "SELECT endpoint, keys_blob, target_type FROM {{K}}.push_subscriptions WHERE user_id = ?",
      [{"bigint", user_id}]
    )
    |> Enum.map(fn row ->
      %{
        endpoint: row["endpoint"],
        keys: row["keys_blob"],
        target_type: row["target_type"] || @target_web
      }
    end)
  end

  @doc """
  Every stored subscription across the given members, grouped by member.

  ONE query for a whole audience rather than a read per recipient: the
  notification decision runs per message, and a per-recipient read would
  multiply the message path by the workspace size. Returns a map so the caller
  does not re-scan the list per member.

  An empty input short-circuits: an empty `IN ()` is invalid CQL and a wasted
  round trip.
  """
  @spec by_user_ids([integer()]) :: %{integer() => [subscription()]}
  def by_user_ids([]), do: %{}

  def by_user_ids(user_ids) when is_list(user_ids) do
    placeholders = Enum.map_join(user_ids, ", ", fn _ -> "?" end)

    Repo.execute!(
      "SELECT user_id, endpoint, keys_blob, target_type FROM {{K}}.push_subscriptions WHERE user_id IN (#{placeholders})",
      Enum.map(user_ids, fn id -> {"bigint", id} end)
    )
    |> Enum.reduce(%{}, fn row, acc ->
      entry = %{
        endpoint: row["endpoint"],
        keys: row["keys_blob"],
        target_type: row["target_type"] || @target_web
      }

      Map.update(acc, row["user_id"], [entry], &[entry | &1])
    end)
  end

  @doc """
  Remove one subscription by its endpoint.

  The endpoint is the natural key: it is what the push service reports as
  gone, so removal must be addressable from a send failure without the caller
  having needed the row's hash.
  """
  @spec delete_by_endpoint(integer(), String.t()) :: :ok
  def delete_by_endpoint(user_id, endpoint)
      when is_integer(user_id) and is_binary(endpoint) do
    Repo.execute!(
      "DELETE FROM {{K}}.push_subscriptions WHERE user_id = ? AND subscription_hash = ?",
      [{"bigint", user_id}, {"text", hash(endpoint)}]
    )

    :ok
  end

  @doc """
  Remove every subscription a member holds.

  The lifecycle hook: revoking all sessions and deleting an account both mean
  "nothing of this member's stays live on any device" (R19).
  """
  @spec delete_all_for_user(integer()) :: :ok
  def delete_all_for_user(user_id) when is_integer(user_id) do
    Repo.execute!(
      "DELETE FROM {{K}}.push_subscriptions WHERE user_id = ?",
      [{"bigint", user_id}]
    )

    :ok
  end

  @doc "The sha256 endpoint hash the table keys on."
  @spec hash(String.t()) :: String.t()
  def hash(endpoint), do: Base.encode16(:crypto.hash(:sha256, endpoint), case: :lower)
end
