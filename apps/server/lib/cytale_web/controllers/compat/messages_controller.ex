defmodule CytaleWeb.Compat.MessagesController do
  @moduledoc """
  The compat message subset (bots plan U6, R7): history as a BARE JSON
  array (native envelope unwrapped), Discord-shaped sends
  (`message_reference` → native `reply_to_id`), author-checked
  edit/delete, and the read-ack route (C-4). Thin over `Cytale.Messages`
  like the native controller.

  Gates: the anti-enumeration channel gate (view rights via the U3
  resolver, restrictions applied) on every route; `read_message_history`
  for GETs; `send_messages` for POST/PATCH/DELETE (the native send gate);
  edit/delete are author-only, mirroring the native controller.

  Threads ARE channels on this surface (C-2): history, SENDS, edits,
  deletes and acks all accept a THREAD id — the write anchors on the
  parent channel (`send_messages` there; replies live in the parent's
  storage partition) and the thread reply rides the SAME send pipeline the
  native reply route uses (`Cytale.Messages.Send` — dual emission +
  auto-follow + the discovery counters), so compat-initiated replies are
  indistinguishable on the wire from native ones.

  Side effects mirror `CytaleWeb.MessageController` exactly (native-shaped
  MessageCreate/Update/Delete publishes + the last_message_id
  denormalization) so realtime consumers see bot writes through the SAME
  projection a human write uses (KD2 merge parity) — `MessageController.
  message_json/1` itself (public since U11; the private mirror this module
  carried was deleted).
  """

  use CytaleWeb, :controller

  alias Cytale.Gateway.PushRegistry
  alias Cytale.Messages
  alias Cytale.Permissions.Bitfield
  alias Cytale.Publish
  alias Cytale.Snowflake
  alias Cytale.Threads.{Member, Thread}
  alias CytaleWeb.Compat.{Authorize, Errors, MessageCodec}
  alias CytaleWeb.MessageController
  alias CytaleWeb.MultipartUpload
  import CytaleWeb.API.Params, only: [parse_limit: 2, snowflake_opt: 1]

  @doc """
  GET /channels/{id}/messages?limit=&before= — bare JSON array, newest-first.
  Discord treats threads as channels (C-2): an id that resolves through
  `threads_by_id` serves the THREAD's history, authorized on the PARENT
  channel (thread visibility rides the parent's rights) and rendered with
  the thread id as `channel_id`; every other miss is the identical 10003.
  """
  def index(conn, %{"channel_id" => id} = params) do
    with {:ok, channel_id} <- Snowflake.parse(id) do
      case Authorize.channel_gate(conn.assigns.current_user, channel_id) do
        {:ok, _channel, bits} ->
          with :ok <- Bitfield.require_bit(bits, :read_message_history) do
            rows =
              Messages.history(channel_id, compat_history_opts(params))

            json(conn, MessageCodec.messages(rows) |> attach_reactions(rows, conn.assigns.current_user.user_id))
          else
            {:error, :missing_permissions} -> Errors.missing_permissions(conn)
          end

        # Not a channel — try the thread lookup (same route shape; the gate
        # anchors on the parent, so an out-of-profile parent is still 10003).
        {:error, :unknown_channel} ->
          with %{} = t <- Thread.get(channel_id),
               {:ok, _parent, bits} <- Authorize.channel_gate(conn.assigns.current_user, t.channel_id),
               :ok <- Bitfield.require_bit(bits, :read_message_history) do
            # The thread's own locator (#152), not a filtered parent walk.
            rows = Messages.thread_history(channel_id, compat_history_opts(params))

            json(
              conn,
              MessageCodec.messages(rows, channel_id: channel_id)
              |> attach_reactions(rows, conn.assigns.current_user.user_id)
            )
          else
            {:error, :missing_permissions} -> Errors.missing_permissions(conn)
            _ -> Errors.unknown_channel(conn)
          end
      end
    else
      _ -> Errors.unknown_channel(conn)
    end
  end

  # Discord's history cursors (#152): `before` and `after` are exclusive
  # snowflakes, and Discord honors ONE of them — `before` wins here too, the
  # most conservative reading of a request that names both. (`around` is not
  # supported and is ignored, as before.)
  defp compat_history_opts(params) do
    limit = [limit: parse_limit(params["limit"], default: 50, cap: 100)]

    case {snowflake_opt(params["before"]), snowflake_opt(params["after"])} do
      {nil, nil} -> limit
      {nil, after_id} -> [after: after_id] ++ limit
      {before, _} -> [before: before] ++ limit
    end
  end

  @doc """
  POST /channels/{id}/messages — body `{content, message_reference?, nonce?,
  attachments?, embeds?, components?}` → 201 with the created Discord message
  object (nonce echoed back when provided). `content` may be empty/absent
  when `embeds` ride the message (KTD11's embed-only webhook shape);
  `components` are validated against the R1 caps then STORED verbatim and
  rendered on every read (components plan U1 — the strip is gone); a bot
  edits them with PATCH or the interaction callback.

  Discord's multipart file model is accepted too: `payload_json` carries the
  body and `files[n]` parts store through the shared content-addressed store
  (`CytaleWeb.MultipartUpload`), riding the created message as Discord
  attachment objects (fresh snowflake id, absolute url). Stored files
  REPLACE the `payload_json.attachments` index-map metadata; a JSON body (or
  a metadata-only attachments array — self-hosted URLs) behaves exactly as
  before. The permission gate is unchanged: the caller's `send_messages`
  right.

  A THREAD id takes the reply branch (#83 compat-surface remainder — this
  route was reads-only on a thread before): the same body surface as a
  channel (content, attachments, embeds, components — embed-only included),
  through the native reply's own hot path. See `create_thread_reply/5`.
  """
  def create(conn, %{"channel_id" => id} = _params) do
    claims = conn.assigns.current_user

    with {:ok, channel_id} <- Snowflake.parse(id),
         {:ok, scope, bits, channel_row} <- write_scope(claims, channel_id),
         # ONE send gate for both branches: `send_messages` on the channel —
         # for a thread, on its PARENT (the native reply route's gate,
         # `RequirePermitted` resolving `:thread_id`). A principal that may
         # only read a channel may not reply in its threads either.
         :ok <- Bitfield.require_bit(bits, :send_messages) do
      if scope == channel_id do
        create_channel_message(conn, channel_row, claims)
      else
        create_thread_reply(conn, channel_row, scope, channel_id, claims)
      end
    else
      {:error, :missing_permissions} -> Errors.missing_permissions(conn)
      _ -> Errors.unknown_channel(conn)
    end
  end

  # The channel branch and the thread branch share everything but the target:
  # the same body surface (content, attachments, `embeds` and `components`
  # under the same validation and caps, the same content rule — an embed-only
  # message persists ""), the same send pipeline (`Cytale.Messages.Send`), and
  # the same error mapping. A bot's interactive card — content + embed +
  # buttons — posts in a thread exactly as it does in a channel.
  defp create_channel_message(conn, %{channel_id: channel_id} = channel, claims) do
    route = channel_route(channel)

    with {:ok, body, attrs} <- send_attrs(conn) do
      # The shared pipeline, and with it the durable dedupe: a bot retrying
      # the same `nonce` (after a restart, a timeout, a 5xx) gets its original
      # message back, 200, with no second row and no second MessageCreate.
      attrs
      |> Map.merge(%{
        channel_id: channel_id,
        author_id: claims.user_id,
        thread_id: nil,
        channel_kind: channel_kind(route)
      })
      # `pointer: :sync` — Discord's channel object names its last message the
      # moment the send answers, and bots read it back (a GET /channels/{id}
      # right after a send); the native client learns it from the dispatch.
      |> Messages.Send.post(route: route, pointer: :sync)
      |> render_sent(conn, body, fn %{message: msg, reference: reference} ->
        MessageCodec.message(msg, reference)
        |> MessageCodec.put_reactions(msg.channel_id, msg.id, claims.user_id)
      end)
    else
      error -> send_error(conn, error)
    end
  end

  # The thread branch (C-2 writes): a thread reply through the SAME pipeline
  # the native reply route drives (`Messages.Send`, kind `:thread_reply` — the
  # dual emission, auto-follow-on-reply, the discovery counters), so a
  # compat-initiated reply and a native one are indistinguishable on every
  # wire. (Embeds/components were refused here with a 50035 until the thread
  # wire carried them: `Message.to_wire/1` now renders both, so the 201, the
  # live ThreadMessageCreate and every read agree.)
  # `message_reference` is ACCEPTED (#155 — discord.py's `reference=` always
  # carries one, and thread replies are real replies: the row already has
  # reply_to_id, the thread codec renders type 19 + message_reference, and
  # the shared builder keeps the dispatch truthful). It must name a message
  # IN THIS THREAD — the pipeline's rule for every thread reply, native or
  # compat (Discord's: a thread is a channel, and a reply stays in its own).
  defp create_thread_reply(conn, parent, parent_id, thread_id, claims) do
    case send_attrs(conn) do
      {:ok, body, attrs} ->
        attrs
        # The reply snapshot rides the dispatch wire as it does for a native
        # reply, so a live viewer renders the reply's context line without a
        # fetch whichever surface posted it.
        |> Map.merge(%{channel_id: parent_id, author_id: claims.user_id, thread_id: thread_id})
        |> Messages.Send.post(kind: :thread_reply)
        |> render_sent(conn, body, fn %{wire: wire} ->
          # The ONE builder the ThreadMessageCreate dispatch translation uses —
          # the response cannot disagree with what other sessions see live.
          MessageCodec.thread_message_from_native(wire, Integer.to_string(parent.workspace_id))
        end)

      error ->
        send_error(conn, error)
    end
  end

  # The request → the pipeline's attrs (target excluded), for either branch.
  # The reply reference is parsed to its id here and validated by the
  # pipeline, which hands the replied-to row back for the Discord object.
  defp send_attrs(conn) do
    with {:ok, body} <- MultipartUpload.payload(conn),
         {:ok, files} <- MultipartUpload.files(conn),
         # The composed body — content, embeds, components — through the ONE
         # parser every send route shares (native included).
         {:ok, composed} <- composed(body, conn.assigns.current_user),
         {:ok, attachments} <- create_attachments(conn, body, files),
         {:ok, reply_to_id} <- reply_to_id(body["message_reference"]) do
      {:ok, body,
       Map.merge(composed, %{
         reply_to_id: reply_to_id,
         attachments: attachments,
         # The send key — the body `nonce` (Discord's), else the Idempotency-Key
         # header, read exactly as the native routes read it. Discord echoes
         # the nonce on MESSAGE_CREATE; the native wire carries it (normalized)
         # and the dialect renders it.
         nonce: MessageController.send_nonce(conn, body)
       })}
    end
  end

  # Every `SendBody` refusal is Discord's 50035 Invalid Form Body here.
  defp composed(body, claims) do
    case Messages.SendBody.parse(body, claims) do
      {:ok, composed} -> {:ok, composed}
      {:error, _reason} -> {:error, :invalid_body}
    end
  end

  # The pipeline's result → the compat response: 201 for a new message, 200
  # for a retry answered with the original (nothing was created), and a
  # conflicting key as Discord's field-level 50035 on `nonce`. The body's
  # `nonce` is echoed as the client sent it (Discord's shape).
  defp render_sent({:conflict, :nonce_reused}, conn, _body, _render),
    do: Errors.invalid_form_body(conn, "nonce", "This nonce was already used for another message.")

  defp render_sent({:error, :bad_reference}, conn, _body, _render), do: Errors.invalid_form_body(conn)

  defp render_sent({status, sent}, conn, body, render) do
    conn
    |> put_status(if(status == :created, do: 201, else: 200))
    |> json(sent |> render.() |> maybe_nonce(body["nonce"]))
  end

  defp send_error(conn, {:error, :invalid_body}), do: Errors.invalid_form_body(conn)
  defp send_error(conn, {:error, :invalid_attachments}), do: Errors.invalid_form_body(conn)
  defp send_error(conn, {:error, :invalid_form_body}), do: Errors.invalid_form_body(conn)
  defp send_error(conn, {:error, :too_large}), do: Errors.invalid_form_body(conn)
  defp send_error(conn, {:error, :disallowed_mime}), do: Errors.invalid_form_body(conn)

  defp send_error(conn, {:error, :volume_full}),
    do: Errors.render(conn, 507, 0, "Attachment storage is full; try again later.")

  defp send_error(conn, _), do: Errors.unknown_channel(conn)

  # The route the channel gate resolved, in the shape the publish, the pointer
  # write and the DM search leg take (the native send's
  # `conn.assigns.channel_route`) — so none of them re-reads the channel: a
  # workspace channel's id, or a DM's row (whose pointer is written
  # synchronously; the DM search backfill reads it).
  defp channel_route(%{type: :dm, user_ids: user_ids} = dm) when is_list(user_ids), do: {:dm, dm}
  defp channel_route(%{workspace_id: ws_id}) when is_integer(ws_id), do: {:channel, ws_id}
  defp channel_route(_channel), do: nil

  defp channel_kind({:channel, _ws_id}), do: :channel
  defp channel_kind(route), do: route

  @doc """
  PATCH /channels/{id}/messages/{mid} `{content?, embeds?, components?}` —
  author-only edit, Discord's message edit.

  A machine author may edit its message's `embeds` and `components` here as
  on Discord (each optional, each a wholesale replace under the create's
  caps). That is how discord.py expires a card: a View's `on_timeout` calls
  `message.edit(embed=…, view=disabled_view)`, a body with NO `content`.
  Refusing it (this route was content-only, 400 50035 without `content`)
  left the bot's expired card on screen with live buttons nobody was
  listening to — Hermes' approval card on 2026-10-01. A person's embeds and
  components are ignored, as on create (R1: components ⇒ machine author).

  `content` absent or null keeps the stored content; present, it follows
  the send's rule (1–4000 bytes, "" only when embeds remain). A body with
  nothing to edit is 400 50035.
  """
  def update(conn, %{"channel_id" => cid, "message_id" => mid} = params) do
    claims = conn.assigns.current_user

    with {:ok, channel_id} <- Snowflake.parse(cid),
         {:ok, scope, bits} <- Authorize.scope(claims, channel_id),
         :ok <- Bitfield.require_bit(bits, :send_messages),
         {:ok, message_id} <- Snowflake.parse(mid),
         msg when msg != nil <- Messages.get_message(scope, message_id),
         :ok <- author_only(msg, claims),
         {:ok, edit} <- edit_body(params, msg, claims) do
      :ok = Messages.edit_message(scope, message_id, edit.content)
      if edit.components != nil, do: :ok = Messages.replace_components(scope, message_id, edit.components)
      if edit.embeds != nil, do: :ok = Messages.replace_embeds(scope, message_id, edit.embeds)

      updated = Messages.get_message(scope, message_id)

      update =
        if edit.components != nil or edit.embeds != nil do
          # A card edit reaches live viewers with `components` and `embeds`
          # ALWAYS present (explicit [] when cleared) — the type-7 flip's
          # wire, where an absent key would read "unchanged".
          Map.merge(MessageController.message_json(updated), %{
            "components" => Map.get(updated, :components) || [],
            "embeds" => Cytale.MediaProxy.wire_embeds(Map.get(updated, :embeds) || [])
          })
        else
          MessageController.message_json(updated)
        end

      Publish.publish(scope, {"MessageUpdate", update})

      rendered =
        if scope == channel_id do
          MessageCodec.message(updated)
        else
          # C-2: served ON the thread — the object (and any reply-reference
          # channel ids inside it) re-renders onto the thread id, which is
          # what a client keys its message cache on.
          MessageCodec.messages([updated], channel_id: channel_id) |> hd()
        end
        |> MessageCodec.put_reactions(scope, updated.id, claims.user_id)

      json(conn, rendered)
    else
      {:error, :missing_permissions} -> Errors.missing_permissions(conn)
      {:error, :invalid_body} -> Errors.invalid_form_body(conn)
      {:error, :not_author} -> Errors.missing_permissions(conn)
      _ -> Errors.unknown_message(conn)
    end
  end

  @doc "DELETE /channels/{id}/messages/{mid} — author-only, 204 empty."
  def delete(conn, %{"channel_id" => cid, "message_id" => mid}) do
    claims = conn.assigns.current_user

    with {:ok, channel_id} <- Snowflake.parse(cid),
         {:ok, scope, bits} <- Authorize.scope(claims, channel_id),
         :ok <- Bitfield.require_bit(bits, :send_messages),
         {:ok, message_id} <- Snowflake.parse(mid),
         msg when msg != nil <- Messages.get_message(scope, message_id),
         :ok <- author_only(msg, claims) do
      :ok = Messages.delete_message(scope, message_id, thread_id: msg.thread_id)
      if msg.thread_id, do: :ok = Thread.record_reply_removed(msg.thread_id)

      # The native fan-out key (the storage partition); the payload carries
      # the thread scope when there is one, and the dispatch translation
      # re-anchors a thread reply's delete onto the thread for compat sessions.
      Publish.publish(scope, {"MessageDelete", Messages.Events.message_delete(msg)})

      send_resp(conn, 204, "")
    else
      {:error, :missing_permissions} -> Errors.missing_permissions(conn)
      {:error, :not_author} -> Errors.missing_permissions(conn)
      _ -> Errors.unknown_message(conn)
    end
  end

  @doc """
  POST /channels/{id}/messages/{mid}/ack — Discord's read-ack route (compat,
  C-4). The channel gate runs, then the NATIVE ack logic records read_state
  for the CALLING PRINCIPAL (per-principal read-state, R4: a machine
  principal's ack writes its own row — its parent's never moves) and fans
  MessageAck back to the caller's own sockets, byte-identical to the native
  `MessageController.ack` single-message shape. 200 `{"token": null}` —
  Discord's shape; Cytale synthesizes no read-state token.

  A THREAD id acks the THREAD's read watermark (#83 compat-surface
  remainder — the route 404'd on a thread before): the same
  `Threads.Member.mark_read` the native follow-state PATCH drives, never
  regressing and a no-op for a principal with no membership row (the
  two-tier unread badge is a member concept; an ack must not mint one).
  """
  def ack(conn, %{"channel_id" => cid, "message_id" => mid}) do
    claims = conn.assigns.current_user

    with {:ok, channel_id} <- Snowflake.parse(cid),
         {:ok, message_id} <- Snowflake.parse(mid) do
      case Authorize.channel_gate(claims, channel_id) do
        {:ok, _channel, _bits} ->
          user_id = claims.user_id
          now = DateTime.utc_now() |> DateTime.truncate(:millisecond)

          # Same writer as the native route — the two surfaces must not drift on
          # which columns an ack owns (plan U1).
          :ok = Cytale.Messages.ReadState.write(user_id, channel_id, %{last_read_id: message_id})

          # #117: and the same answered-mention sweep the native ack runs, for the
          # same reason — an acknowledgement is what answers the mentions it
          # covers, and the sweep deletes event rows only (never a watermark).
          Cytale.Inbox.mark_done_through(user_id, channel_id, message_id)

          payload = %{
            channel_id: Integer.to_string(channel_id),
            message_ids: [message_id],
            user_id: Integer.to_string(user_id),
            acknowledged_at: DateTime.to_iso8601(now)
          }

          CytaleWeb.GatewaySocket.fan_out(
            PushRegistry.user_key(Integer.to_string(user_id)),
            {"MessageAck", payload}
          )

          json(conn, %{"token" => nil})

        {:error, _} ->
          # C-2 thread branch: the thread's read state lives on the membership
          # row, not in channel read_state — the native watermark writer.
          with %{} = t <- Thread.get(channel_id),
               {:ok, _parent, _bits} <- Authorize.channel_gate(claims, t.channel_id) do
            :ok = Member.mark_read(t.thread_id, claims.user_id, message_id)

            json(conn, %{"token" => nil})
          else
            _ -> Errors.unknown_channel(conn)
          end
      end
    else
      _ -> Errors.unknown_channel(conn)
    end
  end

  # -- C-2 scope resolution -------------------------------------------------------

  # The WRITE scope for POST /channels/{id}/messages: a channel id gates as
  # itself; a non-channel id gets the thread fallback — the gate anchors on
  # the PARENT (thread visibility rides the parent's rights), so every miss
  # still renders the identical 10003 and a thread never leaks existence.
  # Returns {:ok, storage_scope, bits, parent_row}: storage_scope is the
  # parent's partition when the id was a thread, the channel id otherwise.
  defp write_scope(claims, channel_id) do
    case Authorize.channel_gate(claims, channel_id) do
      {:ok, channel, bits} ->
        {:ok, channel_id, bits, channel}

      {:error, _} ->
        with %{} = t <- Thread.get(channel_id),
             {:ok, parent, bits} <- Authorize.channel_gate(claims, t.channel_id) do
          {:ok, t.channel_id, bits, parent}
        else
          _ -> {:error, :unknown_channel}
        end
    end
  end

  # -- gates ----------------------------------------------------------------------

  # Discord message objects carry `reactions` when present ({count, me,
  # emoji: {id: null, name}}) — ABSENT otherwise. The `me` flag is against
  # the CALLING principal (the bot reading its own history).
  #
  # ONE batched read for the whole page (hardening plan 2.1): this was
  # `put_reactions/4` per message, i.e. two point reads per row — the compat twin
  # of the native page's per-message reaction render.
  defp attach_reactions(objects, rows, viewer_id) do
    objects
    |> Enum.zip(rows)
    |> MessageCodec.put_reactions_many(viewer_id)
  end

  defp author_only(%{author_id: author_id}, %{user_id: user_id}) when author_id == user_id, do: :ok
  defp author_only(_msg, _claims), do: {:error, :not_author}

  # The edit body (Discord's message edit): `embeds`/`components` from a
  # machine author (validated under the create's caps; a person's are
  # ignored, as on create), and the content — kept when absent or null,
  # otherwise the send's rule against the embeds the message will carry.
  # Nothing to edit is a 50035, never a silent no-op.
  defp edit_body(params, msg, claims) do
    machine? = Cytale.Permissions.Principal.machine_kind?(Map.get(claims, :kind))
    components = if machine?, do: params["components"]
    embeds = if machine?, do: params["embeds"]

    with :ok <- valid_edit(Messages.validate_components(components)),
         :ok <- valid_edit(Messages.validate_embeds(embeds)),
         {:ok, content} <- edit_content(params["content"], msg, embeds, components) do
      {:ok, %{content: content, components: components, embeds: embeds}}
    end
  end

  defp valid_edit(:ok), do: :ok
  defp valid_edit({:error, _}), do: {:error, :invalid_body}

  defp edit_content(nil, _msg, nil, nil), do: {:error, :invalid_body}
  defp edit_content(nil, msg, _embeds, _components), do: {:ok, msg.content || ""}

  defp edit_content(content, msg, embeds, _components) do
    case Messages.SendBody.content(content, embeds || Map.get(msg, :embeds) || []) do
      {:ok, content} -> {:ok, content}
      {:error, :invalid_content} -> {:error, :invalid_body}
    end
  end

  # Discord's reply shape: message_reference carries message_id (+ ignored
  # extras like type). Only the id is read here; whether it names a message
  # in this conversation is the send pipeline's rule — a dangling or
  # out-of-scope id is a validation failure, not a 404 oracle.
  defp reply_to_id(nil), do: {:ok, nil}

  defp reply_to_id(%{"message_id" => mid}) do
    case Snowflake.parse(id_to_bin(mid)) do
      {:ok, message_id} -> {:ok, message_id}
      :error -> {:error, :invalid_body}
    end
  end

  defp reply_to_id(_), do: {:error, :invalid_body}

  defp id_to_bin(id) when is_integer(id), do: Integer.to_string(id)
  defp id_to_bin(id) when is_binary(id), do: id
  defp id_to_bin(_), do: ""

  # Whitelisted attachment descriptors (the upload-first flow's shape);
  # stringified values are what the domain persists. Every PRESENT value
  # must be a scalar (string/number/boolean) — a nil/map/list value is a
  # 400 50035, never a 500 from `to_string/1` raising on the wire shape
  # (mirrors the embeds/components validation: a non-list container or a
  # non-map entry is the same 400). Shared normalization lives in
  # `Messages.normalize_attachments/1`.
  defp create_attachments(conn, body, files) do
    case MultipartUpload.store(conn, files) do
      # No files (or a JSON body): the metadata array rides as today.
      {:ok, []} -> Messages.normalize_attachments(body["attachments"])
      # Stored files REPLACE the payload_json.attachments index-map metadata.
      {:ok, stored_attachments} -> {:ok, stored_attachments}
      {:error, _} = err -> err
    end
  end

  defp maybe_nonce(payload, nonce) when nonce != nil, do: Map.put(payload, "nonce", nonce)
  defp maybe_nonce(payload, _), do: payload

  # -- parsing -----------------------------------------------------------------------
end
