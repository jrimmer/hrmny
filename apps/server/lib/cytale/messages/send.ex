defmodule Cytale.Messages.Send do
  @moduledoc """
  The ONE send pipeline: every route that posts a message — the native channel
  send (`POST /channels/{id}/messages`), the native thread reply
  (`POST /threads/{id}/messages`), and the compat send on a channel or a
  thread id (`POST /api/v10/channels/{id}/messages`) — goes from a parsed
  request to a stored, dispatched message through `post/2`.

  It owns, in order:

    0. **the reply reference** — `reply_to_id` must name a message in the
       SAME conversation: a timeline send may reply to any message in the
       channel's storage, a thread reply only to a message in that thread
       (Discord's rule — a reply lives beside what it answers). One read
       both validates the reference and becomes the reply snapshot every
       render carries; a miss is `{:error, :bad_reference}`;
    1. **claiming the send key** — the durable dedupe reservation in
       `message_nonces` (`Cytale.Messages.Nonces`), when the send carries a
       key (the body `nonce`, else the Idempotency-Key header);
    2. **replaying a retry** — a key already reserved for THIS kind of
       message, whose stored message is the same send (content, reply
       reference and attachments), answers with the ORIGINAL message and
       repeats no side effect;
    3. **re-driving an orphaned reservation** — a reservation whose message
       never landed is written under the reserved id (the same row, never a
       second message);
    4. **the conflict** — a key spent on a message in another channel, on a
       channel message and reused for a thread reply (or the reverse, or
       another thread's reply), or reused for a DIFFERENT message in the same
       conversation (other content, another reply reference, other
       attachments) is `{:conflict, :nonce_reused}`, never a replay of the
       other message: a retry is the same request again, and anything else
       reusing its key is a client bug the caller must hear about;
    5. **writing** the row (`Cytale.Messages.create_message/1`);
    6. **dispatch** — the channel `MessageCreate`, or for a thread reply the
       dual emission (`Cytale.Messages.Message.publish_created/2`) plus the
       auto-follow and the thread's reply counters;
    7. **the nonce echo** — the send key rides the created message's wire
       (the 201 and every emission), and a replay's wire.

  What is left to a route is its EDGES: parsing the request into `attrs`
  (content rules, attachments, the reply reference's id, embeds/components), and
  rendering the result (the native `{"message": ...}` envelope or the compat
  Discord object; 201 for `:created`, 200 for `:existing`; the native 409
  `idempotency_conflict` or the compat 400 50035 on `nonce` for a conflict).

  ## Kinds

  The pipeline is the same for every route; what it writes and emits depends
  on the KIND of message, never on the dialect:

    * `:channel` (default) — a timeline message. Dispatched as the native
      projection (`CytaleWeb.MessageController.message_json/3`), with the
      `last_message_id` pointer write (see the `:pointer` option). A publish failure after the
      write landed is logged and counted, never a client-visible 500 (the
      client would retry, and without a key that retry is a duplicate).
    * `:thread_reply` — a reply in a thread. `channel_id` is the thread's
      PARENT channel (a reply is an ordinary `messages` row in the parent's
      partition, so it shares `message_nonces` as-is). Dispatched as the
      thread wire (`Message.to_wire/1`) through the dual emission, then the
      author is auto-followed and the thread's reply counters move. A failure
      in that tail after the write landed is handled exactly as a timeline
      message's: logged and counted, and the send still answers with the
      stored message.

  A retry is told apart from a cross-use by the reserved row's `thread_id`:
  it must equal this send's (nil for a timeline message).
  """

  require Logger

  alias Cytale.Messages
  alias Cytale.Attachments.SignedUrl
  alias Cytale.Messages.{Message, Nonces, PointerWriter}
  alias Cytale.Publish
  alias Cytale.Threads.{Member, Thread}
  alias CytaleWeb.MessageController

  @typedoc """
  A sent message: `wire` is the native projection the dispatch carried (the
  send key included), `message` the row it was built from, and `reference`
  the replied-to row (or nil) — a compat edge renders its Discord object from
  the two rows.
  """
  @type sent :: %{wire: map(), message: Messages.t(), reference: Messages.t() | nil}

  @type result ::
          {:created, sent()}
          | {:existing, sent()}
          | {:conflict, :nonce_reused}
          | {:error, :bad_reference}

  @doc """
  Post a message. `attrs` is `Cytale.Messages.create_message/1`'s map
  (`channel_id` — the PARENT for a thread reply —, `author_id`, `content`,
  `thread_id`, `reply_to_id`, `attachments`, `embeds`, `components`,
  `allowed_mentions` — `Cytale.Messages.SendBody.parse/2` yields the composed
  ones) plus:

    * `:nonce` — the normalized send key, or nil (no durable dedupe).

  `reply_to_id` is the parsed id only; the pipeline validates it (see step 0
  in the moduledoc).

  Options:

    * `:kind` — `:channel` (default) or `:thread_reply` (see the moduledoc);
    * `:route` — the channel route the gate resolved (`{:channel, ws_id}` /
      `{:dm, dm}`), handed to the publish and the pointer write;
    * `:accepted_at` — the monotonic ms the request was accepted (the
      accept→deliver measurement); defaults to now;
    * `:pointer` — a timeline message's `last_message_id` write:
      `:deferred` (default — coalesced by `Cytale.Messages.PointerWriter`,
      off the response path) or `:sync` (written before `post/2` returns,
      for a surface whose clients read the channel object right after a
      send and expect it to name their message — the compat dialect).

  Returns `{:created, sent}` (a new message was written and dispatched),
  `{:existing, sent}` (a retry — the message this key already created, with
  no side effects), `{:conflict, :nonce_reused}` (the key belongs to a
  different message), or `{:error, :bad_reference}` (the reply reference is
  not a message in this conversation — nothing was claimed or written).
  """
  @spec post(map(), keyword()) :: result()
  def post(%{channel_id: channel_id, author_id: author_id} = attrs, opts \\ [])
      when is_integer(channel_id) and is_integer(author_id) do
    {nonce, attrs} = Map.pop(attrs, :nonce)
    kind = Keyword.get(opts, :kind, :channel)

    with {:ok, reference} <- reference(attrs, kind) do
      ctx = %{
        kind: kind,
        nonce: nonce,
        reference: reference,
        referenced: reference && MessageController.reference_snapshot(reference),
        route: Keyword.get(opts, :route),
        pointer: Keyword.get(opts, :pointer, :deferred),
        accepted_at: Keyword.get_lazy(opts, :accepted_at, fn -> System.monotonic_time(:millisecond) end)
      }

      case nonce do
        nil -> {:created, write(attrs, ctx)}
        _ -> durable_post(attrs, ctx)
      end
    end
  end

  # -- the reply reference -----------------------------------------------------------

  # ONE rule for every route: the referenced message must exist in the
  # conversation this send lands in. A thread reply answers a message IN ITS
  # THREAD — never the parent channel's timeline, never another thread (the
  # compat dialect once accepted any message in the parent's storage; Discord
  # scopes a reply to its channel, and a thread is a channel there). A
  # timeline send answers any message in the channel's storage.
  defp reference(attrs, kind) do
    case Map.get(attrs, :reply_to_id) do
      nil ->
        {:ok, nil}

      reply_to_id when is_integer(reply_to_id) ->
        case Messages.get_message(attrs.channel_id, reply_to_id) do
          nil -> {:error, :bad_reference}
          row -> if in_scope?(row, attrs, kind), do: {:ok, row}, else: {:error, :bad_reference}
        end

      _ ->
        {:error, :bad_reference}
    end
  end

  defp in_scope?(row, attrs, :thread_reply), do: row.thread_id == Map.get(attrs, :thread_id)
  defp in_scope?(_row, _attrs, :channel), do: true

  # Mint, claim, and let exactly one attempt write. The id is minted FIRST and
  # claimed with the key; the winner writes it. A loser — a retry, concurrent
  # or after a timeout / 5xx / restart — answers with the reserved message. If
  # the reservation exists but its message does not (the first attempt died
  # between the claim and the insert, or is still mid-write), the loser waits
  # briefly for it and otherwise RE-DRIVES the write under the reserved id:
  # the row is keyed by that id, so a second write is the same row again.
  defp durable_post(%{author_id: author_id, channel_id: channel_id} = attrs, ctx) do
    id = Cytale.Snowflake.next()
    thread_id = Map.get(attrs, :thread_id)

    case Nonces.claim(author_id, ctx.nonce, channel_id, id) do
      :claimed ->
        {:created, write(Map.put(attrs, :id, id), ctx)}

      {:existing, ^channel_id, existing_id} ->
        case Nonces.await_message(channel_id, existing_id) do
          %{thread_id: ^thread_id} = msg ->
            # Same conversation: a retry only if it is the same message.
            if same_send?(msg, attrs),
              do: {:existing, replay(msg, ctx)},
              else: {:conflict, :nonce_reused}

          %{} ->
            # Same channel, but the key named a message of another kind (a
            # thread reply for a timeline send, a timeline message or another
            # thread's reply for a reply): not a retry of THIS send.
            {:conflict, :nonce_reused}

          nil ->
            Logger.warning(
              "#{label(ctx)} nonce reserved #{existing_id} but no message landed; re-driving the reserved write"
            )

            {:created, write(Map.put(attrs, :id, existing_id), ctx)}
        end

      {:existing, _other_channel, _existing_id} ->
        {:conflict, :nonce_reused}

      {:error, reason} ->
        # The reservation store is unavailable: send without durable dedupe
        # rather than refusing the message (counted — see docs/monitoring.md).
        :telemetry.execute([:cytale, :message, :nonce_claim_failed], %{count: 1}, %{})
        Logger.warning("#{label(ctx)} nonce claim failed (#{inspect(reason)}); sending without durable dedupe")
        {:created, write(attrs, ctx)}
    end
  end

  # Is the stored message this send again? The fields a person or a bot
  # composes: the text, what it replies to, and the files — by their content
  # address, so a compat multipart retry (whose stored files get fresh
  # attachment ids) and a web retry (whose upload URLs may carry a fresh
  # signature) still match. Embeds and components are not compared: they
  # ride with the text they decorate, and no client varies them alone.
  defp same_send?(msg, attrs) do
    msg.content == Map.get(attrs, :content) and
      msg.reply_to_id == Map.get(attrs, :reply_to_id) and
      attachment_keys(msg.attachments) == attachment_keys(Map.get(attrs, :attachments))
  end

  defp attachment_keys(attachments) when is_list(attachments), do: Enum.map(attachments, &attachment_key/1)
  defp attachment_keys(_), do: []

  # A stored file's key is its content hash (whatever origin and signature
  # the URL carried); any other URL (self-hosted metadata) is its own key.
  defp attachment_key(%{"url" => url}) when is_binary(url) do
    canonical = SignedUrl.canonical(url)

    case Regex.run(~r"/attachments/([0-9a-f]{64})\z", canonical) do
      [_, hash] -> hash
      nil -> canonical
    end
  end

  defp attachment_key(att), do: att

  defp label(%{kind: :thread_reply}), do: "thread reply"
  defp label(_ctx), do: "send"

  # -- write + dispatch ------------------------------------------------------------

  # The row: `Messages.create_message/1`, told who the reply answers so a
  # sender's `allowed_mentions.replied_user` can reach (or spare) them.
  defp create(attrs, ctx) do
    {:ok, msg} = Messages.create_message(Map.put(attrs, :reply_author_id, ctx.reference && ctx.reference.author_id))
    msg
  end

  # A timeline message: persist → publish → pointer, with the JSON built ONCE
  # (the dispatch and the 201 are the same map, the send's key included).
  defp write(attrs, %{kind: :channel} = ctx) do
    msg = create(attrs, ctx)

    wire =
      msg
      |> Map.put(:referenced_snapshot, ctx.referenced)
      |> MessageController.message_json(nil, nil)
      |> MessageController.put_nonce(ctx.nonce)

    guarded(msg, fn -> publish_channel_message(msg, wire, ctx) end)

    %{wire: wire, message: msg, reference: ctx.reference}
  end

  # A thread reply: persist, the dual emission (or the call-log single one),
  # then the reply's thread side effects. The answer is built before the
  # dispatch, and everything after the write is guarded the way a timeline
  # message's publish + pointer tail is: the row landed, so a raise there is
  # logged and counted, never a 500 inviting a retry that — without a key —
  # would post the reply twice.
  defp write(%{author_id: author_id, thread_id: thread_id} = attrs, %{kind: :thread_reply} = ctx)
       when is_integer(thread_id) do
    msg = create(attrs, ctx)
    wired = Map.put(msg, :nonce, ctx.nonce)
    wire = Message.created_wire(wired, ctx.referenced)

    guarded(msg, fn -> Message.publish_created(wired, ctx.referenced) end)

    # Thread state, guarded on its own: a fan-out outage must not also lose
    # the follow and the reply counters.
    guarded(msg, fn ->
      :ok = Member.ensure_followed_on_reply(thread_id, author_id)
      :ok = Thread.record_reply(thread_id, msg.id, msg.created_at)
    end)

    %{wire: wire, message: msg, reference: ctx.reference}
  end

  # The post-write tail of every kind: the message is stored, so a failure
  # here is reported (log + the `publish_failed` delivery counter) and the
  # send still succeeds.
  defp guarded(msg, tail) do
    tail.()
  rescue
    e -> publish_failed(msg, e)
  catch
    kind, reason -> publish_failed(msg, {kind, reason})
  end

  defp publish_channel_message(msg, wire, ctx) do
    opts = [accepted_at: ctx.accepted_at] ++ if(ctx.route, do: [route: ctx.route], else: [])
    Publish.publish(msg.channel_id, {"MessageCreate", wire}, opts)
    touch_pointer(msg, ctx)
  end

  # The channel's `last_message_id`: coalesced by default (the send's hot
  # path), or written before the answer when the caller's contract reads it
  # back — see the `:pointer` option.
  defp touch_pointer(msg, %{pointer: :sync}), do: Messages.touch_last_message(msg.channel_id, msg.id)
  defp touch_pointer(msg, ctx), do: PointerWriter.touch(msg.channel_id, msg.id, ctx.route)

  defp publish_failed(msg, reason) do
    :telemetry.execute([:cytale, :message, :publish_failed], %{count: 1}, %{channel_id: msg.channel_id})
    Logger.error("message #{msg.id} stored but its publish failed: #{inspect(reason)}")
    :ok
  end

  # -- replay ------------------------------------------------------------------------

  # The retry's answer: the ORIGINAL message in the projection its kind's
  # create rendered, the send key echoed (a client whose first POST timed out
  # settles its placeholder by it, as on a 201).
  defp replay(msg, %{kind: :channel, nonce: nonce} = ctx) do
    wire = msg |> MessageController.message_json(msg.author_id) |> MessageController.put_nonce(nonce)
    %{wire: wire, message: msg, reference: ctx.reference}
  end

  # The reply's wire as `Message.send_message/1` returned it for the original,
  # with the reply snapshot this request validated (the same reference as the
  # original's).
  defp replay(msg, %{kind: :thread_reply, nonce: nonce, referenced: referenced} = ctx) do
    wire = msg |> Map.put(:nonce, nonce) |> Message.to_wire()
    wire = if referenced, do: Map.put(wire, "referenced", referenced), else: wire
    %{wire: wire, message: msg, reference: ctx.reference}
  end
end
