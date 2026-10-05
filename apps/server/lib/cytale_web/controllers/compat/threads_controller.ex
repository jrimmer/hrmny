defmodule CytaleWeb.Compat.ThreadsController do
  @moduledoc """
  The compat thread-WRITE surface (bots plan B-2): Discord's thread
  start/join/leave routes mapped onto the native thread machinery
  (`Threads.Thread.start/4`, `Threads.Member.follow/leave`).

    * `POST /channels/{cid}/messages/{mid}/threads` `{name,
      auto_archive_duration}` — start from a message (Discord's shape).
    * `POST /channels/{cid}/threads` `{name, type, auto_archive_duration}` —
      start standalone (no anchoring message).
    * `PUT /channels/{thread_id}/thread-members/@me` — join (follow).
    * `DELETE /channels/{thread_id}/thread-members/@me` — leave.

  Gates: the standard anti-enumeration channel gate on the PARENT channel —
  `send_messages` for the starts, `view_channel` for join/leave (thread
  visibility rides the parent's rights). Responses carry Discord thread
  channel objects (type 11 PUBLIC_THREAD with `thread_metadata`, the same
  shape the GUILD_CREATE inventory renders); join/leave answer 204 empty.

  Divergences (compat.md): `auto_archive_duration` is accepted and ignored
  (Cytale has no auto-archive), and THREAD_MEMBER_* dispatches are not
  emitted (thread-membership rides no intent on this surface).
  """

  use CytaleWeb, :controller

  alias Cytale.Permissions.{Bitfield, Principal}
  alias Cytale.Publish
  alias Cytale.Snowflake
  alias Cytale.Threads
  alias Cytale.Workspaces
  alias CytaleWeb.Compat.{Authorize, Errors, GatewayDialect, MessageCodec}

  # Bounded like the roster cap: a workspace's visible channels are enumerated
  # and their (DESC-clustered) thread partitions read.
  @thread_cap 100

  @doc "POST /channels/{cid}/messages/{mid}/threads — start a thread from a message."
  def start_from_message(conn, %{"channel_id" => cid, "message_id" => mid} = params) do
    claims = conn.assigns.current_user

    with {:ok, channel_id} <- Snowflake.parse(cid),
         {:ok, message_id} <- Snowflake.parse(mid),
         {:ok, channel, bits} <- Authorize.channel_gate(claims, channel_id),
         :ok <- Bitfield.require_bit(bits, :send_messages),
         {:ok, name} <- name(params["name"]),
         {:ok, thread} <- Threads.Thread.start(channel_id, message_id, name, claims.user_id) do
      publish_thread_create(thread)
      json(conn, thread_object(thread, channel))
    else
      {:error, :missing_permissions} -> Errors.missing_permissions(conn)
      {:error, :invalid_body} -> Errors.invalid_form_body(conn)
      {:error, :message_not_found} -> Errors.unknown_message(conn)
      _ -> Errors.unknown_channel(conn)
    end
  end

  @doc "POST /channels/{cid}/threads — start a standalone thread (type 11)."
  def start_standalone(conn, %{"channel_id" => cid} = params) do
    claims = conn.assigns.current_user

    with {:ok, channel_id} <- Snowflake.parse(cid),
         {:ok, channel, bits} <- Authorize.channel_gate(claims, channel_id),
         :ok <- Bitfield.require_bit(bits, :send_messages),
         {:ok, name} <- name(params["name"]),
         {:ok, thread} <- Threads.Thread.start(channel_id, nil, name, claims.user_id) do
      publish_thread_create(thread)
      json(conn, thread_object(thread, channel))
    else
      {:error, :missing_permissions} -> Errors.missing_permissions(conn)
      {:error, :invalid_body} -> Errors.invalid_form_body(conn)
      _ -> Errors.unknown_channel(conn)
    end
  end

  @doc "PUT /channels/{thread_id}/thread-members/@me — join (follow) a thread."
  def join(conn, %{"channel_id" => tid}) do
    claims = conn.assigns.current_user

    with {:ok, thread_id} <- Snowflake.parse(tid),
         %{} = thread <- Threads.Thread.get(thread_id),
         {:ok, _parent, bits} <- Authorize.channel_gate(claims, thread.channel_id),
         :ok <- Bitfield.require_bit(bits, :view_channel) do
      :ok = Threads.Member.follow(thread_id, claims.user_id)
      send_resp(conn, 204, "")
    else
      {:error, :missing_permissions} -> Errors.missing_permissions(conn)
      _ -> Errors.unknown_channel(conn)
    end
  end

  @doc "DELETE /channels/{thread_id}/thread-members/@me — leave a thread."
  def leave(conn, %{"channel_id" => tid}) do
    claims = conn.assigns.current_user

    with {:ok, thread_id} <- Snowflake.parse(tid),
         %{} = thread <- Threads.Thread.get(thread_id),
         {:ok, _parent, bits} <- Authorize.channel_gate(claims, thread.channel_id),
         :ok <- Bitfield.require_bit(bits, :view_channel) do
      :ok = Threads.Member.leave(thread_id, claims.user_id)
      send_resp(conn, 204, "")
    else
      {:error, :missing_permissions} -> Errors.missing_permissions(conn)
      _ -> Errors.unknown_channel(conn)
    end
  end

  @doc """
  GET /guilds/{guild_id}/threads/active — Discord's thread DISCOVERY route
  (#74).

  Without it a client that reconnects (and lost its cache with the old session)
  can never find a thread again: the create response's id was the only handle
  and it 404'd on every read. Threads are listed only from channels the
  principal can VIEW, through the SAME visibility computation the gateway's
  per-socket memo uses — one answer to "what may this principal see?", not one
  per transport.
  """
  def active(conn, %{"guild_id" => gid}) do
    claims = conn.assigns.current_user

    with {:ok, workspace_id} <- Snowflake.parse(gid),
         true <- Workspaces.get_workspace(workspace_id) != nil,
         # The WORKSPACE-level resolve: a machine principal's rights come through
         # its parent (a raw membership row would read as absent for every bot),
         # and `:forbidden` covers the allowlist. A guild the caller cannot see
         # is the same 10004 as one that does not exist.
         {:ok, bits} <- Principal.resolve(workspace_id, claims),
         :ok <- Bitfield.require_bit(bits, :view_channel) do
      threads =
        workspace_id
        |> visible_threads(claims)
        |> Enum.reject(& &1.archived)
        |> Enum.take(@thread_cap)

      guild_id = Integer.to_string(workspace_id)

      json(conn, %{
        "threads" => Enum.map(threads, &MessageCodec.thread_channel(&1, guild_id)),
        # Discord sends each listed thread's thread-member object for the
        # REQUESTING user; we send none rather than fabricating membership.
        "members" => [],
        "has_more" => false
      })
    else
      _ -> Errors.unknown_guild(conn)
    end
  end

  @doc """
  GET /channels/{channel_id}/threads/archived/public — the channel's archived
  threads (#74), in the same response envelope as the active listing.
  """
  def archived(conn, %{"channel_id" => cid}) do
    claims = conn.assigns.current_user

    with {:ok, channel_id} <- Snowflake.parse(cid),
         {:ok, channel, bits} <- Authorize.channel_gate(claims, channel_id),
         :ok <- Bitfield.require_bit(bits, :view_channel) do
      threads =
        channel_id
        |> Threads.Thread.list_in_channel()
        |> Enum.filter(& &1.archived)
        |> Enum.take(@thread_cap)

      json(conn, %{
        "threads" => Enum.map(threads, &thread_object(&1, channel)),
        "members" => [],
        "has_more" => false
      })
    else
      _ -> Errors.unknown_channel(conn)
    end
  end

  @doc """
  GET /channels/{thread_id}/thread-members — the thread's member roster
  (#83 compat-surface remainder: Discord's `ThreadChannel.fetch_members()`
  route; the native twin is `GET /threads/:id/members`). Roster reads were
  join/leave-only before — a client could change its membership but never
  see the roster, and `discord.py`'s `fetch_members` answered 10003.

  Discord thread-member objects (`id` = the thread id, `user_id`,
  `join_timestamp`, `flags`) from the SAME `thread_members` rows the native
  roster read serves. Gated `view_channel` on the parent (thread visibility
  rides the parent's rights); the identical 10003 for every miss.
  """
  def members_index(conn, %{"channel_id" => tid}) do
    claims = conn.assigns.current_user

    with {:ok, thread_id} <- Snowflake.parse(tid),
         %{} = thread <- Threads.Thread.get(thread_id),
         {:ok, _parent, bits} <- Authorize.channel_gate(claims, thread.channel_id),
         :ok <- Bitfield.require_bit(bits, :view_channel) do
      json(conn, Enum.map(roster(thread_id), &thread_member_object(thread_id, &1)))
    else
      {:error, :missing_permissions} -> Errors.missing_permissions(conn)
      _ -> Errors.unknown_channel(conn)
    end
  end

  @doc """
  GET /channels/{thread_id}/thread-members/@me — the CALLING principal's own
  thread membership (Discord's self-membership read). A principal with no
  membership row gets the uniform `10003` — the anti-enumeration shape every
  miss on this surface renders, and the honest answer to "am I in this
  thread?" for a caller who may not even see it.
  """
  def member_me(conn, %{"channel_id" => tid}) do
    claims = conn.assigns.current_user

    with {:ok, thread_id} <- Snowflake.parse(tid),
         %{} = thread <- Threads.Thread.get(thread_id),
         {:ok, _parent, bits} <- Authorize.channel_gate(claims, thread.channel_id),
         :ok <- Bitfield.require_bit(bits, :view_channel),
         %{} = member <- Threads.Member.get(thread_id, claims.user_id) do
      json(conn, thread_member_object(thread_id, member))
    else
      {:error, :missing_permissions} -> Errors.missing_permissions(conn)
      _ -> Errors.unknown_channel(conn)
    end
  end

  # The bounded roster read behind both routes (the native members read's
  # query — one partition scan).
  defp roster(thread_id) do
    Cytale.Repo.execute!(
      "SELECT user_id, joined_at FROM {{K}}.thread_members WHERE thread_id = ?"
      |> String.replace("{{K}}", Cytale.Repo.keyspace()),
      [{"bigint", thread_id}]
    )
    |> Enum.to_list()
  end

  # Discord's thread member object: `id` is the THREAD id, `flags` is
  # Discord's bitmask (Cytale has no flags — 0, like every other stubbed
  # Discord enum on this surface). Reads both row shapes the callers hold:
  # the raw roster query (string-keyed) and `Threads.Member.get` (atom-keyed).
  defp thread_member_object(thread_id, row) do
    user_id = row[:user_id] || row["user_id"]
    joined_at = row[:joined_at] || row["joined_at"]

    %{
      "id" => Integer.to_string(thread_id),
      "user_id" => Integer.to_string(user_id),
      "join_timestamp" => joined_at && DateTime.to_iso8601(joined_at),
      "flags" => 0
    }
  end

  # -- internals ------------------------------------------------------------------

  defp visible_threads(workspace_id, claims) do
    GatewayDialect.visible_channel_ids(workspace_id, claims)
    |> Enum.flat_map(&Threads.Thread.list_in_channel/1)
  end

  # Discord thread names: 1–100 characters; `auto_archive_duration` rides
  # the body but is accepted-and-ignored (documented divergence).
  defp name(name) when is_binary(name) and byte_size(name) >= 1 and byte_size(name) <= 100,
    do: {:ok, name}

  defp name(_), do: {:error, :invalid_body}

  # The native ThreadCreate announce — compat sessions receive THREAD_CREATE
  # on GUILDS.
  #
  # ONE PRODUCER NOW (hardening plan 4.10). This used to be a private copy whose
  # `created_by` was a raw INTEGER while `Threads.Events.thread_create/1`
  # stringifies it per the protocol's Snowflake — same event, same fan-out key,
  # two types for one field. The compat translation re-normalizes either form
  # (`GatewayDialect.payload_thread_row` -> `int_id/1`), but NATIVE sessions
  # receive the payload verbatim, so a compat-initiated create handed a native
  # client an int where its contract says string.
  #
  # The copy also existed because the shared producer did not nil-guard
  # `created_at`; that guard now lives in `thread_create/1`, so the reason for
  # the divergence is gone and both surfaces ride one payload builder.
  defp publish_thread_create(thread) do
    Publish.publish(thread.channel_id, {"ThreadCreate", Threads.Events.thread_create(thread)})
  end

  defp thread_object(thread, channel) do
    MessageCodec.thread_channel(thread, Integer.to_string(channel.workspace_id))
  end
end
