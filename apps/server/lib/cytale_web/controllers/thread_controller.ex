defmodule CytaleWeb.ThreadController do
  @moduledoc """
  U9 — thread surface (per U12's contract): start a thread on a channel
  message, thread history/replies, follow state (members). Thread rows
  persist in the `threads` + `threads_by_id` tables (dual write via
  `Cytale.Threads.Thread`); replies are messages with `thread_id` set and
  ride the same Publish seam (THREAD_MESSAGE_CREATE + channel
  MESSAGE_CREATE per the protocol's fan-out note).

  Authorization (#35 P0-1): a thread gates through its PARENT channel via
  the same seam the compat surface uses (`CytaleWeb.Compat.Authorize.
  channel_gate` — workspace channels resolve membership/role bits with
  restrictions; DM channels resolve participation). Every gate miss is the
  identical 404 `thread_not_found` (no existence oracle — this surface
  previously exposed cross-workspace AND cross-DM thread content to any
  authenticated account). Thread lookups ride the partition-keyed
  `threads_by_id` row.
  """

  use CytaleWeb, :controller

  alias Cytale.Messages
  alias Cytale.Publish
  alias Cytale.Threads
  alias Cytale.Threads.Events
  alias CytaleWeb.Compat.Authorize
  import CytaleWeb.API.Params, only: [parse_limit: 2, snowflake: 1, snowflake_opt: 1]
  import CytaleWeb.API.Error, only: [error: 4]

  @doc "POST /channels/:id/messages/:mid/threads — start a thread."
  def start(conn, %{"channel_id" => cid, "message_id" => mid, "name" => name}) do
    %{user_id: creator_id} = conn.assigns.current_user

    with {:ok, channel_id} <- snowflake(cid),
         {:ok, message_id} <- snowflake(mid),
         true <- is_binary(name) and byte_size(name) >= 1,
         # The pipeline already gated send_messages on the channel; the
         # anchor message must exist IN that channel (a dangling id is a
         # 404, not an oracle — the gate already ran).
         {:ok, thread} <- Threads.Thread.start(channel_id, message_id, name, creator_id) do
      # Announce the new thread so live clients can file it under the parent
      # channel (sidebar navigation); reply traffic rides ThreadMessageCreate.
      Publish.publish(channel_id, {"ThreadCreate", Events.thread_create(thread)})

      conn
      |> put_status(201)
      |> json(%{"thread" => thread_json(thread)})
    else
      {:error, :message_not_found} -> error(conn, 404, "message_not_found", "No message with that id")
      _ -> error(conn, 404, "message_not_found", "No message with that id")
    end
  end

  def start(conn, _params), do: error(conn, 400, "validation_failed", "name is required")

  @doc "GET /channels/:id/threads — the channel's thread roster (sidebar nav)."
  def index_channel_threads(conn, %{"channel_id" => cid} = params) do
    with {:ok, channel_id} <- snowflake(cid),
         {:ok, _channel, _bits} <- Authorize.channel_gate(conn.assigns.current_user, channel_id) do
      include_archived = params["include_archived"] in ["true", "1"]

      threads =
        Threads.Thread.list_in_channel(channel_id)
        |> then(fn list -> if include_archived, do: list, else: Enum.reject(list, & &1.archived) end)
        |> with_previews()

      json(conn, %{"threads" => threads})
    else
      _ -> error(conn, 404, "channel_not_found", "No channel with that id")
    end
  end

  @doc "GET /threads/:id — thread metadata."
  def show(conn, %{"thread_id" => tid}) do
    with {:ok, thread_id} <- snowflake(tid),
         {:ok, t} <- thread_gate(conn.assigns.current_user, thread_id) do
      json(conn, %{"thread" => thread_json(t)})
    else
      _ -> error(conn, 404, "thread_not_found", "No thread with that id")
    end
  end

  @doc "GET /threads/:id/messages — thread history (newest-first)."
  def index(conn, %{"thread_id" => tid} = params) do
    with {:ok, thread_id} <- snowflake(tid),
         {:ok, t} <- thread_gate(conn.assigns.current_user, thread_id),
         {:ok, cursor} <- CytaleWeb.MessageController.history_cursor(params) do
      # Thread-scoped read over the thread's own locator (#152) — never a walk
      # of the parent channel, so a page is dense and a SHORT page means there
      # is nothing further in that direction. (The call-log thread's replies
      # are ordinary replies here: the call-log exclusion is a channel-timeline
      # rule.)
      # The channel's own page renderer: attachments, reactions (one batched
      # read), the reply reference, embeds and components — a thread reply is
      # the same row as a channel message, on reload as much as live.
      page = Messages.thread_history(thread_id, [limit: parse_limit(params["limit"], default: 50, cap: 100)] ++ cursor)

      messages =
        CytaleWeb.MessageController.page_json(t.channel_id, page, conn.assigns.current_user.user_id)

      json(conn, Map.merge(%{"messages" => messages}, CytaleWeb.MessageController.page_cursors(messages)))
    else
      {:error, :both_cursors} -> CytaleWeb.MessageController.both_cursors_error(conn)
      _ -> error(conn, 404, "thread_not_found", "No thread with that id")
    end
  end

  @doc "POST /threads/:id/messages — reply (content-producing: choke point upstream)."
  def reply(conn, %{"thread_id" => tid} = params) do
    %{user_id: user_id} = conn.assigns.current_user

    with {:ok, thread_id} <- snowflake(tid),
         # The pipeline's thread branch already gated send_messages on the
         # PARENT channel (RequirePermitted resolves :thread_id); here the
         # thread must merely exist.
         t when not is_nil(t) <- Threads.Thread.get(thread_id),
         # The composed body (content, embeds, components) — the one parser
         # every send route shares.
         {:ok, composed} <- Messages.SendBody.parse(params, conn.assigns.current_user),
         # The channel send's own rules: attachments are descriptor maps; that a
         # reply references a message IN THIS THREAD is the pipeline's rule.
         {:ok, attachments} <- thread_attachments(params["attachments"]),
         {:ok, reply_to_id} <- CytaleWeb.MessageController.reply_to_id(params["reply_to_id"]) do
      # The message hot path (U12) emits BOTH the channel MESSAGE_CREATE
      # (thread_id set) and the thread-scoped THREAD_MESSAGE_CREATE, and
      # auto-follows the author (follow-on-reply-opt-out default). With a send
      # key the reply is deduplicated DURABLY, like a channel send: a retry —
      # across a restart that emptied the in-memory Idempotency-Key replay —
      # answers 200 with the original and repeats none of that.
      Messages.Send.post(
        Map.merge(composed, %{
          channel_id: t.channel_id,
          author_id: user_id,
          thread_id: thread_id,
          reply_to_id: reply_to_id,
          attachments: attachments,
          # The client's send key (body `nonce` or Idempotency-Key): the dedupe
          # key, echoed on the response and both emissions so the author's
          # pending row settles by it.
          nonce: CytaleWeb.MessageController.send_nonce(conn, params)
        }),
        kind: :thread_reply
      )
      |> then(&CytaleWeb.MessageController.respond_created(conn, &1, :thread_reply))
    else
      {:error, reason}
      when reason in [
             :invalid_content,
             :invalid_embeds,
             :embeds_not_allowed,
             :invalid_components,
             :invalid_allowed_mentions
           ] ->
        CytaleWeb.MessageController.send_body_error(conn, reason)

      {:error, :bad_attachments} ->
        error(conn, 400, "validation_failed", "attachments entries must be scalar-valued descriptor maps")

      {:error, :bad_reference} ->
        CytaleWeb.MessageController.respond_created(conn, {:error, :bad_reference}, :thread_reply)

      _ ->
        error(conn, 404, "thread_not_found", "No thread with that id")
    end
  end

  defp thread_attachments(list) do
    case Messages.normalize_attachments(list) do
      {:ok, attachments} -> {:ok, attachments}
      {:error, :invalid_attachments} -> {:error, :bad_attachments}
    end
  end

  @doc "GET /threads/:id/members — follow state roster."
  def members(conn, %{"thread_id" => tid}) do
    with {:ok, thread_id} <- snowflake(tid),
         {:ok, _t} <- thread_gate(conn.assigns.current_user, thread_id) do
      rows =
        Cytale.Repo.execute!(
          "SELECT user_id, joined_at FROM {{K}}.thread_members WHERE thread_id = ?",
          [{"bigint", thread_id}]
        )
        |> Enum.to_list()

      json(conn, %{
        "members" =>
          Enum.map(rows, fn r ->
            %{
              "user_id" => Integer.to_string(r["user_id"]),
              "joined_at" => r["joined_at"] && DateTime.to_iso8601(r["joined_at"])
            }
          end)
      })
    else
      _ -> error(conn, 404, "thread_not_found", "No thread with that id")
    end
  end

  @doc "POST /threads/:id/members — follow."
  def join(conn, %{"thread_id" => tid}) do
    %{user_id: user_id} = conn.assigns.current_user

    with {:ok, thread_id} <- snowflake(tid),
         {:ok, _t} <- thread_gate(conn.assigns.current_user, thread_id) do
      now = DateTime.utc_now() |> DateTime.truncate(:millisecond)

      Cytale.Repo.execute!(
        "INSERT INTO {{K}}.thread_members (thread_id, user_id, joined_at) VALUES (?, ?, ?)",
        [{"bigint", thread_id}, {"bigint", user_id}, {"timestamp", now}]
      )

      conn |> put_status(201) |> json(%{"joined" => Integer.to_string(thread_id)})
    else
      _ -> error(conn, 404, "thread_not_found", "No thread with that id")
    end
  end

  @doc "DELETE /threads/:id/members/@me — unfollow."
  def leave(conn, %{"thread_id" => tid}) do
    %{user_id: user_id} = conn.assigns.current_user

    with {:ok, thread_id} <- snowflake(tid),
         {:ok, _t} <- thread_gate(conn.assigns.current_user, thread_id) do
      Cytale.Repo.execute!(
        "DELETE FROM {{K}}.thread_members WHERE thread_id = ? AND user_id = ?",
        [{"bigint", thread_id}, {"bigint", user_id}]
      )

      json(conn, %{"left" => Integer.to_string(thread_id)})
    else
      _ -> error(conn, 404, "thread_not_found", "No thread with that id")
    end
  end

  @doc "PATCH /threads/:id/members/@me — notify flag / last_read_id."
  def update_follow(conn, %{"thread_id" => tid} = params) do
    %{user_id: user_id} = conn.assigns.current_user

    with {:ok, thread_id} <- snowflake(tid),
         {:ok, _t} <- thread_gate(conn.assigns.current_user, thread_id) do
      notify = params["notify"]
      last_read = snowflake_opt(params["last_read_id"])
      # PATCH semantics: an ABSENT last_read_id leaves the read state alone;
      # an explicit null CLEARS it (Mark Unread — every reply counts as new).
      clear_read = Map.has_key?(params, "last_read_id") and last_read == nil

      # Every membership write goes through Cytale.Threads.Member. This route
      # used to write `thread_members` directly, so a follow set here never
      # reached `thread_members_by_user` — and the followed-thread list (Home's
      # THREADS section, THREAD_LIST_SYNC) reads only that index, so the thread
      # was silently missing from it.
      unless Cytale.Threads.Member.get(thread_id, user_id) do
        Cytale.Threads.Member.follow(thread_id, user_id, is_boolean(notify) && notify)
      end

      if is_boolean(notify), do: Cytale.Threads.Member.set_notify(thread_id, user_id, notify)

      cond do
        is_integer(last_read) -> Cytale.Threads.Member.mark_read(thread_id, user_id, last_read)
        clear_read -> Cytale.Threads.Member.clear_read(thread_id, user_id)
        true -> :ok
      end

      json(conn, %{"thread_id" => Integer.to_string(thread_id), "updated" => true})
    else
      _ -> error(conn, 404, "thread_not_found", "No thread with that id")
    end
  end

  @doc """
  PATCH /threads/:id — archive or unarchive a thread (#109).

  Archive is a ROSTER-HIDING action, not an access change: the thread leaves
  the default listing (the channel roster filters on `archived`) and every
  reply stays, including its direct reads. `ThreadUpdate` carries the new
  state to live clients so an open pane can say so and the seed-message
  indicator stops advertising a thread the roster has hidden.
  """
  def update(conn, %{"thread_id" => tid} = params) do
    claims = conn.assigns.current_user

    with {:ok, thread_id} <- snowflake(tid),
         {:ok, t, bits} <- thread_gate_bits(claims, thread_id),
         {:ok, archived} <- archived_param(params),
         :ok <- may_manage(t, claims, bits) do
      :ok = Threads.Thread.set_archived(thread_id, archived)

      # The same channel-keyed fan-out the create publish uses, so a session
      # watching the parent channel receives it.
      Publish.publish(t.channel_id, {"ThreadUpdate", Events.thread_update(t, %{archived: archived})})

      json(conn, %{"thread" => thread_json(%{t | archived: archived})})
    else
      {:error, :forbidden} ->
        error(
          conn,
          403,
          "forbidden",
          "Archiving a thread requires being its creator or a moderator."
        )

      {:error, :invalid_archived} ->
        error(conn, 400, "validation_failed", "archived must be a boolean")

      _ ->
        error(conn, 404, "thread_not_found", "No thread with that id")
    end
  end

  # -- authorization ------------------------------------------------------------

  # THE thread gate (#35 P0-1): resolve the thread through threads_by_id,
  # then authorize on the PARENT channel through the shared compat seam —
  # workspace channels via the U3 resolver (membership/roles/overwrites,
  # restrictions applied), DMs via participation. View is the human
  # surface's bound (the @everyone base grants view_channel; no default
  # role distributes read_message_history — that bit's policy story is
  # #35 S-P2-14's). Every resolution miss collapses to {:error, :not_found}
  # → the caller renders the identical thread_not_found.
  defp thread_gate(claims, thread_id) do
    case thread_gate_bits(claims, thread_id) do
      {:ok, t, _bits} -> {:ok, t}
      _ -> {:error, :not_found}
    end
  end

  # The same gate, also returning the parent channel's effective bits so a
  # MANAGEMENT action can test its bit without resolving a second time.
  defp thread_gate_bits(claims, thread_id) do
    with %{channel_id: parent_id} = t <- Threads.Thread.get(thread_id),
         {:ok, _channel, bits} <- Authorize.channel_gate(claims, parent_id) do
      {:ok, t, bits}
    else
      _ -> {:error, :not_found}
    end
  end

  # Who may archive (#109) — the shared rule, so the native and compat
  # surfaces cannot drift: the creator, or a parent-channel moderator.
  defp may_manage(t, claims, bits) do
    if Authorize.may_archive_thread?(claims, t, bits), do: :ok, else: {:error, :forbidden}
  end

  # The only field this route writes is the archive flag, so an absent key is
  # a malformed request rather than the usual PATCH "leave it alone" — a
  # no-op write would be indistinguishable from a bug on either side.
  defp archived_param(%{"archived" => v}) when is_boolean(v), do: {:ok, v}
  defp archived_param(_), do: {:error, :invalid_archived}

  # -- helpers -------------------------------------------------------------------

  defp thread_json(t) do
    %{
      "id" => Integer.to_string(t.thread_id),
      "channel_id" => Integer.to_string(t.channel_id),
      "parent_message_id" => t.parent_message_id && Integer.to_string(t.parent_message_id),
      "name" => t.name,
      "archived" => t.archived,
      # The domain model declares `created_by` a REQUIRED field of Thread and
      # the create EVENT has always carried it, but these reads omitted it —
      # so a client could only answer "may I archive this?" for a thread it
      # watched being created (#109).
      "created_by" => t.created_by && Integer.to_string(t.created_by),
      # Summary fields (2026-09-10): the seed-message indicator renders
      # "N replies · last activity" without opening the thread.
      "message_count" => t.message_count || 0,
      "latest_reply_at" => t.latest_reply_at && DateTime.to_iso8601(t.latest_reply_at),
      "created_at" => t.created_at && DateTime.to_iso8601(t.created_at)
    }
  end

  # The roster's previews (owner direction 2026-10-08): the message a thread
  # was started from and its latest reply, so a row can say what the thread is
  # about when its name does not (`thread-388032`) and who spoke last. Both
  # messages live in the parent channel's partition; every row's pair is read
  # in batches of 50, which keeps each `IN` list under ScyllaDB's 100-key
  # restriction however many threads the channel holds. A message that is gone
  # reads as null.
  @preview_batch 50
  @preview_chars 300

  defp with_previews(threads) do
    found =
      threads
      |> Enum.flat_map(fn t ->
        for id <- [t.parent_message_id, t.latest_reply_id], id != nil, do: {t.channel_id, id}
      end)
      |> Enum.uniq()
      |> Enum.chunk_every(@preview_batch)
      |> Enum.reduce(%{}, fn chunk, acc -> Map.merge(acc, Messages.get_many(chunk)) end)

    Enum.map(threads, fn t ->
      thread_json(t)
      |> Map.put("starter", preview_json(Map.get(found, {t.channel_id, t.parent_message_id})))
      |> Map.put("latest_reply", t.latest_reply_id && preview_json(Map.get(found, {t.channel_id, t.latest_reply_id})))
    end)
  end

  defp preview_json(nil), do: nil

  defp preview_json(m) do
    %{
      "id" => Integer.to_string(m.id),
      "author_id" => Integer.to_string(m.author_id),
      # A webhook's per-message name, which the roster cannot know.
      "author_name" => m.author_override && m.author_override["username"],
      "content" => String.slice(m.content || "", 0, @preview_chars),
      # An embed-only message (a bot's card) is named by its first title.
      "embed_title" =>
        Enum.find_value(m.embeds || [], fn
          %{"title" => title} when is_binary(title) and title != "" -> String.slice(title, 0, @preview_chars)
          _ -> nil
        end),
      "attachment_count" => length(m.attachments || []),
      "created_at" => m.created_at && DateTime.to_iso8601(m.created_at)
    }
  end
end
