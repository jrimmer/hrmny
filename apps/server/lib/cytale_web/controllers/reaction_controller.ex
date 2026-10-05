defmodule CytaleWeb.ReactionController do
  @moduledoc """
  Unicode-emoji message reactions — the native surface (Discord-shaped
  routes):

    * `PUT    /channels/{id}/messages/{mid}/reactions/{emoji}/@me` — add own (204)
    * `DELETE /channels/{id}/messages/{mid}/reactions/{emoji}/@me` — remove own (204)
    * `GET    /channels/{id}/messages/{mid}/reactions/{emoji}` — users page
    * `DELETE /channels/{id}/messages/{mid}/reactions/{emoji}` — clear emoji (`manage_messages`)
    * `DELETE /channels/{id}/messages/{mid}/reactions` — clear all (`manage_messages`)
    * `DELETE /channels/{id}/messages/{mid}/reactions/{emoji}/{user_id}` — remove another's (`manage_messages`)

  Gates: add additionally needs ADD_REACTIONS (403 when visible but denied);
  add/remove-own/list need channel VIEW through the principal-rights
  resolver — the SAME uniform channel-gate seam the typing route uses
  (parent fallback for machine principals, restrictions applied; every miss
  is the identical 404 anti-enumeration shape). The manage routes check the
  `manage_messages` bit against the gate's resolved bitfield (403 for a
  visible-but-unpermitted caller). A missing message is the 404 oracle
  (`message_not_found`), consistent with the channel gate.

  Events ride the `Cytale.Publish` seam (channel-keyed, the message fan-out
  precedent) on every state-CHANGING operation only — the idempotent add /
  no-op remove re-answers 204 with NO event and NO counter move. Per
  Discord: clearing one emoji emits one `MessageReactionRemove` PER REMOVED
  USER; the full clear emits a single `MessageReactionRemoveAll`.

  The emoji arrives URL-encoded; Phoenix decodes the path param before the
  controller sees it (validation runs on the decoded text).
  """

  use CytaleWeb, :controller

  alias Cytale.Messages
  alias Cytale.Messages.Reactions
  alias Cytale.Permissions.Bitfield
  alias Cytale.Publish
  alias Cytale.Snowflake
  alias CytaleWeb.Compat.{Authorize, MessageCodec}
  import CytaleWeb.API.Params, only: [parse_limit: 2, snowflake_opt: 1]
  import CytaleWeb.API.Error, only: [error: 4]

  @doc "PUT /channels/{id}/messages/{mid}/reactions/{emoji}/@me — add own reaction, 204."
  def add(conn, %{"channel_id" => cid, "message_id" => mid, "emoji" => emoji}) do
    %{user_id: user_id} = conn.assigns.current_user

    with {:ok, channel_id} <- Snowflake.parse(cid),
         {:ok, message_id} <- Snowflake.parse(mid),
         {:ok, _channel, bits} <- Authorize.channel_gate(conn.assigns.current_user, channel_id),
         {:permitted, true} <- {:permitted, Bitfield.has?(bits, :add_reactions)},
         msg when msg != nil <- Messages.get_message(channel_id, message_id),
         :ok <- Reactions.add(channel_id, message_id, user_id, emoji) do
      publish_reaction(
        conn,
        channel_id,
        {"MessageReactionAdd", reaction_payload(channel_id, message_id, user_id, emoji)}
      )
    else
      # Idempotent re-add: 204, NO event, NO counter move.
      :noop ->
        send_resp(conn, 204, "")

      # Visible channel, ADD_REACTIONS denied (an overwrite, a read-only
      # agent grant): 403, like the other visible-but-unpermitted gates.
      {:permitted, false} ->
        error(conn, 403, "forbidden", "You do not have permission to add reactions in this channel.")

      {:error, :unknown_channel} ->
        error(conn, 404, "channel_not_found", "No channel with that id")

      {:error, :invalid_emoji} ->
        error(conn, 400, "validation_failed", "emoji must be 1-14 bytes of Unicode emoji text without colons")

      {:error, :too_many_emojis} ->
        error(conn, 400, "too_many_emojis", "A message may carry at most #{Reactions.max_emojis()} distinct emojis")

      _ ->
        error(conn, 404, "message_not_found", "No message with that id")
    end
  end

  @doc "DELETE /channels/{id}/messages/{mid}/reactions/{emoji}/@me — remove own reaction, 204."
  def remove_own(conn, %{"channel_id" => cid, "message_id" => mid, "emoji" => emoji}) do
    %{user_id: user_id} = conn.assigns.current_user

    with {:ok, channel_id} <- Snowflake.parse(cid),
         {:ok, message_id} <- Snowflake.parse(mid),
         {:ok, _channel, _bits} <- Authorize.channel_gate(conn.assigns.current_user, channel_id),
         msg when msg != nil <- Messages.get_message(channel_id, message_id),
         :ok <- Reactions.remove(channel_id, message_id, user_id, emoji) do
      publish_reaction(
        conn,
        channel_id,
        {"MessageReactionRemove", reaction_payload(channel_id, message_id, user_id, emoji)}
      )
    else
      :noop ->
        send_resp(conn, 204, "")

      {:error, :unknown_channel} ->
        error(conn, 404, "channel_not_found", "No channel with that id")

      {:error, :invalid_emoji} ->
        error(conn, 400, "validation_failed", "emoji must be 1-14 bytes of Unicode emoji text without colons")

      _ ->
        error(conn, 404, "message_not_found", "No message with that id")
    end
  end

  @doc """
  GET /channels/{id}/messages/{mid}/reactions/{emoji}?limit=&after= — the
  users who reacted, ascending by user_id (member-gated read; limit cap 100,
  `after` an exclusive user_id cursor). `next_after` is nil on the last page.
  """
  def list(conn, %{"channel_id" => cid, "message_id" => mid, "emoji" => emoji} = params) do
    with {:ok, channel_id} <- Snowflake.parse(cid),
         {:ok, message_id} <- Snowflake.parse(mid),
         {:ok, _channel, _bits} <- Authorize.channel_gate(conn.assigns.current_user, channel_id),
         msg when msg != nil <- Messages.get_message(channel_id, message_id) do
      {user_ids, next_after} =
        Reactions.list_users(channel_id, message_id, emoji,
          limit: parse_limit(params["limit"], default: 100, cap: 100),
          after: snowflake_opt(params["after"])
        )

      users = Enum.map(user_ids, fn user_id -> user_id |> MessageCodec.resolve_author() |> elem(0) end)

      json(conn, %{"users" => users, "next_after" => next_after && Integer.to_string(next_after)})
    else
      {:error, :unknown_channel} -> error(conn, 404, "channel_not_found", "No channel with that id")
      _ -> error(conn, 404, "message_not_found", "No message with that id")
    end
  end

  @doc """
  DELETE /channels/{id}/messages/{mid}/reactions/{emoji} — clear ONE emoji
  for everyone (`manage_messages`). One `MessageReactionRemove` per removed
  user (Discord's behavior — REMOVE_ALL is only for the full clear).
  """
  def clear_emoji(conn, %{"channel_id" => cid, "message_id" => mid, "emoji" => emoji}) do
    with {:ok, channel_id} <- Snowflake.parse(cid),
         {:ok, message_id} <- Snowflake.parse(mid),
         {:ok, _channel, bits} <- Authorize.channel_gate(conn.assigns.current_user, channel_id),
         :ok <- Bitfield.require_bit(bits, :manage_messages),
         msg when msg != nil <- Messages.get_message(channel_id, message_id),
         {:ok, removed} <- Reactions.remove_others(channel_id, message_id, emoji) do
      Enum.each(removed, fn user_id ->
        publish_reaction(
          conn,
          channel_id,
          {"MessageReactionRemove", reaction_payload(channel_id, message_id, user_id, emoji)}
        )
      end)

      send_resp(conn, 204, "")
    else
      {:error, :missing_permissions} ->
        error(conn, 403, "forbidden", "Managing reactions requires manage_messages.")

      {:error, :unknown_channel} ->
        error(conn, 404, "channel_not_found", "No channel with that id")

      {:error, :invalid_emoji} ->
        error(conn, 400, "validation_failed", "emoji must be 1-14 bytes of Unicode emoji text without colons")

      _ ->
        error(conn, 404, "message_not_found", "No message with that id")
    end
  end

  @doc """
  DELETE /channels/{id}/messages/{mid}/reactions — clear EVERY reaction
  (`manage_messages`). Emits ONE `MessageReactionRemoveAll` (only when
  reactions existed — a no-op sweep stays silent).
  """
  def clear_all(conn, %{"channel_id" => cid, "message_id" => mid}) do
    with {:ok, channel_id} <- Snowflake.parse(cid),
         {:ok, message_id} <- Snowflake.parse(mid),
         {:ok, _channel, bits} <- Authorize.channel_gate(conn.assigns.current_user, channel_id),
         :ok <- Bitfield.require_bit(bits, :manage_messages),
         msg when msg != nil <- Messages.get_message(channel_id, message_id) do
      unless Reactions.summary(channel_id, message_id) == [] do
        :ok = Reactions.remove_all(channel_id, message_id)

        publish_reaction(conn, channel_id, {"MessageReactionRemoveAll", remove_all_payload(channel_id, message_id)})
      end

      send_resp(conn, 204, "")
    else
      {:error, :missing_permissions} -> error(conn, 403, "forbidden", "Managing reactions requires manage_messages.")
      {:error, :unknown_channel} -> error(conn, 404, "channel_not_found", "No channel with that id")
      _ -> error(conn, 404, "message_not_found", "No message with that id")
    end
  end

  @doc """
  DELETE /channels/{id}/messages/{mid}/reactions/{emoji}/{user_id} — remove
  ANOTHER principal's reaction (`manage_messages`). 204 idempotent (a row
  that never existed is a silent no-op, Discord's shape).
  """
  def remove_user(conn, %{"channel_id" => cid, "message_id" => mid, "emoji" => emoji, "user_id" => uid}) do
    with {:ok, channel_id} <- Snowflake.parse(cid),
         {:ok, message_id} <- Snowflake.parse(mid),
         {:ok, target_user_id} <- Snowflake.parse(uid),
         {:ok, _channel, bits} <- Authorize.channel_gate(conn.assigns.current_user, channel_id),
         :ok <- Bitfield.require_bit(bits, :manage_messages),
         msg when msg != nil <- Messages.get_message(channel_id, message_id),
         :ok <- Reactions.remove_user_reaction(channel_id, message_id, target_user_id, emoji) do
      publish_reaction(
        conn,
        channel_id,
        {"MessageReactionRemove", reaction_payload(channel_id, message_id, target_user_id, emoji)}
      )
    else
      :noop ->
        send_resp(conn, 204, "")

      {:error, :missing_permissions} ->
        error(conn, 403, "forbidden", "Managing reactions requires manage_messages.")

      {:error, :unknown_channel} ->
        error(conn, 404, "channel_not_found", "No channel with that id")

      {:error, :invalid_emoji} ->
        error(conn, 400, "validation_failed", "emoji must be 1-14 bytes of Unicode emoji text without colons")

      _ ->
        error(conn, 404, "message_not_found", "No message with that id")
    end
  end

  # -- payloads (public: the wire tests build the exact frames the seam emits) ----

  @doc """
  The native `MessageReactionAdd` / `MessageReactionRemove` payload: channel,
  message, and user ids as DECIMAL STRINGS plus the raw emoji text.
  """
  @spec reaction_payload(integer(), integer(), integer(), String.t()) :: map()
  def reaction_payload(channel_id, message_id, user_id, emoji) do
    %{
      "channel_id" => Integer.to_string(channel_id),
      "message_id" => Integer.to_string(message_id),
      "user_id" => Integer.to_string(user_id),
      "emoji" => emoji
    }
  end

  @doc "The native `MessageReactionRemoveAll` payload (identity fields only)."
  @spec remove_all_payload(integer(), integer()) :: map()
  def remove_all_payload(channel_id, message_id) do
    %{
      "channel_id" => Integer.to_string(channel_id),
      "message_id" => Integer.to_string(message_id)
    }
  end

  # -- helpers -------------------------------------------------------------------

  defp publish_reaction(conn, channel_id, event) do
    Publish.publish(channel_id, event)
    send_resp(conn, 204, "")
  end

  # Discord's reactions-users ceiling: default 100, cap 100.
end
