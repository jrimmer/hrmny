defmodule CytaleWeb.MessageController do
  @moduledoc """
  U9 — message surface: history (cursor-paginated, newest-first), send
  (idempotent + fan-out seam), read/edit/delete one. Persistence lives in
  `Cytale.Messages`; realtime fan-out rides the `Cytale.Publish` seam
  (no-op/log impl until U11's workspace process lands).
  """

  use CytaleWeb, :controller

  alias Cytale.Gateway.PushRegistry
  alias Cytale.Messages
  alias Cytale.Messages.Reactions
  alias Cytale.Publish
  alias Cytale.Workspaces
  alias CytaleWeb.Compat.Authorize
  import CytaleWeb.API.Params, only: [parse_limit: 2, snowflake: 1, snowflake_opt: 1]
  import CytaleWeb.API.Error, only: [error: 4]

  @doc "GET /channels/{id}/messages?before=&limit= — newest-first page."
  def index(conn, %{"channel_id" => id} = params) do
    %{user_id: viewer_id} = conn.assigns.current_user

    with {:ok, channel_id} <- snowflake(id),
         # The uniform channel gate (#35 P0-1): view rights through the SAME
         # seam the compat surface uses — the existence-only check this
         # route once relied on leaked every workspace's history to any
         # authenticated account. (View is the correct human-surface bound:
         # the synthetic @everyone base grants view_channel to members but
         # no default role distributes read_message_history, so demanding
         # it here would 403 every non-owner member — that bit's policy
         # story is #35 S-P2-14's, not this gate's.)
         {:ok, _channel, _bits} <- Authorize.channel_gate(conn.assigns.current_user, channel_id),
         {:ok, cursor} <- history_cursor(params) do
      page =
        Messages.history(channel_id, [limit: parse_limit(params["limit"], default: 50, cap: 100)] ++ cursor)

      messages = page_json(channel_id, page, viewer_id)
      json(conn, Map.merge(%{"messages" => messages}, page_cursors(messages)))
    else
      {:error, :both_cursors} -> both_cursors_error(conn)
      _ -> error(conn, 404, "channel_not_found", "No channel with that id")
    end
  end

  @doc """
  The history cursor from `before` / `after` (#152): exclusive snowflakes, at
  most one of them. Shared by the channel and thread indexes.
  """
  def history_cursor(params) do
    case {snowflake_opt(params["before"]), snowflake_opt(params["after"])} do
      {nil, nil} -> {:ok, []}
      {before, nil} -> {:ok, [before: before]}
      {nil, after_id} -> {:ok, [after: after_id]}
      _ -> {:error, :both_cursors}
    end
  end

  @doc """
  Explicit page cursors (#152), always both: `oldest_id` pages OLDER (pass it
  as `before`), `newest_id` pages NEWER (pass it as `after`). Pages are
  newest-first, so they are the last and first ids; `null` on an empty page
  (the empty page itself says there is nothing further that way).
  """
  def page_cursors([]), do: %{"oldest_id" => nil, "newest_id" => nil}

  def page_cursors(messages) do
    %{"oldest_id" => List.last(messages)["id"], "newest_id" => List.first(messages)["id"]}
  end

  def both_cursors_error(conn),
    do: error(conn, 400, "validation_failed", "pass at most one of before / after")

  @doc """
  POST /channels/{id}/ack — read acknowledgement. Persists the high-water
  mark in read_state (thread acks ride the same table: the thread's id
  occupies the channel_id column) and fans MESSAGE_ACK back to the user's
  sockets so other devices converge.

  U2 (terminal plan, R22): the body may also carry `unread_floor`, the
  EXCLUSIVE counterpart of the watermark — "this message and everything after
  it is unread". Three states, and the distinction is the contract:

    * **absent** — the ack owns the watermark only, and the floor is left
      exactly as the member set it: an acknowledgement that cleared a hand-set
      unread range would silently undo the member's own action (the
      partial-write rule `Cytale.Messages.ReadState` documents).
    * **a snowflake** — set the floor. `ReadState.unread_since/3` then outranks
      the watermark with it, so the message the member marked stays unread even
      though this same request acknowledges everything before it. Accepted as
      the decimal string every other id on this API travels as, or as a JSON
      number.
    * **null** — clear the floor: "read this range after all".

  A floor that is not a snowflake is a 400 rather than a silent no-op. A floor
  naming no message is not looked up: it is the member's own read state, and a
  value that matches nothing matches nothing.
  """
  def ack(conn, %{"channel_id" => cid, "message_ids" => ids} = params)
      when is_list(ids) and ids != [] do
    %{user_id: user_id} = conn.assigns.current_user

    with {:ok, channel_id} <- snowflake(cid),
         # The uniform channel gate (#35 P0-1): read_state rows (and the
         # MessageAck fan-out) were writable for arbitrary channel ids —
         # same IDOR class as the history read above.
         {:ok, _channel, _bits} <- Authorize.channel_gate(conn.assigns.current_user, channel_id),
         {:ok, last_read} <- max_snowflake(ids),
         {:ok, floor} <- unread_floor(params) do
      now = DateTime.utc_now() |> DateTime.truncate(:millisecond)

      # The acknowledgement owns the watermark only. `unread_floor` is
      # deliberately absent here: an ack must not clear a range the member
      # marked unread by hand (plan U1, R17).
      :ok = Messages.ReadState.write(user_id, channel_id, %{last_read_id: last_read})

      # ... and the floor is applied separately, in the one shape that says what
      # the request meant (set / clear / leave alone).
      :ok = apply_unread_floor(user_id, channel_id, floor)
      # A floor set or cleared here moved read state the member's OTHER
      # devices cannot infer from MessageAck (which carries no floor): tell
      # them (#54).
      if floor != :leave, do: :ok = Messages.ReadState.broadcast_update(user_id, channel_id)

      # #117: the ack is also what ANSWERS the mentions it covers. Same
      # mechanism, extended — the row the watermark already speaks about is
      # deleted rather than tracked a second time, so reading a channel never
      # leaves its mentions behind forever. It moves read_state and only
      # read_state: what it deletes is event rows, which is why the badge, the
      # divider and the inbox can never disagree about what "read" means.
      Cytale.Inbox.mark_done_through(user_id, channel_id, last_read)

      payload = %{
        channel_id: Integer.to_string(channel_id),
        message_ids: Enum.map(ids, &String.to_integer/1),
        user_id: Integer.to_string(user_id),
        acknowledged_at: DateTime.to_iso8601(now)
      }

      CytaleWeb.GatewaySocket.fan_out(PushRegistry.user_key(Integer.to_string(user_id)), {"MessageAck", payload})

      json(conn, %{"acknowledged" => Integer.to_string(last_read)})
    else
      {:error, :invalid_unread_floor} ->
        error(conn, 400, "validation_failed", "unread_floor must be a message id")

      _ ->
        error(conn, 404, "channel_not_found", "No channel with that id")
    end
  end

  def ack(conn, _params), do: error(conn, 400, "validation_failed", "message_ids is required")

  # `:leave` (the key was absent), `:clear` (JSON null) or a message id —
  # accepted as the decimal string every other id on this API travels as, or as
  # a JSON number, because both spellings mean one thing.
  defp unread_floor(params) do
    case params do
      %{"unread_floor" => nil} -> {:ok, :clear}
      %{"unread_floor" => value} -> parse_unread_floor(value)
      _absent -> {:ok, :leave}
    end
  end

  defp parse_unread_floor(value) when is_integer(value) and value > 0, do: {:ok, value}

  defp parse_unread_floor(value) when is_binary(value) do
    case snowflake(value) do
      {:ok, floor} -> {:ok, floor}
      :error -> {:error, :invalid_unread_floor}
    end
  end

  defp parse_unread_floor(_value), do: {:error, :invalid_unread_floor}

  defp apply_unread_floor(_user_id, _channel_id, :leave), do: :ok

  defp apply_unread_floor(user_id, channel_id, :clear),
    do: Messages.ReadState.clear_unread_floor(user_id, channel_id)

  defp apply_unread_floor(user_id, channel_id, floor),
    do: Messages.ReadState.write(user_id, channel_id, %{unread_floor: floor})

  @doc """
  POST /channels/{id}/typing — REST fallback for the TYPING_START signal.
  Gated by the compat-style uniform channel gate (the principal-rights
  resolver; parent fallback + restrictions for machine principals): a
  channel the caller cannot view does not exist as far as this route is
  concerned — the identical 404 anti-enumeration shape, never a 403 oracle.
  DM channel ids resolve through recipient membership (B-1) and fan to both
  participants' user-key sessions.
  """
  def typing(conn, %{"channel_id" => cid} = params) do
    %{user_id: user_id} = conn.assigns.current_user

    with {:ok, channel_id} <- snowflake(cid),
         {:ok, _channel, _bits} <- Authorize.channel_gate(conn.assigns.current_user, channel_id) do
      payload = Cytale.Gateway.Payloads.typing_start(channel_id, user_id, params["thread_id"])

      # The typing rule (#80) holds on every origin, not just the socket op:
      # the caller's OWN sessions are excluded, so the REST fallback cannot
      # echo "you are typing" into the caller's second device either.
      # `resolved: :channel`: the channel gate above accepted a WORKSPACE channel,
      # so the fan-out need not read `dm_channels` to learn it is not a DM
      # (hardening plan 5.2) — this is the typing hot path.
      Cytale.Workspaces.FanOut.deliver(channel_id, {"TypingStart", payload},
        except: {:user, user_id},
        resolved: :channel
      )

      json(conn, %{"ok" => true})
    else
      _ -> error(conn, 404, "channel_not_found", "No channel with that id")
    end
  end

  def typing(conn, _params), do: error(conn, 400, "validation_failed", "channel_id is required")

  defp max_snowflake(ids) do
    ids
    |> Enum.reduce_while({:ok, nil}, fn id, {:ok, acc} ->
      case snowflake(id) do
        {:ok, v} -> {:cont, {:ok, max(v, acc || v)}}
        :error -> {:halt, :error}
      end
    end)
    |> case do
      {:ok, nil} -> :error
      ok -> ok
    end
  end

  @doc """
  POST /channels/{id}/messages — send. Idempotency-Key honored (pipeline);
  publish rides the Cytale.Publish seam (MESSAGE_CREATE payload matches the
  U2 protocol event). Accepts an `attachments` array of the upload
  descriptors (`{id?, url, filename, content_type, size}` — the shape
  `POST /channels/{id}/attachments` returns), normalized through
  `Messages.normalize_attachments/1`. The composed body — `content`,
  `embeds`, `components` — is `Cytale.Messages.SendBody`'s, the same parser
  the compat send uses: a bot's embeds and action rows are accepted under
  the shared caps (embed-only included); a person's embeds are a 400
  `embeds_not_allowed` and a person's `components` are ignored (R1).
  """
  #
  # THE SEND PATH (review #18/#21). What it costs, in order:
  #
  #   1. the permission gate (plug) — memoized per {user, channel} under the
  #      workspace's RightsEpoch, and it hands the channel's route (workspace
  #      channel or DM row) over in `conn.assigns.channel_route`, so nothing
  #      below reads `channels_by_id` / `dm_channels` again;
  #   2. a reply only: ONE read of the referenced message (it both validates
  #      the reference and becomes the reply snapshot) plus its author row;
  #   3. with a nonce: the durable dedupe reservation (one LWT) — see
  #      `Cytale.Messages.Nonces` and `Cytale.Messages.Send`;
  #   4. the insert batch (+ the mention leg; the DM search leg only for DMs);
  #   5. the publish CAST — immediately, and with the route in hand;
  #   6. the 201, rendered from the SAME JSON the publish carried (a brand-new
  #      message has no reactions, so there is nothing viewer-specific to
  #      re-render and no reaction read to make).
  #
  # The `last_message_id` pointer write is deferred and coalesced
  # (`Cytale.Messages.PointerWriter`); it was a synchronous tail on the 201.
  def create(conn, %{"channel_id" => id} = params) do
    accepted_at = System.monotonic_time(:millisecond)
    %{user_id: user_id} = conn.assigns.current_user

    with {:ok, channel_id} <- snowflake(id),
         {:ok, route} <- channel_route(conn, channel_id),
         {:ok, composed} <- Messages.SendBody.parse(params, conn.assigns.current_user),
         {:ok, attachments} <- attachments_param(params["attachments"]),
         {:ok, thread_id} <- thread_reference(channel_id, params["thread_id"]),
         {:ok, reply_to_id} <- reply_to_id(params["reply_to_id"]) do
      attrs =
        Map.merge(composed, %{
          channel_id: channel_id,
          author_id: user_id,
          thread_id: thread_id,
          reply_to_id: reply_to_id,
          attachments: attachments,
          channel_kind: channel_kind(route),
          nonce: send_nonce(conn, params)
        })

      # The shared send pipeline: the durable dedupe (claim / replay /
      # re-drive / cross-use conflict), the write, the dispatch and the nonce
      # echo. This route owns only its parsing and its rendering.
      #
      # A body `thread_id` makes the send a THREAD REPLY, and a thread reply is
      # one thing whichever route posts it: the `:thread_reply` kind is the
      # native reply route's (`POST /threads/{id}/messages`) — the dual
      # emission, the author's auto-follow, the thread's reply counters, the
      # reply reference scoped to the thread. Written as a channel message it
      # landed in the thread with none of those.
      kind = if thread_id, do: :thread_reply, else: :channel
      result = Messages.Send.post(attrs, kind: kind, route: route, accepted_at: accepted_at)

      conn = respond_created(conn, result, kind)

      :telemetry.execute(
        [:cytale, :message, :post_ms],
        %{duration_ms: System.monotonic_time(:millisecond) - accepted_at},
        %{status: conn.status}
      )

      conn
    else
      {:error, :no_channel} ->
        error(conn, 404, "channel_not_found", "No channel with that id")

      {:error, :bad_reference} ->
        bad_reference(conn, :channel)

      {:error, :bad_thread} ->
        error(conn, 400, "validation_failed", "thread_id must reference a thread in this channel")

      {:error, :bad_attachments} ->
        error(conn, 400, "validation_failed", "attachments entries must be scalar-valued descriptor maps")

      {:error, reason} ->
        send_body_error(conn, reason)
    end
  end

  @doc false
  # The native rendering of `Cytale.Messages.SendBody`'s refusals, shared by
  # both native send routes.
  def send_body_error(conn, :embeds_not_allowed) do
    error(
      conn,
      400,
      "embeds_not_allowed",
      "Embeds are accepted from bots and integrations only; a person's message carries content, attachments and links."
    )
  end

  def send_body_error(conn, :invalid_embeds),
    do: error(conn, 400, "invalid_embeds", "embeds must be a list of at most 10 objects, each at most 8 KB")

  def send_body_error(conn, :invalid_allowed_mentions) do
    error(
      conn,
      400,
      "validation_failed",
      "allowed_mentions must be {parse?, users?, roles?, replied_user?} — parse a subset of users/roles/everyone, " <>
        "at most 100 ids each, and never both parse users and a users list"
    )
  end

  def send_body_error(conn, :invalid_components),
    do: error(conn, 400, "invalid_components", "components exceed the action-row limits")

  def send_body_error(conn, _invalid_content),
    do: error(conn, 400, "validation_failed", "content must be 1-4000 bytes")

  @doc false
  # The native rendering of a send pipeline result — shared by both native
  # send routes (this one and `ThreadController.reply`), so the envelope,
  # the statuses and the error bodies cannot drift between them. `kind` is
  # the message kind the pipeline wrote (it names the conversation a refused
  # reply reference had to be in).
  def respond_created(conn, {:created, %{wire: json}}, _kind),
    do: conn |> put_status(201) |> json(%{"message" => json})

  # A retry of a send that already landed: the ORIGINAL message, 200 (not a
  # second 201 — nothing was created by this request).
  def respond_created(conn, {:existing, %{wire: json}}, _kind),
    do: conn |> put_status(200) |> json(%{"message" => json})

  def respond_created(conn, {:conflict, :nonce_reused}, _kind) do
    error(conn, 409, "idempotency_conflict", "This nonce was already used for another message.")
  end

  def respond_created(conn, {:error, :bad_reference}, kind), do: bad_reference(conn, kind)

  # The one 400 for a reply reference outside the send's conversation (the
  # pipeline's rule — `Cytale.Messages.Send`).
  defp bad_reference(conn, :thread_reply),
    do: error(conn, 400, "validation_failed", "reply_to_id must reference a message in this thread")

  defp bad_reference(conn, _kind),
    do: error(conn, 400, "validation_failed", "reply_to_id must reference a message in this channel")

  # The client's per-message retry key: the body `nonce` (what the web client
  # mints once per composed message and reuses on every retry), else the
  # Idempotency-Key header the API client sends with the same value. Every
  # send route (native and compat, channel and thread) reads it the same way,
  # so all of them dedupe and echo on the same key.
  @doc false
  def send_nonce(conn, params) do
    Messages.Nonces.normalize(params["nonce"]) ||
      case get_req_header(conn, "idempotency-key") do
        [key | _] -> Messages.Nonces.normalize(key)
        _ -> nil
      end
  end

  # The route the permission gate resolved (review #18) — or, for a caller
  # that reached here without it, the existence check the gate implies.
  defp channel_route(conn, channel_id) do
    case conn.assigns[:channel_route] do
      {:channel, _ws} = route -> {:ok, route}
      {:dm, _dm} = route -> {:ok, route}
      _ -> channel_exists(channel_id)
    end
  end

  defp channel_kind({:channel, _ws}), do: :channel
  defp channel_kind({:dm, dm}), do: {:dm, dm}
  defp channel_kind(_), do: nil

  @doc """
  GET /channels/{id}/messages/{mid} — the permalink resolver (#114): one
  message by id, in the shape every other read renders it.

  Gated by the uniform channel gate (#35 P0-1) exactly like `index` above —
  view rights through `CytaleWeb.Compat.Authorize.channel_gate/2`, which
  covers workspace channels (resolver + restrictions), DM channels
  (participation) and thread replies (the PARENT channel's rights; a thread
  is not addressable here, the reply's own `thread_id` rides the payload).

  Every miss renders ONE 404 body — a malformed id, a channel the caller
  cannot view, a channel that does not exist, and a message that does not
  exist are indistinguishable. That is deliberate and load-bearing: this
  route takes two ids from a URL a stranger can write, so a body that varied
  by miss (or a 403 for the visible-but-forbidden case) would let it
  enumerate channels and messages the caller was never granted.
  """
  def show(conn, %{"channel_id" => cid, "message_id" => mid}) do
    %{user_id: viewer_id} = conn.assigns.current_user

    with {:ok, channel_id} <- snowflake(cid),
         {:ok, _channel, _bits} <- Authorize.channel_gate(conn.assigns.current_user, channel_id),
         {:ok, message_id} <- snowflake(mid),
         msg when not is_nil(msg) <- Messages.get_message(channel_id, message_id) do
      json(conn, %{"message" => message_json(msg, viewer_id)})
    else
      _ -> error(conn, 404, "message_not_found", "No message with that id")
    end
  end

  @doc "PATCH /channels/{id}/messages/{mid} — author-only edit."
  def update(conn, %{"channel_id" => cid, "message_id" => mid, "content" => content}) do
    %{user_id: user_id} = conn.assigns.current_user

    with {:ok, channel_id} <- snowflake(cid),
         {:ok, message_id} <- snowflake(mid),
         msg when not is_nil(msg) <- Messages.get_message(channel_id, message_id),
         true <- msg.author_id == user_id,
         true <- is_binary(content) and byte_size(content) > 0 and byte_size(content) <= 4_000 do
      :ok = Messages.edit_message(channel_id, message_id, content)

      updated = Messages.get_message(channel_id, message_id)
      Publish.publish(channel_id, {"MessageUpdate", message_json(updated)})

      json(conn, %{"message" => message_json(updated, user_id)})
    else
      msg when not is_nil(msg) -> error(conn, 403, "forbidden", "Only the author may edit a message.")
      false -> error(conn, 400, "validation_failed", "content must be 1-4000 bytes")
      _ -> error(conn, 404, "message_not_found", "No message with that id")
    end
  end

  def update(conn, _params), do: error(conn, 400, "validation_failed", "content is required")

  @doc "DELETE /channels/{id}/messages/{mid} — author or MANAGE_MESSAGES (pipeline)."
  def delete(conn, %{"channel_id" => cid, "message_id" => mid}) do
    %{user_id: user_id} = conn.assigns.current_user

    with {:ok, channel_id} <- snowflake(cid),
         {:ok, message_id} <- snowflake(mid),
         msg when not is_nil(msg) <- Messages.get_message(channel_id, message_id),
         true <- msg.author_id == user_id do
      :ok = Messages.delete_message(channel_id, message_id, thread_id: msg.thread_id)
      if msg.thread_id, do: :ok = Cytale.Threads.Thread.record_reply_removed(msg.thread_id)

      Publish.publish(channel_id, {"MessageDelete", Messages.Events.message_delete(msg)})

      json(conn, %{"deleted" => Integer.to_string(message_id)})
    else
      msg when not is_nil(msg) ->
        error(conn, 403, "forbidden", "Only the author may delete a message (MANAGE_MESSAGES grants the admin path).")

      _ ->
        error(conn, 404, "message_not_found", "No message with that id")
    end
  end

  # -- helpers -------------------------------------------------------------------

  # Existence check for WRITES when the gate handed over no route: the
  # permission plug has already authorized (DM participants included, B-1) —
  # this only confirms the id is a real channel of either kind (workspace
  # channel or DM row), and returns what it found as the route.
  defp channel_exists(channel_id) do
    case Workspaces.get_channel(channel_id) do
      %{workspace_id: ws_id} ->
        {:ok, {:channel, ws_id}}

      nil ->
        case Workspaces.get_dm(channel_id) do
          nil -> {:error, :no_channel}
          dm -> {:ok, {:dm, dm}}
        end
    end
  end

  # History's gate is the uniform channel seam (above) — view rights via
  # the resolver for workspace channels, participation for DMs (B-1), the
  # identical 404 for every miss (no existence oracle).

  # The reply reference's id (`reply_to_id`, a snowflake string). Whether it
  # names a message in this conversation is the send pipeline's rule
  # (`Cytale.Messages.Send`) — one check for every route; a malformed id is
  # the same validation failure a dangling one is.
  @doc false
  def reply_to_id(nil), do: {:ok, nil}

  def reply_to_id(bin) when is_binary(bin) do
    case snowflake(bin) do
      {:ok, message_id} -> {:ok, message_id}
      :error -> {:error, :bad_reference}
    end
  end

  def reply_to_id(_), do: {:error, :bad_reference}

  # A body `thread_id` writes the thread's locator row, so it must name a
  # thread whose PARENT is this channel — otherwise a member of any channel
  # could inject messages into a thread they cannot see (the permission gate
  # only ran against the path's channel). An absent or unparseable id keeps
  # the historical meaning: a plain channel message.
  defp thread_reference(channel_id, raw) do
    case snowflake_opt(raw) do
      nil ->
        {:ok, nil}

      thread_id ->
        case Cytale.Threads.Thread.get(thread_id) do
          %{channel_id: ^channel_id} -> {:ok, thread_id}
          _ -> {:error, :bad_thread}
        end
    end
  end

  defp attachments_param(list) do
    case Messages.normalize_attachments(list) do
      {:ok, attachments} -> {:ok, attachments}
      {:error, :invalid_attachments} -> {:error, :bad_attachments}
    end
  end

  # The referenced snapshot (Discord's referenced_message): everything a
  # receiver needs to render the reply context line without a fetch.
  defp referenced({channel_id, reply_to_id}) when is_integer(reply_to_id) and is_integer(channel_id) do
    case Messages.get_message(channel_id, reply_to_id) do
      nil -> nil
      orig -> reference_snapshot(orig)
    end
  end

  # No reference (null/absent) or non-integer payload: nothing to embed.
  defp referenced(_), do: nil

  @doc false
  # Shared with thread replies (ThreadController.reply).
  def reference_snapshot(orig) do
    author = Cytale.Accounts.User.get(orig.author_id)

    %{
      "message_id" => Integer.to_string(orig.id),
      "author_id" => Integer.to_string(orig.author_id),
      "author_username" => author && author.username,
      "content" => String.slice(orig.content || "", 0, 80)
    }
  end

  @doc """
  The native message projection — PUBLIC since U11: the webhook execute path
  publishes through the SAME shape a human/bot write uses (KD2 merge parity);
  the compat controller's private mirror stays pending U7's codec unification.

  `viewer_id` (optional, default nil) is the recipient the `"reactions"`
  entries' `me` flag is computed against (the controller seam threads
  `conn.assigns.current_user.user_id` in). A nil viewer — the publish/fan-out
  projections — renders `me: false` where reactions exist (a fan-out has no
  single recipient; the key stays ABSENT when the message has none).
  """
  @spec message_json(Messages.t() | map(), integer() | nil) :: map()
  def message_json(m, viewer_id \\ nil), do: message_json(m, viewer_id, :point)

  # `reactions` is `:point` (render this one message — the single-message
  # surfaces: create/update/delete responses and the fan-out projection) or an
  # already-rendered list/nil from a PAGE's batched read (hardening plan 2.1).
  @doc false
  @spec message_json(Messages.t() | map(), integer() | nil, [map()] | nil | :point) :: map()
  def message_json(m, viewer_id, reactions) do
    %{
      "id" => Integer.to_string(m.id),
      "channel_id" => Integer.to_string(m.channel_id),
      "author_id" => Integer.to_string(m.author_id),
      "content" => m.content,
      "thread_id" => m.thread_id && Integer.to_string(m.thread_id),
      "reply_to_id" => m.reply_to_id && Integer.to_string(m.reply_to_id),
      # A create already holds the snapshot (it read the referenced message
      # to validate the reference); every other render reads it here.
      "referenced" =>
        case Map.fetch(m, :referenced_snapshot) do
          {:ok, snapshot} -> snapshot
          :error -> referenced({m.channel_id, Map.get(m, :reply_to_id)})
        end,
      "created_at" => DateTime.to_iso8601(m.created_at),
      "edited_at" => m.edited_at && DateTime.to_iso8601(m.edited_at),
      "attachments" => Messages.wire_attachments(m.attachments)
    }
    |> maybe_embeds(Map.get(m, :embeds))
    |> Cytale.MediaProxy.put_content_proxy_urls(m.content)
    |> maybe_components(Map.get(m, :components))
    |> maybe_author_override(Map.get(m, :author_override))
    |> maybe_mention_everyone(Map.get(m, :mention_everyone))
    |> Messages.Message.put_mention_user_ids(Map.get(m, :mention_user_ids))
    |> maybe_reactions(
      case reactions do
        :point -> Reactions.render(m.channel_id, m.id, viewer_id)
        rendered -> rendered
      end
    )
  end

  # Discord's `mention_everyone`: whether this message's `@everyone`/`@here`
  # was allowed to notify (the author held the bit — `BroadcastGate`). Known
  # only on the CREATE path (the verdict is not stored), so it rides the
  # create response and dispatch and is absent from history reads.
  defp maybe_mention_everyone(json, verdict) when is_boolean(verdict),
    do: Map.put(json, "mention_everyone", verdict)

  defp maybe_mention_everyone(json, _), do: json

  # A page's messages rendered with ONE batched reaction read (hardening plan
  # 2.1): `render/3` per row meant 2 point reads per message — 200 for a
  # 100-message page. Shape-identical to the per-message path; a message with no
  # reactions is simply absent from the map, which is the `nil` that keeps the
  # wire key off.
  @doc false
  # Shared with the thread history read (ThreadController.index): one row
  # shape for a channel page and a thread page.
  def page_json(channel_id, messages, viewer_id) do
    reactions =
      Reactions.render_many(channel_id, Enum.map(messages, &Map.take(&1, [:id, :bucket])), viewer_id)

    Enum.map(messages, &message_json(&1, viewer_id, Map.get(reactions, &1.id)))
  end

  @doc """
  Create a message, publish its `MessageCreate` dispatch, and denormalize the
  channel's `last_message_id` — the three steps every authoring surface must
  perform TOGETHER (hardening plan 3.10).

  They were three lines repeated at every call site, with the invariant upheld
  only by each caller remembering the last two; a site that forgot
  `touch_last_message/2` left the sidebar badge and the unread pointer stale, and
  that failure is invisible in a response body. Both steps now live here.
  """
  @spec create_and_publish(map()) :: {:ok, Messages.t()} | {:error, term()}
  def create_and_publish(attrs) do
    {nonce, attrs} = Map.pop(attrs, :nonce)

    with {:ok, message} <- Messages.create_message(attrs) do
      publish_created(message, nonce)
      {:ok, message}
    end
  end

  @doc """
  The last two of those three steps, for a message some OTHER path created
  (`Webhooks.execute/4`, and the interaction flows whose `mark_ack` must keep its
  place BETWEEN the create and the dispatch — moving that call would change what
  survives a raising fan-out).

  Split out rather than folded into `create_and_publish/1` so those callers share
  the publish+denormalize pair without reordering their side effects.
  """
  @spec publish_created(Messages.t(), String.t() | nil) :: :ok
  def publish_created(message, nonce \\ nil) do
    Publish.publish(message.channel_id, {"MessageCreate", message |> message_json() |> put_nonce(nonce)})
    Messages.touch_last_message(message.channel_id, message.id)
  end

  # U10 (KTD11): the native message JSON carries "embeds" ONLY when the
  # message stored some — the key is ABSENT otherwise (additive growth; every
  # other field stays byte-identical).
  # External embed media gains its signed `proxy_url` here (Cytale.MediaProxy):
  # the stored embed keeps the producer's URL; the proxy URL is minted per render.
  defp maybe_embeds(json, embeds) when is_list(embeds) and embeds != [],
    do: Map.put(json, "embeds", Cytale.MediaProxy.wire_embeds(embeds))

  defp maybe_embeds(json, _), do: json

  # Components plan U1 (R2): same optional-key growth for action rows — the
  # key is ABSENT when the message stored none (the embeds precedent).
  # Components only ever enter through Bot-auth surfaces (R1); the native
  # create below ignores the key entirely, so "components ⇒ machine author"
  # holds by construction.
  defp maybe_components(json, components) when is_list(components) and components != [],
    do: Map.put(json, "components", components)

  defp maybe_components(json, _), do: json

  # U11 (KTD12): same optional-key growth for the webhook per-message author
  # override — present ONLY when an override row exists.
  defp maybe_author_override(json, override) when is_map(override) and override != %{},
    do: Map.put(json, "author_override", override)

  defp maybe_author_override(json, _), do: json

  @doc """
  The send's client key (`nonce`, Discord's MESSAGE_CREATE field) on a
  create's render: added ONLY there — the 201 and the MessageCreate it
  publishes, built from one map — and only when the send carried one. It is
  not stored, so history, edits and every later render omit it.

  It rides to EVERY recipient (one payload per fan-out, as Discord sends it):
  the key is a random per-message token scoped to its author — the dedupe
  reservation and the Idempotency-Key replay are both keyed on (author, key)
  — so it lets another member do nothing, while the author's client settles
  its pending row by it exactly instead of by author + content.
  """
  @spec put_nonce(map(), String.t() | nil) :: map()
  def put_nonce(json, nonce) when is_binary(nonce), do: Map.put(json, "nonce", nonce)
  def put_nonce(json, _nonce), do: json

  # Reactions: same optional-key growth — ABSENT when the message has none;
  # else the [{"emoji", "count", "me"}] array (me against the viewer).
  defp maybe_reactions(json, nil), do: json
  defp maybe_reactions(json, reactions), do: Map.put(json, "reactions", reactions)

  # `snowflake/1` is the SHARED total reader (hardening plans 4.12 and 3.2; see
  # `CytaleWeb.API.Params`), which is what makes `max_snowflake/1` below safe to
  # walk a list element by element: one entry of the wrong TYPE used to raise
  # FunctionClauseError and take the whole request down with a 500.
  #
  # Its refusal lands on this handler's existing `else`, which answers 404
  # `channel_not_found` for EVERY malformed id (the anti-enumeration posture) —
  # 404 rather than the 400 the plan wording assumed; consistency with the
  # handler's other malformed-id cases matters more than the plan's number.
end
