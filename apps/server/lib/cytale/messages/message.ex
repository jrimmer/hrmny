defmodule Cytale.Messages.Message do
  @moduledoc """
  The message hot path (U11): the plan's "persist → fan-out" pipeline as one
  orchestrating module. Wraps the `Cytale.Messages` data layer (U9) — this is
  the seam the REST controllers and the workspace process call; the ScyllaDB
  mechanics stay in the data layer.

  Pipeline per plan (U11 Approach):

    1. persist to ScyllaDB via `Cytale.Messages.create_message/1`
       (Snowflake message_id assigned there — per-channel monotonic order
       falls out of Snowflake chronology),
    2. author_messages locator row is written by the same call (U14 sweep),
    3. fan out `MESSAGE_CREATE` (or `THREAD_MESSAGE_CREATE` for thread
       replies) through `Cytale.Publish` — the workspace-process impl (U11)
       stamps resume buffers + pushes live PIDs; REST call sites untouched.
  """

  alias Cytale.Messages
  alias Cytale.Publish

  @typedoc "Wire-shaped message (snowflake ids as decimal strings)."
  @type wire_message :: %{
          id: String.t(),
          channel_id: String.t(),
          thread_id: String.t() | nil,
          author_id: String.t(),
          content: String.t(),
          created_at: String.t(),
          edited_at: String.t() | nil,
          attachments: [map()]
        }

  @doc """
  Persist then publish. Returns the wire-shaped message (what REST returns
  and what the gateway dispatch carries) or the data-layer error.

  Voice plan U4 (R5): a message posted to a channel's STANDING CALL-LOG
  thread emits `ThreadMessageCreate` ONLY — the channel-anchored
  `MessageCreate` is suppressed so call-log rows never render inline (the
  same `call_threads` mapping `Messages.history` excludes by). Ordinary
  thread replies keep the U12 dual emission.
  """
  @spec send_message(%{
          optional(:nonce) => String.t() | nil,
          channel_id: integer(),
          author_id: integer(),
          content: String.t(),
          thread_id: integer() | nil,
          attachments: [map()] | nil
        }) :: {:ok, wire_message()} | {:error, term()}
  def send_message(attrs) do
    # A reply's `referenced` snapshot (the caller already read the original
    # to validate the reference) rides the dispatch wire, so a live reply
    # renders its context line without a fetch.
    {referenced, attrs} = Map.pop(attrs, :referenced)
    # The send's client key rides the wire (the 201 and both emissions), never
    # the row — see `to_wire/1`.
    {nonce, attrs} = Map.pop(attrs, :nonce)

    with {:ok, msg} <- Messages.create_message(attrs) do
      {:ok, publish_created(Map.put(msg, :nonce, nonce), referenced)}
    end
  end

  @doc """
  The fan-out half of `send_message/1`, for a message some OTHER path already
  persisted (the interaction flows, whose `mark_ack` must sit BETWEEN the
  create and the dispatch — `CytaleWeb.MessageController.publish_created/1`'s
  thread-aware twin). Emits exactly what `send_message/1` would: the
  call-log single emission, the thread reply's dual emission, or the plain
  `MessageCreate`. Returns the wire map it published.
  """
  @spec publish_created(Messages.t(), map() | nil) :: wire_message()
  def publish_created(msg, referenced \\ nil) do
    # Built here, beside the emissions (not handed in): the protocol manifest
    # derives these events' fields from this binding.
    wire = maybe_referenced(to_wire(msg), referenced)

    cond do
      call_log_thread?(msg) ->
        # Standing call-log thread: single emission — ThreadMessageCreate
        # only (R5 enforced server-side at this single emission point).
        :ok = Publish.publish(msg.channel_id, {"ThreadMessageCreate", wire})

      msg.thread_id ->
        # Dual emission (U12): a thread reply fans out BOTH a channel
        # MESSAGE_CREATE (thread_id set — channel subscribers see it) and a
        # thread-scoped THREAD_MESSAGE_CREATE (the thread side-panel
        # subscribes without filtering all channel messages).
        :ok = Publish.publish(msg.channel_id, {"MessageCreate", wire})
        :ok = Publish.publish(msg.channel_id, {"ThreadMessageCreate", wire})

      true ->
        :ok = Publish.publish(msg.channel_id, {"MessageCreate", wire})
    end

    wire
  end

  @doc """
  The wire `publish_created/2` dispatches (and a send answers with), built
  WITHOUT dispatching: the send pipeline holds its answer before the publish
  runs, so it can still answer with it when the publish raises after the
  write landed.
  """
  @spec created_wire(Messages.t(), map() | nil) :: wire_message()
  def created_wire(msg, referenced \\ nil), do: maybe_referenced(to_wire(msg), referenced)

  # One partition-keyed point read on the `call_threads` mapping — only for
  # thread replies (channel-rooted messages can never be call-log rows).
  # The hot path demands nothing fancier: call-log posts are rare relative
  # to ordinary traffic, and the mapping row exists from the channel's
  # FIRST call onward (Log.ensure_thread at room start).
  defp call_log_thread?(%{thread_id: nil}), do: false

  defp call_log_thread?(msg) do
    Cytale.Calls.Log.thread_id(msg.channel_id) == msg.thread_id
  end

  defp maybe_referenced(wire, nil), do: wire
  defp maybe_referenced(wire, snapshot), do: Map.put(wire, "referenced", snapshot)

  @doc "Wire shape for an already-persisted message row (integer-native)."
  @spec to_wire(Messages.t()) :: wire_message()
  def to_wire(msg) do
    %{
      "id" => Integer.to_string(msg.id),
      "channel_id" => Integer.to_string(msg.channel_id),
      "thread_id" => msg.thread_id && Integer.to_string(msg.thread_id),
      "author_id" => Integer.to_string(msg.author_id),
      "content" => msg.content,
      # Additive (#155): a reply's reference rides the dispatch wire too —
      # the thread codec renders it as Discord type 19 + message_reference,
      # and a live reply now shows its reply bar without a refetch.
      # Map.get, not dot-access: wire maps in tests (and any caller holding
      # a plain map) predate this key and read as a plain nil.
      "reply_to_id" =>
        case Map.get(msg, :reply_to_id) do
          nil -> nil
          id -> Integer.to_string(id)
        end,
      "created_at" => DateTime.to_iso8601(msg.created_at),
      "edited_at" => msg.edited_at && DateTime.to_iso8601(msg.edited_at),
      "attachments" => Messages.wire_attachments(msg.attachments)
    }
    |> maybe_embeds(Map.get(msg, :embeds))
    |> Cytale.MediaProxy.put_content_proxy_urls(msg.content)
    |> maybe_components(Map.get(msg, :components))
    |> maybe_mention_everyone(Map.get(msg, :mention_everyone))
    |> put_mention_user_ids(Map.get(msg, :mention_user_ids))
    |> maybe_nonce(Map.get(msg, :nonce))
  end

  @doc """
  The create wire's `mention_user_ids`: the users this message may notify
  directly, present ONLY when the sender narrowed its mentions with
  `allowed_mentions` (absent = every `<@id>` in the content, plus the
  replied-to author, as always). Known on the create path only — the list is
  not stored — so, like `mention_everyone`, it rides the create's answer and
  dispatch and is absent from history reads. Shared by both wire renderers
  (`to_wire/1` and `CytaleWeb.MessageController.message_json/3`).
  """
  @spec put_mention_user_ids(map(), [integer()] | nil) :: map()
  def put_mention_user_ids(wire, ids) when is_list(ids),
    do: Map.put(wire, "mention_user_ids", Enum.map(ids, &Integer.to_string/1))

  def put_mention_user_ids(wire, _ids), do: wire

  # Embeds and action rows ride the wire exactly as `CytaleWeb.MessageController.
  # message_json/1` carries them — keys ABSENT when the message stored none.
  # A bot's card posted into a THREAD rides this projection (the dual
  # emission), and the thread panel and compat THREAD MESSAGE_CREATE render
  # from it; without these keys a card reached every live viewer as bare text.
  # External media inside them gains its signed `proxy_url` (Cytale.MediaProxy).
  defp maybe_embeds(wire, embeds) when is_list(embeds) and embeds != [],
    do: Map.put(wire, "embeds", Cytale.MediaProxy.wire_embeds(embeds))

  defp maybe_embeds(wire, _), do: wire

  defp maybe_components(wire, components) when is_list(components) and components != [],
    do: Map.put(wire, "components", components)

  defp maybe_components(wire, _), do: wire

  # See `CytaleWeb.MessageController`'s twin: the broadcast verdict is known
  # on the create path only, so the key rides only when it is.
  defp maybe_mention_everyone(wire, verdict) when is_boolean(verdict),
    do: Map.put(wire, "mention_everyone", verdict)

  defp maybe_mention_everyone(wire, _), do: wire

  # The send's client key — `CytaleWeb.MessageController`'s twin: present only
  # on the create's own wire, when the send carried one (never stored).
  defp maybe_nonce(wire, nonce) when is_binary(nonce), do: Map.put(wire, "nonce", nonce)
  defp maybe_nonce(wire, _), do: wire
end
