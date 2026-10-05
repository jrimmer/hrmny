defmodule CytaleWeb.Compat.ReactionsController do
  @moduledoc """
  The compat reaction subset (Discord-shaped, mounted under BOTH `/api/v10`
  and `/api`): the six Discord reaction routes over the SAME
  `Cytale.Messages.Reactions` layer and the SAME event seam the native
  controller uses — realtime consumers see one projection (KD2 merge
  parity).

    * `PUT    /channels/{id}/messages/{mid}/reactions/{emoji}/@me` — 204
    * `DELETE /channels/{id}/messages/{mid}/reactions/{emoji}/@me` — 204
    * `GET    /channels/{id}/messages/{mid}/reactions/{emoji}` — BARE array of user objects
    * `DELETE /channels/{id}/messages/{mid}/reactions/{emoji}/{user_id}` — 204 (`manage_messages`)
    * `DELETE /channels/{id}/messages/{mid}/reactions/{emoji}` — 204 (`manage_messages`)
    * `DELETE /channels/{id}/messages/{mid}/reactions` — 204 (`manage_messages`)

  ## Why these six actions are not merged with the native controller (plan 3.9)

  Hardening plan 3.9 read the six routes here as a re-implementation of the native
  controller's six and proposed one controller plus a dialect renderer for the
  204 / `{code, message}` differences. Measured against the code, the difference is
  NOT the response shape: the two action bodies differ on 255 lines, because

    * the SCOPE resolution differs by design — the compat surface accepts a thread
      id on every route (Discord treats threads as channels) and resolves it through
      `Compat.Authorize.scope/2`'s parent-anchored fallback, while the native
      controller gates the channel id directly;
    * the ERROR vocabulary differs by contract — Discord's `10003`/`10008`/`50001`
      codes via `Errors.*` against the native `{error: {key, code, message}}`
      envelope.

  What CAN be shared already is: the domain calls (`Cytale.Messages.Reactions`), the
  event payloads (the native controller's `reaction_payload/4` and
  `remove_all_payload/2` are called from here), and the gate helper
  (`Bitfield.require_bit/2`). What remains is surface adaptation — six actions that
  differ in their request semantics, not six copies of one. Merging them would put
  a dialect parameter in every action head and every error branch, which is more
  code, not less.
  Gates mirror the message routes: the anti-enumeration channel gate (view
  rights via the resolver, restrictions applied) on every route — the
  identical `404 10003 Unknown Channel` for missing/hidden channels;
  `manage_messages` (→ `403 50001`) on the admin routes; a missing message
  is `404 10008 Unknown Message`. The emoji rides the path URL-encoded —
  Phoenix decodes it; validation (1–14 UTF-8 bytes, no colons) runs after
  decode and misses render `400 50035`.

  Threads ARE channels on this surface (C-2, #83 compat-surface remainder):
  a THREAD id resolves through the SAME seam the message routes use —
  storage anchors on the PARENT partition (where the message and its
  reactions live, the same anchor a web-initiated reaction on a thread
  message uses), so the emitted events carry the parent channel id exactly
  as the native surface's do.
  """

  use CytaleWeb, :controller

  alias Cytale.Messages
  alias Cytale.Messages.Reactions
  alias Cytale.Permissions.Bitfield
  alias Cytale.Publish
  alias Cytale.Snowflake
  alias CytaleWeb.Compat.{Authorize, Errors, MessageCodec}
  alias CytaleWeb.ReactionController
  import CytaleWeb.API.Params, only: [parse_limit: 2, snowflake_opt: 1]

  @doc "PUT /channels/{id}/messages/{mid}/reactions/{emoji}/@me — add own, 204."
  def add(conn, %{"channel_id" => cid, "message_id" => mid, "emoji" => emoji}) do
    claims = conn.assigns.current_user

    with {:ok, channel_id} <- Snowflake.parse(cid),
         {:ok, message_id} <- Snowflake.parse(mid),
         {:ok, scope, bits} <- Authorize.scope(claims, channel_id),
         {:permitted, true} <- {:permitted, Bitfield.has?(bits, :add_reactions)},
         msg when msg != nil <- Messages.get_message(scope, message_id),
         :ok <- Reactions.add(scope, message_id, claims.user_id, emoji) do
      publish!(
        scope,
        {"MessageReactionAdd", ReactionController.reaction_payload(scope, message_id, claims.user_id, emoji)}
      )

      send_resp(conn, 204, "")
    else
      :noop -> send_resp(conn, 204, "")
      {:permitted, false} -> Errors.missing_permissions(conn)
      {:error, :unknown_channel} -> Errors.unknown_channel(conn)
      {:error, :invalid_emoji} -> Errors.invalid_form_body(conn)
      {:error, :too_many_emojis} -> Errors.invalid_form_body(conn)
      _ -> Errors.unknown_message(conn)
    end
  end

  @doc "DELETE /channels/{id}/messages/{mid}/reactions/{emoji}/@me — remove own, 204."
  def remove_own(conn, %{"channel_id" => cid, "message_id" => mid, "emoji" => emoji}) do
    claims = conn.assigns.current_user

    with {:ok, channel_id} <- Snowflake.parse(cid),
         {:ok, message_id} <- Snowflake.parse(mid),
         {:ok, scope, _bits} <- Authorize.scope(claims, channel_id),
         msg when msg != nil <- Messages.get_message(scope, message_id),
         :ok <- Reactions.remove(scope, message_id, claims.user_id, emoji) do
      publish!(
        scope,
        {"MessageReactionRemove", ReactionController.reaction_payload(scope, message_id, claims.user_id, emoji)}
      )

      send_resp(conn, 204, "")
    else
      :noop -> send_resp(conn, 204, "")
      {:error, :unknown_channel} -> Errors.unknown_channel(conn)
      {:error, :invalid_emoji} -> Errors.invalid_form_body(conn)
      _ -> Errors.unknown_message(conn)
    end
  end

  @doc """
  GET /channels/{id}/messages/{mid}/reactions/{emoji}?limit=&after= —
  Discord's BARE JSON ARRAY of user objects (no envelope, no cursor field:
  Discord paginates by feeding the last id back as `after`).
  """
  def list(conn, %{"channel_id" => cid, "message_id" => mid, "emoji" => emoji} = params) do
    with {:ok, channel_id} <- Snowflake.parse(cid),
         {:ok, message_id} <- Snowflake.parse(mid),
         {:ok, scope, _bits} <- Authorize.scope(conn.assigns.current_user, channel_id),
         msg when msg != nil <- Messages.get_message(scope, message_id) do
      {user_ids, _next_after} =
        Reactions.list_users(scope, message_id, emoji,
          limit: parse_limit(params["limit"], default: 100, cap: 100),
          after: snowflake_opt(params["after"])
        )

      json(conn, Enum.map(user_ids, fn user_id -> user_id |> MessageCodec.resolve_author() |> elem(0) end))
    else
      {:error, :unknown_channel} -> Errors.unknown_channel(conn)
      _ -> Errors.unknown_message(conn)
    end
  end

  @doc """
  DELETE /channels/{id}/messages/{mid}/reactions/{emoji}/{user_id} — remove
  another's reaction (`manage_messages`), 204 idempotent.
  """
  def remove_user(conn, %{"channel_id" => cid, "message_id" => mid, "emoji" => emoji, "user_id" => uid}) do
    with {:ok, channel_id} <- Snowflake.parse(cid),
         {:ok, message_id} <- Snowflake.parse(mid),
         {:ok, target_user_id} <- Snowflake.parse(uid),
         {:ok, scope, bits} <- Authorize.scope(conn.assigns.current_user, channel_id),
         :ok <- Bitfield.require_bit(bits, :manage_messages),
         msg when msg != nil <- Messages.get_message(scope, message_id),
         :ok <- Reactions.remove_user_reaction(scope, message_id, target_user_id, emoji) do
      publish!(
        scope,
        {"MessageReactionRemove", ReactionController.reaction_payload(scope, message_id, target_user_id, emoji)}
      )

      send_resp(conn, 204, "")
    else
      :noop -> send_resp(conn, 204, "")
      {:error, :unknown_channel} -> Errors.unknown_channel(conn)
      {:error, :missing_permissions} -> Errors.missing_permissions(conn)
      {:error, :invalid_emoji} -> Errors.invalid_form_body(conn)
      _ -> Errors.unknown_message(conn)
    end
  end

  @doc """
  DELETE /channels/{id}/messages/{mid}/reactions/{emoji} — clear one emoji
  for everyone (`manage_messages`); one MESSAGE_REACTION_REMOVE per removed
  user (Discord's behavior).
  """
  def clear_emoji(conn, %{"channel_id" => cid, "message_id" => mid, "emoji" => emoji}) do
    with {:ok, channel_id} <- Snowflake.parse(cid),
         {:ok, message_id} <- Snowflake.parse(mid),
         {:ok, scope, bits} <- Authorize.scope(conn.assigns.current_user, channel_id),
         :ok <- Bitfield.require_bit(bits, :manage_messages),
         msg when msg != nil <- Messages.get_message(scope, message_id),
         {:ok, removed} <- Reactions.remove_others(scope, message_id, emoji) do
      Enum.each(removed, fn user_id ->
        publish!(
          scope,
          {"MessageReactionRemove", ReactionController.reaction_payload(scope, message_id, user_id, emoji)}
        )
      end)

      send_resp(conn, 204, "")
    else
      {:error, :unknown_channel} -> Errors.unknown_channel(conn)
      {:error, :missing_permissions} -> Errors.missing_permissions(conn)
      {:error, :invalid_emoji} -> Errors.invalid_form_body(conn)
      _ -> Errors.unknown_message(conn)
    end
  end

  @doc """
  DELETE /channels/{id}/messages/{mid}/reactions — clear all
  (`manage_messages`); ONE MESSAGE_REACTION_REMOVE_ALL (only when reactions
  existed).
  """
  def clear_all(conn, %{"channel_id" => cid, "message_id" => mid}) do
    with {:ok, channel_id} <- Snowflake.parse(cid),
         {:ok, message_id} <- Snowflake.parse(mid),
         {:ok, scope, bits} <- Authorize.scope(conn.assigns.current_user, channel_id),
         :ok <- Bitfield.require_bit(bits, :manage_messages),
         msg when msg != nil <- Messages.get_message(scope, message_id) do
      unless Reactions.summary(scope, message_id) == [] do
        :ok = Reactions.remove_all(scope, message_id)

        publish!(
          scope,
          {"MessageReactionRemoveAll", ReactionController.remove_all_payload(scope, message_id)}
        )
      end

      send_resp(conn, 204, "")
    else
      {:error, :unknown_channel} -> Errors.unknown_channel(conn)
      {:error, :missing_permissions} -> Errors.missing_permissions(conn)
      _ -> Errors.unknown_message(conn)
    end
  end

  # -- gates ----------------------------------------------------------------------

  # The C-2 scope resolution shared by all six routes: a channel id gates as
  # itself; a non-channel id gets the thread fallback — the gate anchors on
  # the PARENT (thread visibility rides the parent's rights), so every miss
  # still renders the identical 10003 and a thread never leaks existence.
  # The returned scope is the PARENT partition when the id was a thread: the
  # message row, the reaction tables and the emitted events all anchor there,
  # exactly as they do for a web-initiated reaction on a thread message.
  defp publish!(channel_id, event) do
    Publish.publish(channel_id, event)
    :ok
  end

  # -- parsing ----------------------------------------------------------------------

  # Discord's reactions-users ceiling: default 100, cap 100.
end
