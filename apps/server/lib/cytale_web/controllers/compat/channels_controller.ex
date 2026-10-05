defmodule CytaleWeb.Compat.ChannelsController do
  @moduledoc """
  The compat channel routes (bots plan U6 + parity adds): GET /channels/{id}
  — the Discord channel object (`guild_id` = the workspace id), POST
  /channels/{id}/typing (C-3, Discord's typing route), PATCH /channels/{id}
  (Modify Channel, #75 — and ARCHIVE for a thread id, #109), and DELETE
  /channels/{id} for a THREAD (#74). All gated by the anti-enumeration channel
  gate (view rights through the U3 resolver, restrictions applied) — every miss
  renders the identical 10003 Unknown Channel body.

  The channel COLLECTION route is deliberately absent here: bot channel
  enumeration arrives with the guild-cache work in U7.
  """

  use CytaleWeb, :controller

  alias Cytale.Permissions.Bitfield
  alias Cytale.Publish
  alias Cytale.Snowflake
  alias Cytale.Threads
  alias Cytale.Workspaces
  alias CytaleWeb.Compat.{Authorize, Errors, MessageCodec}

  @doc """
  GET /channels/{id} — the Discord channel object (a DM id renders the DM
  channel object, type 1; a THREAD id renders the thread, #74).

  A thread IS a channel in Discord — same id space, same read route — and the
  server hands out thread ids in the create response, so a read that answered
  10003 left every thread write-only: a client could create one and never
  resolve it again. The thread object comes from the ONE builder the
  THREAD_CREATE dispatch and the GUILD_CREATE inventory already share, so a
  client that never saw the create event reads exactly what the event said
  (minus `newly_created`, which is event metadata rather than thread state —
  #71).
  """
  def show(conn, %{"channel_id" => id}) do
    claims = conn.assigns.current_user

    with {:ok, channel_id} <- Snowflake.parse(id) do
      case Authorize.channel_gate(claims, channel_id) do
        {:ok, channel, _bits} ->
          json(conn, MessageCodec.channel(channel, claims.user_id))

        {:error, _} ->
          case thread_object(claims, channel_id) do
            nil -> Errors.unknown_channel(conn)
            object -> json(conn, object)
          end
      end
    else
      _ -> Errors.unknown_channel(conn)
    end
  end

  @doc """
  DELETE /channels/{id} — delete a THREAD (#74).

  Discord allows deleting a thread through the channel route (thread owner, or
  MANAGE_THREADS on the parent). Deleting a real CHANNEL through a bot
  credential is a separate authorization decision and is NOT exposed here: a
  channel the caller can see gets the honest 403, anything else the uniform
  10003, and neither destroys anything.
  """
  def delete(conn, %{"channel_id" => id}) do
    claims = conn.assigns.current_user

    with {:ok, channel_id} <- Snowflake.parse(id) do
      case Threads.Thread.get(channel_id) do
        %{} = thread ->
          delete_thread(conn, thread, claims)

        nil ->
          case Authorize.channel_gate(claims, channel_id) do
            {:ok, _channel, _bits} -> Errors.missing_permissions(conn)
            _ -> Errors.unknown_channel(conn)
          end
      end
    else
      _ -> Errors.unknown_channel(conn)
    end
  end

  defp delete_thread(conn, thread, claims) do
    with {:ok, _parent, bits} <- Authorize.channel_gate(claims, thread.channel_id),
         :ok <- may_delete?(thread, claims, bits) do
      :ok = Threads.Thread.delete(thread.thread_id, thread.channel_id)
      publish_thread_delete(thread)
      send_resp(conn, 204, "")
    else
      {:error, :missing_permissions} -> Errors.missing_permissions(conn)
      _ -> Errors.unknown_channel(conn)
    end
  end

  # Thread ownership is `created_by`; otherwise MANAGE_THREADS on the PARENT —
  # a thread's visibility and rights ride its parent channel.
  defp may_delete?(thread, claims, bits) do
    cond do
      thread.created_by == claims.user_id -> :ok
      Bitfield.has?(bits, :manage_threads) -> :ok
      true -> {:error, :missing_permissions}
    end
  end

  defp thread_object(claims, thread_id) do
    with %{} = thread <- Threads.Thread.get(thread_id),
         {:ok, parent, _bits} <- Authorize.channel_gate(claims, thread.channel_id) do
      MessageCodec.thread_channel(thread, Integer.to_string(parent.workspace_id))
    else
      _ -> nil
    end
  end

  # The same fan-out key the native thread surface uses, so live sessions
  # holding the thread receive THREAD_DELETE — from the SAME builder, so the
  # surfaces cannot drift (including the channel_id the fan-out routes by).
  defp publish_thread_delete(thread) do
    Publish.publish(thread.channel_id, {"ThreadDelete", Threads.Events.thread_delete(thread)})
  end

  @doc """
  PATCH /channels/{id} — Discord's **Modify Channel** (#75), authorized by
  `MANAGE_CHANNELS` on the channel.

  Discord has no separate topic endpoint: `topic` rides this same call, as do
  `name` and `position`. PATCH semantics are the native ones (an ABSENT key
  leaves the field alone; the native controller's `put_present` contract), and
  the response is the updated **channel object from the same builder** the read
  and the `CHANNEL_UPDATE` dispatch use — so a client that renames a channel
  reads back exactly what the event reported (§one-shape).

  Threads ride this route too (#109): Discord edits a thread here — a thread IS
  a channel there — and its `archived` field is how every Discord client
  archives one. Only `archived` is served on that branch (the one thread
  mutation Cytale has); the permission rule and the emitted `THREAD_UPDATE` are
  the native surface's, through the shared `Authorize.may_archive_thread?/3`.
  Deleting a thread is `DELETE /channels/{id}` above, not a field of this call.
  """
  def update(conn, %{"channel_id" => id} = params) do
    claims = conn.assigns.current_user

    with {:ok, channel_id} <- Snowflake.parse(id) do
      case Threads.Thread.get(channel_id) do
        %{} = thread -> update_thread(conn, thread, claims, params)
        nil -> update_channel(conn, channel_id, claims, params)
      end
    else
      _ -> Errors.unknown_channel(conn)
    end
  end

  defp update_thread(conn, thread, claims, params) do
    with {:ok, parent, bits} <- Authorize.channel_gate(claims, thread.channel_id),
         :ok <- may_archive?(thread, claims, bits),
         {:ok, archived} <- archived_param(params) do
      :ok = Threads.Thread.set_archived(thread.thread_id, archived)

      # The native fan-out key, so a compat session and a native session
      # watching the same parent channel both receive THREAD_UPDATE.
      updated = Threads.Thread.get(thread.thread_id) || thread
      publish_thread_update(updated)

      json(conn, MessageCodec.thread_channel(updated, Integer.to_string(parent.workspace_id)))
    else
      {:error, :missing_permissions} -> Errors.missing_permissions(conn)
      {:error, :invalid_form_body} -> Errors.invalid_form_body(conn)
      _ -> Errors.unknown_channel(conn)
    end
  end

  defp update_channel(conn, channel_id, claims, params) do
    # A DM channel id resolves through the gate's DM branch (participation IS
    # authorization) but is NOT a channel this route may edit — Discord's
    # Modify Channel is a guild-channel route, and the native channel writer
    # has no DM row to touch.
    with {:ok, %{type: type} = _channel, bits} <- Authorize.channel_gate(claims, channel_id),
         :ok <- reject_dm(type),
         :ok <- Bitfield.require_bit(bits, :manage_channels),
         {:ok, changes} <- changes_from(params) do
      :ok = Workspaces.update_channel(channel_id, changes)

      updated = Workspaces.get_channel(channel_id)

      # The same fan-out the native PATCH sends, so live compat sessions see
      # their own rename through the ordinary CHANNEL_UPDATE dispatch (#70).
      CytaleWeb.GatewaySocket.fan_out(
        Cytale.Gateway.PushRegistry.channel_key(Integer.to_string(channel_id)),
        {"ChannelUpdate",
         %{
           "id" => Integer.to_string(channel_id),
           "name" => updated.name,
           "topic" => updated.topic,
           "position" => updated.position,
           "parent_id" => updated.parent_id && Integer.to_string(updated.parent_id)
         }}
      )

      json(conn, MessageCodec.channel(updated, claims.user_id))
    else
      {:error, :missing_permissions} -> Errors.missing_permissions(conn)
      {:error, :invalid_form_body} -> Errors.invalid_form_body(conn)
      _ -> Errors.unknown_channel(conn)
    end
  end

  defp may_archive?(thread, claims, bits) do
    if Authorize.may_archive_thread?(claims, thread, bits),
      do: :ok,
      else: {:error, :missing_permissions}
  end

  # DIVERGENCE (documented, compat.md C-2): `archived` is the ONLY thread
  # field this route writes. A Discord client RENAMING a thread PATCHes
  # `{name}` here and gets `400 50035`, on purpose: Cytale has no thread
  # rename on EITHER surface (native `PATCH /threads/:id` is archive-only —
  # names are derived from the seed message), so serving the rename here
  # would create a compat-only mutation no native client can perform or
  # observe except through the event. If renames ever land natively, this is
  # the route that grows the field.
  defp archived_param(%{"archived" => v}) when is_boolean(v), do: {:ok, v}
  defp archived_param(_), do: {:error, :invalid_form_body}

  # The same payload the native PATCH /threads/:id publishes, from the SAME
  # builder — one definition of the event, so the compat and native surfaces
  # cannot drift (including the channel_id the fan-out routes by).
  defp publish_thread_update(thread) do
    Publish.publish(thread.channel_id, {"ThreadUpdate", Threads.Events.thread_update(thread, %{})})
  end

  defp reject_dm(:dm), do: {:error, :unknown_channel}
  defp reject_dm(_type), do: :ok

  # PATCH semantics (the native controller's contract): an ABSENT key leaves the
  # field unchanged, an explicit null clears a clearable one, and a present key
  # that cannot be rendered is a 50035 form error for the WHOLE call — never a
  # silent partial apply.
  defp changes_from(params) do
    with {:ok, name} <- optional(params, "name", &valid_name/1),
         {:ok, topic} <- optional(params, "topic", &valid_topic/1),
         {:ok, position} <- optional(params, "position", &valid_position/1) do
      {:ok,
       %{}
       |> maybe_put(:name, name)
       |> maybe_put(:topic, topic)
       |> maybe_put(:position, position)}
    else
      # A present-but-unrenderable key (an empty name, a non-numeric position)
      # is Discord's 50035 form error for the WHOLE call — never a 404, which
      # would read as "no such channel" for a perfectly good channel id.
      :error -> {:error, :invalid_form_body}
    end
  end

  defp optional(params, key, validator) do
    case Map.fetch(params, key) do
      :error -> {:ok, :absent}
      {:ok, value} -> validator.(value)
    end
  end

  defp maybe_put(changes, _key, :absent), do: changes
  defp maybe_put(changes, key, value), do: Map.put(changes, key, value)

  # Discord's channel-name bounds; `null` is not a name.
  defp valid_name(name) when is_binary(name) and byte_size(name) >= 1 and byte_size(name) <= 100,
    do: {:ok, name}

  defp valid_name(_), do: :error

  # A topic is optional and CLEARABLE: null (or an empty string) means "no
  # topic", which is a value, not a missing key.
  defp valid_topic(topic) when is_binary(topic), do: {:ok, topic}
  defp valid_topic(nil), do: {:ok, nil}
  defp valid_topic(_), do: :error

  defp valid_position(value) when is_integer(value), do: {:ok, value}

  defp valid_position(value) when is_binary(value) do
    case Integer.parse(value) do
      {int, ""} -> {:ok, int}
      _ -> :error
    end
  end

  defp valid_position(_), do: :error

  @doc """
  POST /channels/{id}/typing — Discord's typing route (compat, C-3). The
  channel gate runs (the same seam as every compat write; a DM channel id
  resolves through recipient membership, B-1), then the NATIVE typing
  fan-out fires exactly as the native REST fallback does
  (`MessageController.typing`'s payload shape on the channel route key) —
  compat and native consumers observe the identical TypingStart dispatch.
  Discord answers 204 empty; so does this route.

  A THREAD id types in the thread (#83 compat-surface remainder — the route
  404'd on a thread before): the fan-out anchors on the PARENT channel (the
  delivery route) with `thread_id` set in the payload, and the dispatch
  translation renders the THREAD id as the TYPING_START's `channel_id` —
  Discord's shape, so the indicator lands in the thread view, not the
  parent's.
  """
  def typing(conn, %{"channel_id" => id} = params) do
    claims = conn.assigns.current_user

    with {:ok, channel_id} <- Snowflake.parse(id),
         {:ok, channel_id, thread_scope} <- typing_scope(claims, channel_id, params) do
      payload =
        Cytale.Gateway.Payloads.typing_start(channel_id, claims.user_id, thread_scope)

      # The typing rule (#80) at the shared fan-out: the typing principal's
      # own sessions are excluded, exactly as the dialect's `self_typing?/3`
      # drops it on the compat dispatch path — one rule, both wires, and it
      # now covers a principal whose OTHER session speaks the native wire.
      Cytale.Workspaces.FanOut.deliver(channel_id, {"TypingStart", payload}, except: {:user, claims.user_id})

      send_resp(conn, 204, "")
    else
      _ -> Errors.unknown_channel(conn)
    end
  end

  # A channel id types as itself (an explicit `thread_id` body param rides —
  # the native REST fallback's shape); a THREAD id resolves to its parent and
  # types there with the thread named, so one fan-out key serves both.
  defp typing_scope(claims, channel_id, params) do
    case Authorize.channel_gate(claims, channel_id) do
      {:ok, _channel, _bits} ->
        {:ok, channel_id, params["thread_id"]}

      {:error, _} ->
        with %{} = t <- Threads.Thread.get(channel_id),
             {:ok, _parent, _bits} <- Authorize.channel_gate(claims, t.channel_id) do
          {:ok, t.channel_id, Integer.to_string(t.thread_id)}
        else
          _ -> {:error, :unknown_channel}
        end
    end
  end
end
