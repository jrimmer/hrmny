defmodule CytaleWeb.InteractionController do
  @moduledoc """
  Bots plan U8 (KTD13) — the interactions REST surface, four actions across
  two wire dialects:

    * `index` (NATIVE) — `GET /api/v1/workspaces/:workspace_id/commands`:
      the composer's command list, member-gated (any member with view
      rights). This is what U9 consumes.
    * `create` (NATIVE) — `POST /api/v1/interactions`: the invocation
      endpoint U9's composer calls (human caller, command id + options +
      target channel; the caller's send right is checked on that channel),
      and — since the components plan U2 — the COMPONENT CLICK ingress: a
      message-keyed body variant `{channel_id, message_id, custom_id,
      component_type, values?}` dispatched through
      `Interactions.invoke_component/5` (membership check → owning-bot
      liveness → human clicker gate → mint). Both variants fan
      `InteractionCreate` to the BOT's user key EMIT-BEFORE-ACK, then
      answer 202 with the interaction id; a dead owning bot renders the
      DISTINCT dead-button 410 (`component_unavailable`, R8).
    * `callback` (COMPAT route, no auth pipeline) —
      `POST /api/v10/interactions/{id}/{token}/callback`: the URL token is
      the credential (Discord libraries send no Authorization header there).
      Typed responses (components plan U3, R5/KTD5): type 4 posts the reply
      as the BOT's message through the resolver-gated create path (204; the
      ack is SINGLE-USE, C-1) and now accepts `data.components` (stored +
      rendered — the fresh-card reply); types 5/6 consume the ack and post
      NOTHING now (their delivery is the continuation routes below);
      type 7 UPDATE_MESSAGE consumes the ack then edits the ATTACHED message
      (token-sourced target + author-pin + CURRENT rights/DM gate, wholesale
      component replace + optional validated content/embeds, MessageUpdate
      fan-out carrying components). A body with NO `type` key is a FOLLOWUP
      (posts as the bot any time in the token's life, ack untouched).
    * The WEBHOOK-SHAPED CONTINUATION ROUTES (components plan U3, R5/KTD5 —
      what discord.js `deferReply`/`deferUpdate` → `editReply`/`followUp`
      target): `POST /webhooks/{app_id}/{token}` (followup create) plus
      `GET/PATCH/DELETE /webhooks/{app_id}/{token}/messages/@original`, no
      auth pipeline — the URL token is the credential, resolved WITHOUT an
      interaction id segment (`Interactions.resolve_by_token/1`). `@original`
      resolves author-pinned from the token's data map: the CLICK'S message
      for update flows (type 6/7), the FIRST posted response for reply flows
      (type 4, or the deferred reply a type-5's continuation materializes).
      Every write leg consumes the KTD10 per-APPLICATION interaction-post
      bucket.
  """

  use CytaleWeb, :controller

  alias Cytale.Accounts.Principals
  alias Cytale.Gateway.PushRegistry
  alias Cytale.Interactions
  alias Cytale.Messages
  alias Cytale.Permissions.Bitfield
  alias Cytale.Permissions.Principal, as: PrincipalRights
  alias Cytale.Publish
  alias Cytale.Snowflake
  alias Cytale.Threads
  alias Cytale.Workspaces
  alias CytaleWeb.Compat.{Errors, MessageCodec, RateLimit, RateTables}
  alias CytaleWeb.GatewaySocket
  alias CytaleWeb.MessageController
  alias CytaleWeb.WebhookController
  import CytaleWeb.API.Error, only: [error: 4]

  # B6f: per-{interaction_id, token} callback bucket — the token lives 15
  # minutes and carries ONE ack plus followups (C-1), so the pair must not
  # post unbounded. 10 posts per token per 15 min sits far above any
  # legitimate Discord-library usage (one ack + rare followups/retries),
  # via the shared RateLimit machinery (Discord 429 shape).
  @callback_limit 10
  @callback_window_ms 15 * 60 * 1000
  @callback_bucket RateLimit.bucket("interaction-callback")

  # KTD10: the per-APPLICATION interaction-post bucket — the aggregate the
  # per-pair token bucket cannot bound (the pair bucket bounds a TOKEN, not
  # a bot; a click flood × 10-post tokens would otherwise amplify far past
  # the bot's direct message ceiling). Shared by every message-creating
  # callback leg (type-4 ack + callback/webhook followups) AND the
  # continuation routes' write legs (POST/PATCH/DELETE — the @original legs
  # have no ack constraint and no pair bucket, so this is their only dam).
  # Sized like the message_write route class (10/5s). Type-7 flips ride the
  # click budget (single-use ack, 1:1 with clicks) and never touch it.
  @interaction_post_limit 10
  @interaction_post_window_ms 5_000
  @interaction_post_bucket RateLimit.bucket("interaction-post")

  # The interaction `nonce` cap (see `interaction_nonce/1`).
  @max_nonce_chars 64
  @nonce_message "nonce must be a string of 1-#{@max_nonce_chars} characters"

  @doc "GET /api/v1/workspaces/:workspace_id/commands — the composer list."
  def index(conn, %{"workspace_id" => ws}) do
    with {:ok, ws_id} <- Snowflake.parse(ws),
         :ok <- require_member(conn.assigns.current_user, ws_id) do
      commands =
        ws_id
        |> Interactions.list_commands()
        |> Enum.map(&native_command_json/1)

      json(conn, %{"commands" => commands})
    else
      {:error, :not_found} -> error(conn, 404, "workspace_not_found", "No workspace with that id")
      {:error, :forbidden} -> error(conn, 403, "forbidden", "Not a member of this workspace.")
      _ -> error(conn, 400, "validation_failed", "workspace_id must be a snowflake")
    end
  end

  @doc """
  POST /api/v1/interactions — invoke a command as the authenticated human,
  or click a message component (the message-keyed body variant, components
  plan U2: `{channel_id, message_id, custom_id, component_type, values?}`
  beside the command shape — same route, pipeline, Idempotency plug, and
  EMIT-BEFORE-ACK fan).
  """
  # MODAL_SUBMIT (#30): the human answers a modal a bot opened on one of
  # their interactions. Same route, pipeline and EMIT-BEFORE-ACK fan as a
  # click; the provenance rules live in `Interactions.submit_modal/4`.
  def create(
        conn,
        %{
          "kind" => "modal_submit",
          "interaction_id" => interaction_id,
          "custom_id" => custom_id,
          "components" => components
        }
      )
      when is_binary(interaction_id) and is_binary(custom_id) do
    claims = conn.assigns.current_user

    with {:ok, origin} <- Snowflake.parse(interaction_id),
         {:ok, nonce} <- interaction_nonce(conn.body_params["nonce"]),
         {:ok, minted} <- Interactions.submit_modal(claims, origin, custom_id, components) do
      :ok = remember_nonce(minted, nonce)

      :ok =
        GatewaySocket.fan_out(
          PushRegistry.user_key(minted.payload["application_id"]),
          {"InteractionCreate", minted.payload}
        )

      conn
      |> put_status(202)
      |> json(%{"interaction_id" => Integer.to_string(minted.interaction_id)})
    else
      {:error, :application_dead} ->
        error(conn, 410, "component_unavailable", "The bot behind this form is no longer active.")

      {:error, :channel_not_found} ->
        error(conn, 404, "channel_not_found", "No channel with that id")

      {:error, :invalid_submission} ->
        error(conn, 400, "validation_failed", "The form's answers do not match its fields.")

      {:error, :invalid_nonce} ->
        error(conn, 400, "validation_failed", @nonce_message)

      # Unknown, expired, already submitted, or opened for someone else —
      # one answer for all of them (no oracle over other users' forms).
      _ ->
        error(conn, 400, "modal_unavailable", "That form is no longer available.")
    end
  end

  def create(
        conn,
        %{
          "message_id" => message_id,
          "channel_id" => channel_id,
          "custom_id" => custom_id,
          "component_type" => component_type
        } = params
      )
      when is_binary(message_id) and is_binary(channel_id) do
    claims = conn.assigns.current_user

    with {:ok, channel} <- Snowflake.parse(channel_id),
         {:ok, message} <- Snowflake.parse(message_id),
         :ok <- component_type_ok(component_type),
         :ok <- custom_id_ok(custom_id),
         {:ok, nonce} <- interaction_nonce(params["nonce"]),
         {:ok, minted} <-
           Interactions.invoke_component(claims, channel, message, custom_id, component_type, params["values"]) do
      :ok = remember_nonce(minted, nonce)

      # EMIT-BEFORE-ACK (the shipped ordering pin, unchanged): the type-3
      # interaction reaches the owning bot's sessions BEFORE the REST 202.
      :ok =
        GatewaySocket.fan_out(
          PushRegistry.user_key(minted.payload["application_id"]),
          {"InteractionCreate", minted.payload}
        )

      conn
      |> put_status(202)
      |> json(%{"interaction_id" => Integer.to_string(minted.interaction_id)})
    else
      {:error, :channel_not_found} ->
        error(conn, 404, "channel_not_found", "No channel with that id")

      {:error, :message_not_found} ->
        error(conn, 404, "message_not_found", "No message with that id")

      # The dead-button error (R8 ingress half): 410 — the button's owner is
      # gone; distinct from the 400 class so the client renders it without a
      # retry affordance (the deferred-to-U2 error key, pinned).
      {:error, :application_dead} ->
        error(conn, 410, "component_unavailable", "The bot behind this component is no longer active.")

      # R3's component_unavailable-class: forged/stale/disabled custom_id, or
      # a component-less message — never a mint.
      {:error, :component_unavailable} ->
        error(conn, 400, "component_unavailable", "That component is not available on this message.")

      {:error, :invalid_values} ->
        error(conn, 400, "validation_failed", "values must be a list of strings within the component's options")

      {:error, :invalid_nonce} ->
        error(conn, 400, "validation_failed", @nonce_message)

      {:error, :forbidden} ->
        error(conn, 403, "forbidden", "You cannot interact with components in that channel.")

      :error ->
        error(conn, 400, "validation_failed", "component_type must be 2 (button) or 3 (select)")

      _ ->
        error(conn, 400, "validation_failed", "channel_id, message_id, custom_id and component_type are required")
    end
  end

  def create(conn, %{"command_id" => command_id, "channel_id" => channel_id} = params) do
    claims = conn.assigns.current_user

    with {:ok, command} <- Snowflake.parse(command_id),
         {:ok, channel} <- Snowflake.parse(channel_id),
         {:ok, nonce} <- interaction_nonce(params["nonce"]),
         {:ok, minted} <- Interactions.invoke(claims, command, channel, params["options"]) do
      :ok = remember_nonce(minted, nonce)

      # EMIT-BEFORE-ACK (KTD13): the interaction reaches the bot's sessions
      # BEFORE the REST response — a live bot can race its callback reply
      # against the invoker's own confirmation.
      :ok =
        GatewaySocket.fan_out(
          PushRegistry.user_key(minted.payload["application_id"]),
          {"InteractionCreate", minted.payload}
        )

      conn
      |> put_status(202)
      |> json(%{"interaction_id" => Integer.to_string(minted.interaction_id)})
    else
      {:error, :channel_not_found} ->
        error(conn, 404, "channel_not_found", "No channel with that id")

      {:error, :command_not_found} ->
        error(conn, 404, "command_not_found", "No command with that id")

      {:error, :forbidden} ->
        error(conn, 403, "forbidden", "You cannot send messages in that channel.")

      # The #134 name gate: an `invite` command invoked without
      # manage_workspace. The KEY stays "forbidden" (one client shape); the
      # message names the authority so the denial is not misread as a
      # channel-speech restriction.
      {:error, :command_forbidden} ->
        error(conn, 403, "forbidden", "You do not have permission to use that command.")

      {:error, :invalid_options} ->
        error(conn, 400, "validation_failed", "options must be a JSON map")

      {:error, :invalid_nonce} ->
        error(conn, 400, "validation_failed", @nonce_message)

      _ ->
        error(conn, 400, "validation_failed", "command_id and channel_id are required snowflakes")
    end
  end

  def create(conn, _params),
    do: error(conn, 400, "validation_failed", "command_id and channel_id are required")

  @doc """
  POST /api/v10/interactions/{interaction_id}/{token}/callback — mounts
  OUTSIDE the Bot pipeline: the interaction token in the path is the
  credential (Discord libraries send no auth header here). The typed
  response branches (U3, KTD5): 4 posts (with optional components), 5/6
  defer (ack consumed, delivery via the continuation routes), 7 updates the
  attached message; type-less bodies are followups.
  """
  def callback(conn, %{"interaction_id" => id, "token" => token}) do
    with {:ok, interaction_id} <- Snowflake.parse(id),
         :ok <- consume_callback_bucket(conn, interaction_id, token) |> halt_or_pass(),
         {:ok, data} <- Interactions.verify_callback(interaction_id, token),
         {:ok, op} <- callback_body(conn.body_params) do
      run_callback(conn, interaction_id, token, data, op)
    else
      {:halted, conn} -> conn
      error -> callback_error(conn, error)
    end
  end

  def callback(conn, _params), do: Errors.invalid_form_body(conn)

  # -- the typed-response dispatch ---------------------------------------------
  #
  # Callback RESPONSE envelope (discord.py 2.7+, 2026-09-23): Discord's
  # callback POST now answers 200 with an object whose `interaction` member
  # the library parses unconditionally (data['interaction']['id']; the
  # response_message_* fields feed its callback-response bookkeeping). A bare
  # 204 worked for older libraries (and discord.js ignores the body), so the
  # envelope is additive — but discord.py 2.7.1's send_message/defer RAISE
  # on its absence ("string indices must be integers" — found by the leg).
  # `resource` stays omitted: the library treats it as optional, and the
  # followup routes (unchanged, still 204) are the older contract.
  defp callback_envelope(conn, interaction_id, extra) do
    json(conn, %{
      "interaction" =>
        Map.merge(
          %{
            "id" => Integer.to_string(interaction_id),
            "response_message_loading" => false,
            "response_message_ephemeral" => false
          },
          extra
        )
    })
  end

  # Type 4 (CHANNEL_MESSAGE_WITH_SOURCE): the reply posts as the bot's
  # message through the resolver-gated create (the shipped path, ordering
  # preserved) + the R5 response-surface `data.components`. The posted row
  # becomes the token's @original (reply flow).
  defp run_callback(conn, interaction_id, token, data, %{kind: :post} = op) do
    with :ok <- consume_interaction_post_bucket(conn, data.application_id) |> halt_or_pass(),
         :ok <- consume_ack(interaction_id, token),
         {:ok, claims} <- bot_claims(data.application_id),
         :ok <- bot_send_right(claims, data.workspace_id, data.channel_id) do
      {:ok, message} =
        Messages.create_message(%{
          channel_id: data.channel_id,
          author_id: data.application_id,
          content: op.content,
          # A card clicked inside a THREAD answers IN the thread (the
          # click's token carries it; nil for channel-rooted cards).
          thread_id: data[:thread_id],
          reply_to_id: nil,
          components: op.components || []
        })

      mark_ack(interaction_id, token, %{acked_as: :reply, response_message_id: message.id})

      publish_bot_message(message)
      notify_answered(interaction_id, token, data, 4)

      callback_envelope(conn, interaction_id, %{
        "response_message_id" => Integer.to_string(message.id)
      })
    else
      {:halted, conn} -> conn
      error -> callback_error(conn, error)
    end
  end

  # Types 5/6 (DEFERRED_*, KTD5): consume the single-use ack and post/edit
  # NOTHING now — the webhook-shaped continuation routes are the delivery
  # path (a followup POST after a 5 posts the deferred reply; the @original
  # PATCH after a 6 completes the deferred update). The data-map marker
  # decides which message @original resolves to (the clicked row for update
  # flows, the first posted response for reply flows).
  defp run_callback(conn, interaction_id, token, data, %{kind: defer} = _op)
       when defer in [:defer_reply, :defer_update] do
    with :ok <- consume_ack(interaction_id, token) do
      acked_as = if(defer == :defer_reply, do: :reply, else: :update)
      mark_ack(interaction_id, token, %{acked_as: acked_as})
      notify_answered(interaction_id, token, data, if(defer == :defer_reply, do: 5, else: 6))
      callback_envelope(conn, interaction_id, %{"response_message_loading" => true})
    else
      error -> callback_error(conn, error)
    end
  end

  # Type 7 (UPDATE_MESSAGE, R5/KTD4): consume the ack, then edit the
  # attached message. Defense-in-depth, in the plan's exact order: the
  # target is sourced EXCLUSIVELY from the token's data map (body-supplied
  # channel/message ids are never read — retargeting is impossible by
  # construction), the stored row's author must BE the token's application
  # (author-pin, else 404 10008), and the bot's CURRENT send right / DM
  # participation applies (a bot restricted out after posting can no longer
  # flip its card — buttons die with rights, KD3). Wholesale component
  # replace (R1-validated upstream) + optional content + optional embeds +
  # edited_at + MessageUpdate fan-out carrying components.
  defp run_callback(conn, interaction_id, token, data, %{kind: :update} = op) do
    with :ok <- consume_ack(interaction_id, token),
         {:ok, claims} <- bot_claims(data.application_id),
         {:ok, message} <- token_target(data),
         :ok <- author_pin(message, data.application_id),
         :ok <- bot_send_right(claims, data.workspace_id, data.channel_id) do
      mark_ack(interaction_id, token, %{acked_as: :update})

      updated = apply_message_update(data, message, op)
      Publish.publish(data.channel_id, {"MessageUpdate", card_update_json(updated)})
      notify_answered(interaction_id, token, data, 7)

      callback_envelope(conn, interaction_id, %{
        "response_message_id" => Integer.to_string(updated.id)
      })
    else
      {:halted, conn} -> conn
      error -> callback_error(conn, error)
    end
  end

  # Type 9 (MODAL, #30): the modal IS the interaction's initial response, so
  # it consumes the single-use ack like 4/5/6/7. The definition is stored on
  # THIS interaction's token row (what the submit is checked against) and
  # delivered to the invoking human's sessions as `InteractionModal` — the
  # client that invoked it opens it. Discord forbids a modal in answer to a
  # modal submit; so does this (400 50035), BEFORE the ack is spent.
  defp run_callback(conn, _interaction_id, _token, %{kind: :modal_submit}, %{kind: :modal}),
    do: Errors.invalid_form_body(conn)

  defp run_callback(conn, interaction_id, token, data, %{kind: :modal, modal: modal}) do
    with :ok <- consume_ack(interaction_id, token) do
      mark_ack(interaction_id, token, %{acked_as: :modal, modal: modal})

      :ok =
        GatewaySocket.fan_out(
          # Sessions register under the STRING id; claims may carry either.
          PushRegistry.user_key(to_string(data.invoked_by.user_id)),
          {"InteractionModal", interaction_modal_json(modal, interaction_id, data)}
        )

      notify_answered(interaction_id, token, data, 9)

      callback_envelope(conn, interaction_id, %{})
    else
      error -> callback_error(conn, error)
    end
  end

  # The InteractionModal wire payload, every field named. `modal` is the
  # definition `Interactions.validate_modal/1` normalized (exactly
  # custom_id/title/components), so this is the same map a merge would give —
  # but spelled out, the payload is what the protocol manifest reads from the
  # source, and a key the normalizer ever adds cannot ride onto the wire
  # unreviewed.
  defp interaction_modal_json(modal, interaction_id, data) do
    %{
      "interaction_id" => Integer.to_string(interaction_id),
      "application_id" => Integer.to_string(data.application_id),
      "channel_id" => Integer.to_string(data.channel_id),
      "custom_id" => modal["custom_id"],
      "title" => modal["title"],
      "components" => modal["components"]
    }
  end

  # A type-less body (the shipped followup): posts as the bot WITHOUT
  # consuming the ack, now accepting `data.components` (R5).
  defp run_callback(conn, interaction_id, token, data, %{kind: :followup} = op) do
    with :ok <- consume_interaction_post_bucket(conn, data.application_id) |> halt_or_pass(),
         {:ok, claims} <- bot_claims(data.application_id),
         :ok <- bot_send_right(claims, data.workspace_id, data.channel_id) do
      {:ok, message} =
        Messages.create_message(%{
          channel_id: data.channel_id,
          author_id: data.application_id,
          content: op.content,
          # A card clicked inside a THREAD answers IN the thread (the
          # click's token carries it; nil for channel-rooted cards).
          thread_id: data[:thread_id],
          reply_to_id: nil,
          components: op.components || []
        })

      publish_bot_message(message)
      notify_answered(interaction_id, token, data, 4)

      send_resp(conn, 204, "")
    else
      {:halted, conn} -> conn
      error -> callback_error(conn, error)
    end
  end

  # The shared edit core (the compat PATCH edit flow: edit → re-fetch →
  # publish is the CALLER's; this returns the re-fetched row). The edit
  # targets the RESOLVED message (the type-7 clicked row or a reply-flow
  # @original — the message carries its own channel/id). The optional
  # content rides the same UPDATE as the edited_at bump — a components- or
  # embeds-only flip rewrites the UNCHANGED content through it so edited_at
  # always advances.
  defp apply_message_update(_data, message, %{content: content, components: components, embeds: embeds}) do
    :ok = Messages.edit_message(message.channel_id, message.id, content || message.content)

    if components != nil,
      do: :ok = Messages.replace_components(message.channel_id, message.id, components)

    if embeds != nil, do: :ok = Messages.replace_embeds(message.channel_id, message.id, embeds)

    Messages.get_message(message.channel_id, message.id)
  end

  # A message the BOT posted in answer to an interaction, fanned out on its
  # scope. A channel-rooted answer is the shipped `publish_created/1` pair
  # (MessageCreate + last_message_id). An answer to a card inside a THREAD is
  # a thread reply, so it takes the thread reply's own path: the dual
  # emission (`Messages.Message.publish_created/1` — the thread panel renders
  # ThreadMessageCreate; compat sessions get MESSAGE_CREATE on the thread
  # id), the bot's auto-follow, and the discovery counter — exactly what a
  # bot's `POST /channels/{thread_id}/messages` does.
  defp publish_bot_message(%{thread_id: thread_id} = message) when is_integer(thread_id) do
    _wire = Messages.Message.publish_created(message)
    :ok = Threads.Member.ensure_followed_on_reply(thread_id, message.author_id)
    :ok = Threads.Thread.record_reply(thread_id, message.id, message.created_at)
  end

  defp publish_bot_message(message), do: MessageController.publish_created(message)

  # The card flip's MessageUpdate (type 7 / `@original` PATCH): the native
  # projection plus `components` and `embeds` ALWAYS present — a flip that
  # clears the buttons (Discord's `view=None`, `components: []`) or the
  # embeds must reach live viewers as an explicit `[]`, where the plain
  # projection's absent key reads "unchanged" to the client reconcile (the
  # protocol's replace-to-empty contract).
  defp card_update_json(message) do
    Map.merge(MessageController.message_json(message), %{
      "components" => Map.get(message, :components) || [],
      "embeds" => Cytale.MediaProxy.wire_embeds(Map.get(message, :embeds) || [])
    })
  end

  # ---------------------------------------------------------------------------
  # Continuation routes (R5/KTD5) — the webhook-shaped followup surface
  # ---------------------------------------------------------------------------

  @doc """
  POST /api/v10/webhooks/{application_id}/{token} — the interaction followup
  create: posts a message as the bot into the token's channel (full Discord
  message object back, components included when provided). No auth pipeline
  — the URL token is the credential; `application_id` is pinned against the
  token's data map (a foreign app id is the callback's 401).
  """
  def followup_create(conn, %{"application_id" => app, "token" => token}) do
    case resolve_continuation(app, token) do
      {:ok, interaction_id, data} -> do_followup_create(conn, interaction_id, token, data)
      {:error, :unauthorized} -> Errors.unauthorized(conn)
    end
  end

  def followup_create(conn, _params), do: Errors.invalid_form_body(conn)

  @doc """
  POST /api/webhooks/{application_id}/{token} — the BARE-alias followup.
  This route sits IN FRONT of the webhook execute surface (the identical
  two-segment path shape; definition order wins): a pair that is NOT an
  outstanding interaction token is webhook traffic and falls through to
  `WebhookController.execute` UNCHANGED — the webhook wire (bucket,
  multipart, `?wait`) is byte-identical.
  """
  def followup_create_bare(conn, %{"application_id" => app, "token" => token}) do
    case resolve_continuation(app, token) do
      {:ok, interaction_id, data} ->
        do_followup_create(conn, interaction_id, token, data)

      {:error, :unauthorized} ->
        # Merge (never replace): the webhook's query params (`?wait=true`,
        # `?wait=false`) ride conn.params and must survive the handoff.
        WebhookController.execute(conn, Map.merge(conn.params, %{"webhook_id" => app, "token" => token}))
    end
  end

  def followup_create_bare(conn, _params), do: Errors.invalid_form_body(conn)

  defp do_followup_create(conn, interaction_id, token, data) do
    with {:ok, op} <- followup_body(conn.body_params),
         :ok <- consume_interaction_post_bucket(conn, data.application_id) |> halt_or_pass(),
         {:ok, claims} <- bot_claims(data.application_id),
         :ok <- bot_send_right(claims, data.workspace_id, data.channel_id) do
      {:ok, message} =
        Messages.create_message(%{
          channel_id: data.channel_id,
          author_id: data.application_id,
          content: op.content,
          # A card clicked inside a THREAD answers IN the thread (the
          # click's token carries it; nil for channel-rooted cards).
          thread_id: data[:thread_id],
          reply_to_id: nil,
          components: op.components || []
        })

      # A followup after a type-5 defer IS the deferred reply materializing
      # — the FIRST posted response of a reply flow, i.e. its @original
      # (update flows keep the clicked message as @original; a plain
      # followup is never it).
      if data[:acked_as] == :reply and not is_integer(data[:response_message_id]) do
        mark_ack(interaction_id, token, %{response_message_id: message.id})
      end

      publish_bot_message(message)
      notify_answered(interaction_id, token, data, 4)

      json(conn, MessageCodec.scoped_message(message))
    else
      {:halted, conn} -> conn
      error -> callback_error(conn, error)
    end
  end

  @doc """
  GET /webhooks/{app_id}/{token}/messages/@original — the pinned original
  message (the click's message for update flows; the first posted response
  for reply flows), full Discord message object.
  """
  def original_show(conn, %{"application_id" => app, "token" => token}) do
    with {:ok, _interaction_id, data} <- resolve_continuation(app, token),
         # The claims hop is the surface's consistency check (a deleted
         # application's tokens are purged — this renders the 10002 only for
         # a swept-token race).
         {:ok, _claims} <- bot_claims(data.application_id),
         {:ok, message} <- original_message(data) do
      json(conn, MessageCodec.scoped_message(message))
    else
      error -> continuation_error(conn, error)
    end
  end

  @doc """
  PATCH /webhooks/{app_id}/{token}/messages/@original — edit the pinned
  original (the deferred-update completion: `type 6 → @original PATCH` flips
  the card). Body `{content?, components?, embeds?}` — all optional but at
  least one, content-only semantics per every other edit surface. A PATCH
  after a type-5 defer with nothing posted yet MATERIALIZES the deferred
  reply (discord.js `deferReply` → `editReply` targets exactly this route).
  """
  def original_update(conn, %{"application_id" => app, "token" => token}) do
    with {:ok, interaction_id, data} <- resolve_continuation(app, token),
         {:ok, claims} <- bot_claims(data.application_id),
         :ok <- consume_interaction_post_bucket(conn, data.application_id) |> halt_or_pass(),
         {:ok, body} <- edit_body(conn.body_params),
         {:ok, target} <- original_target(data) do
      case target do
        {:deferred_reply, channel_id} ->
          materialize_deferred_reply(conn, interaction_id, token, data, claims, channel_id, body)

        %{} = message ->
          with :ok <- author_pin(message, data.application_id),
               :ok <- bot_send_right(claims, data.workspace_id, data.channel_id) do
            updated = apply_message_update(data, message, body)
            Publish.publish(data.channel_id, {"MessageUpdate", card_update_json(updated)})
            notify_answered(interaction_id, token, data, 7)
            json(conn, MessageCodec.scoped_message(updated))
          else
            error -> continuation_error(conn, error)
          end
      end
    else
      {:halted, conn} -> conn
      error -> continuation_error(conn, error)
    end
  end

  @doc """
  DELETE /webhooks/{app_id}/{token}/messages/@original — delete the pinned
  original (author-pinned + CURRENT rights, the type-7 doctrine), 204 empty.
  """
  def original_delete(conn, %{"application_id" => app, "token" => token}) do
    with {:ok, _interaction_id, data} <- resolve_continuation(app, token),
         {:ok, claims} <- bot_claims(data.application_id),
         :ok <- consume_interaction_post_bucket(conn, data.application_id) |> halt_or_pass(),
         {:ok, message} <- original_message(data),
         :ok <- author_pin(message, data.application_id),
         :ok <- bot_send_right(claims, data.workspace_id, data.channel_id) do
      :ok = Messages.delete_message(data.channel_id, message.id, thread_id: message.thread_id)

      Publish.publish(data.channel_id, {"MessageDelete", Messages.Events.message_delete(message)})

      send_resp(conn, 204, "")
    else
      {:halted, conn} -> conn
      error -> continuation_error(conn, error)
    end
  end

  # The type-5 materialization (deferReply → editReply): no original exists
  # YET — this PATCH POSTS the deferred reply with the edit body and records
  # it as the token's @original.
  defp materialize_deferred_reply(conn, interaction_id, token, data, claims, channel_id, body) do
    with :ok <- bot_send_right(claims, data.workspace_id, channel_id) do
      {:ok, message} =
        Messages.create_message(%{
          channel_id: channel_id,
          author_id: data.application_id,
          # A components/embeds-only editReply persists "" (the compat
          # create's embed-only allowance, mirrored).
          content: body.content || "",
          # A card clicked inside a THREAD answers IN the thread (the
          # click's token carries it; nil for channel-rooted cards).
          thread_id: data[:thread_id],
          reply_to_id: nil,
          components: body.components || [],
          embeds: body.embeds || []
        })

      mark_ack(interaction_id, token, %{response_message_id: message.id})

      publish_bot_message(message)
      notify_answered(interaction_id, token, data, 4)

      json(conn, MessageCodec.scoped_message(message))
    else
      error -> continuation_error(conn, error)
    end
  end

  # The continuation credential: {application_id, token} in the URL — no
  # interaction id segment exists on these routes, so the token ALONE
  # resolves the row; the application pin binds the pair (a mismatched app
  # id renders the callback's undifferentiated 401).
  defp resolve_continuation(app, token) do
    with {:ok, application_id} <- Snowflake.parse(app),
         {:ok, interaction_id, data} <- Interactions.resolve_by_token(token),
         :ok <- app_pin(application_id, data.application_id) do
      {:ok, interaction_id, data}
    else
      _ -> {:error, :unauthorized}
    end
  end

  defp app_pin(application_id, application_id) when is_integer(application_id), do: :ok
  defp app_pin(_, _), do: {:error, :unauthorized}

  # @original resolution (R5): the UPDATE flows' original is the CLICK'S
  # message (the row the component lives on); the REPLY flows' original is
  # the FIRST posted response — for a type-5 defer that is the message a
  # completing POST/PATCH is about to materialize ({:deferred_reply,
  # channel}, consumed by the materialization path). Anything else (no ack
  # yet, nothing posted, the row deleted) is the 404 10008 miss.
  defp original_target(%{channel_id: channel_id, message_id: message_id} = data)
       when is_integer(channel_id) and is_integer(message_id) do
    cond do
      data[:acked_as] == :update -> fetch_target(channel_id, message_id)
      is_integer(data[:response_message_id]) -> fetch_target(channel_id, data[:response_message_id])
      data[:acked_as] == :reply -> {:ok, {:deferred_reply, channel_id}}
      true -> {:error, :unknown_message}
    end
  end

  # A command-provenance token carries no message_id — only the reply flow
  # applies there.
  defp original_target(%{channel_id: channel_id} = data) when is_integer(channel_id) do
    if is_integer(data[:response_message_id]),
      do: fetch_target(channel_id, data[:response_message_id]),
      else: {:error, :unknown_message}
  end

  defp original_target(_), do: {:error, :unknown_message}

  # The read/delete resolution: a deferred reply that has not materialized
  # yet is NOT fetchable (Cytale renders no Discord "thinking" placeholder —
  # documented divergence; the 404 is the shape until the completing write
  # posts it).
  defp original_message(data) do
    case original_target(data) do
      {:ok, %{} = message} -> {:ok, message}
      {:ok, {:deferred_reply, _channel_id}} -> {:error, :unknown_message}
      {:error, _} = error -> error
    end
  end

  defp fetch_target(channel_id, message_id) do
    case Messages.get_message(channel_id, message_id) do
      nil -> {:error, :unknown_message}
      message -> {:ok, message}
    end
  end

  # B6f: the per-token bucket consumed BEFORE verification (a replayed token
  # throttles identically whether its callbacks were valid or not — the 429
  # is the shared Discord shape with the callback bucket's headers).
  defp consume_callback_bucket(conn, interaction_id, token) do
    now = System.system_time(:millisecond)
    key = {:interaction_callback, interaction_id, token}

    {count, window_end} =
      RateLimit.consume(
        RateTables.compat_table(),
        key,
        @callback_limit,
        @callback_window_ms,
        now
      )

    retry_ms = max(1, window_end - now)

    conn
    |> RateLimit.stamp_headers(@callback_limit, count, window_end, retry_ms, @callback_bucket)
    |> RateLimit.maybe_limited(count, @callback_limit, retry_ms,
      bucket: @callback_bucket,
      key: key,
      scope: :interaction,
      window_ms: @callback_window_ms
    )
  end

  # KTD10 (see the module attribute docs): the per-application aggregate,
  # consumed AFTER the credential resolves and BEFORE any ack or write — an
  # exhausted bucket must not burn the single-use ack.
  defp consume_interaction_post_bucket(conn, application_id) do
    now = System.system_time(:millisecond)
    key = {:interaction_post, application_id}

    {count, window_end} =
      RateLimit.consume(
        RateTables.compat_table(),
        key,
        @interaction_post_limit,
        @interaction_post_window_ms,
        now
      )

    retry_ms = max(1, window_end - now)

    conn
    |> RateLimit.stamp_headers(@interaction_post_limit, count, window_end, retry_ms, @interaction_post_bucket)
    |> RateLimit.maybe_limited(count, @interaction_post_limit, retry_ms,
      bucket: @interaction_post_bucket,
      key: key,
      scope: :application,
      window_ms: @interaction_post_window_ms
    )
  end

  # The with-leg adapter: an unhalted conn passes, a halted (429) one short-
  # circuits the pipeline with its rendered response.
  defp halt_or_pass(%Plug.Conn{halted: true} = conn), do: {:halted, conn}
  defp halt_or_pass(conn) when is_struct(conn, Plug.Conn), do: :ok

  # ---------------------------------------------------------------------------
  # Authorization
  # ---------------------------------------------------------------------------

  # Composer list gate (KTD13): any MEMBER with view rights — the resolver's
  # @everyone base (view + send) covers every member, so this is exactly the
  # membership test; machines resolve through their parent∩restrictions.
  defp require_member(claims, ws_id) do
    case PrincipalRights.resolve(ws_id, claims, nil) do
      {:ok, bits} ->
        if Bitfield.has?(bits, :view_channel), do: :ok, else: {:error, :forbidden}

      {:error, :not_found} ->
        {:error, :not_found}

      {:error, :forbidden} ->
        {:error, :forbidden}
    end
  end

  # The callback's resolver gate: the BOT's own restrictions apply to its
  # response (channel allowlist, action mask, the parent's CURRENT rights —
  # R1). A bot that cannot send in the interaction's channel posts nothing.
  # DM channels (the nil-workspace token context, components plan U3):
  # participation IS authorization (the dm_gate precedent) — the bot must
  # still be a participant of the DM its interaction was minted in; a
  # missing DM row or a non-participant renders the anti-oracle 10003,
  # identical to every other channel miss.
  defp bot_send_right(claims, nil, channel_id) do
    case Workspaces.get_dm(channel_id) do
      nil ->
        {:error, :unknown_channel}

      dm ->
        if Workspaces.dm_participant?(dm, claims.user_id), do: :ok, else: {:error, :unknown_channel}
    end
  end

  defp bot_send_right(claims, workspace_id, channel_id) do
    case PrincipalRights.resolve(workspace_id, claims, channel_id) do
      {:ok, bits} ->
        if Bitfield.has?(bits, :send_messages), do: :ok, else: {:error, :missing_permissions}

      {:error, :not_found} ->
        {:error, :unknown_channel}

      {:error, :forbidden} ->
        {:error, :missing_permissions}
    end
  end

  # KTD4 author-pin (the author_only/2 precedent): the stored row's author
  # must BE the token's application — a token can never edit a message its
  # bot did not author. The 404 10008 shape (never a 403 oracle).
  defp author_pin(%{author_id: author_id}, application_id) when author_id == application_id, do: :ok
  defp author_pin(_, _), do: {:error, :unknown_message}

  # ---------------------------------------------------------------------------
  # Internals
  # ---------------------------------------------------------------------------

  # The machine claims shape the resolver consumes — ONE shape (Principals'
  # claims/1 is the same map the native auth plug and BotAuth assign).
  defp bot_claims(application_id) do
    case Principals.get(application_id) do
      nil -> {:error, :unknown_application}
      principal -> {:ok, Principals.claims(principal)}
    end
  end

  # The typed-response parse (KTD5 — the four branches). Type 4: content
  # required (R6 unchanged semantics) + optional `data.components` (R5's
  # response-surface acceptance). Types 5/6: bare acks (any other `data` is
  # accepted-and-ignored). EPHEMERAL (flags & 64) on 4/5 and on followups is
  # a 50035 — see `not_ephemeral/1`. Type 7: the edit body —
  # content/components/embeds each optional but AT LEAST ONE, content
  # validated exactly as every other create/edit surface when present (R5).
  # Type-less bodies are followups (content in either shape + optional
  # data.components).
  @spec callback_body(map()) :: {:ok, map()} | {:error, :invalid_body}

  defp callback_body(%{"type" => 4, "data" => data}) when is_map(data) do
    with :ok <- not_ephemeral(data),
         {:ok, content} <- required_content(data["content"]),
         {:ok, components} <- optional_components(data["components"]) do
      {:ok, %{kind: :post, content: content, components: components, embeds: nil}}
    end
  end

  # A deferred reply carries the ephemeral bit for the reply it promises
  # (Discord: `defer(ephemeral=True)` → the materializing followup is
  # ephemeral) — refused up front, before the ack is spent.
  defp callback_body(%{"type" => 5} = body) do
    with :ok <- not_ephemeral(body["data"]) do
      {:ok, %{kind: :defer_reply, content: nil, components: nil, embeds: nil}}
    end
  end

  defp callback_body(%{"type" => 6}),
    do: {:ok, %{kind: :defer_update, content: nil, components: nil, embeds: nil}}

  defp callback_body(%{"type" => 7, "data" => data}) when is_map(data) do
    with {:ok, edit} <- edit_body(data) do
      {:ok, Map.put(edit, :kind, :update)}
    end
  end

  # Any OTHER typed body is out of surface (v1: 4/5/6/7 only) — 50035. This
  # guard sits BEFORE the followup clauses so a typed body can never fall
  # through into the type-less followup shape.
  # Type 9 (MODAL, #30): the definition is validated and NORMALIZED here, so
  # everything downstream (storage, the clicker's event, submit checks) sees
  # one shape.
  defp callback_body(%{"type" => 9, "data" => data}) when is_map(data) do
    with {:ok, modal} <- Interactions.validate_modal(data), do: {:ok, %{kind: :modal, modal: modal}}
  end

  defp callback_body(%{"type" => _}), do: {:error, :invalid_body}

  defp callback_body(%{"data" => %{"content" => content} = data}) do
    with :ok <- not_ephemeral(data),
         {:ok, content} <- required_content(content),
         {:ok, components} <- optional_components(data["components"]) do
      {:ok, %{kind: :followup, content: content, components: components, embeds: nil}}
    end
  end

  defp callback_body(%{"content" => content} = body),
    do: callback_body(%{"data" => %{"content" => content, "flags" => body["flags"]}})

  defp callback_body(_), do: {:error, :invalid_body}

  # The webhook-route followup body (Discord's flat followup create shape):
  # `content` required (R6 unchanged semantics) + optional `components`.
  defp followup_body(%{"content" => content} = body) do
    with :ok <- not_ephemeral(body),
         {:ok, content} <- required_content(content),
         {:ok, components} <- optional_components(body["components"]) do
      {:ok, %{content: content, components: components}}
    end
  end

  defp followup_body(_), do: {:error, :invalid_body}

  # EPHEMERAL (flags & 64) is REFUSED, not dropped. There is no
  # invoker-only delivery path yet (no user-addressed message event the
  # clients render, and nothing that keeps such a message out of channel
  # history), and silently ignoring the bit posted a reply the bot meant for
  # ONE user — often a secret, a token, a private status — into the channel
  # for everyone. A 50035 naming `flags` lets the bot fall back deliberately
  # (e.g. to a DM) instead.
  @ephemeral_flag 64

  defp not_ephemeral(%{"flags" => flags}) when is_integer(flags) do
    if Bitwise.band(flags, @ephemeral_flag) != 0, do: {:error, :ephemeral_unsupported}, else: :ok
  end

  defp not_ephemeral(%{"flags" => flags}) when is_binary(flags) do
    case Integer.parse(flags) do
      {int, ""} -> not_ephemeral(%{"flags" => int})
      _ -> :ok
    end
  end

  defp not_ephemeral(_), do: :ok

  # The EDIT body shared by type-7 `data` and the @original PATCH: every
  # field optional, at least ONE required (nothing to edit is a 50035, not
  # a silent no-op); components/embeds validated against the shared caps.
  defp edit_body(body) when is_map(body) do
    with {:ok, content} <- optional_content(body["content"]),
         {:ok, components} <- optional_components(body["components"]),
         {:ok, embeds} <- optional_embeds(body["embeds"]),
         :ok <- at_least_one([content, components, embeds]) do
      {:ok, %{content: content, components: components, embeds: embeds}}
    end
  end

  defp edit_body(_), do: {:error, :invalid_body}

  defp at_least_one(fields) do
    if Enum.any?(fields, &(&1 != nil)), do: :ok, else: {:error, :invalid_body}
  end

  defp required_content(content),
    do: if(valid_content?(content), do: {:ok, content}, else: {:error, :invalid_body})

  defp optional_content(nil), do: {:ok, nil}
  defp optional_content(content), do: if(valid_content?(content), do: {:ok, content}, else: {:error, :invalid_body})

  defp optional_components(nil), do: {:ok, nil}

  defp optional_components(components) do
    case Messages.validate_components(components) do
      :ok -> {:ok, components}
      {:error, :invalid_components} -> {:error, :invalid_body}
    end
  end

  defp optional_embeds(nil), do: {:ok, nil}

  defp optional_embeds(embeds) do
    case Messages.validate_embeds(embeds) do
      :ok -> {:ok, embeds}
      {:error, :invalid_embeds} -> {:error, :invalid_body}
    end
  end

  defp valid_content?(content),
    do: is_binary(content) and byte_size(content) > 0 and byte_size(content) <= 4_000

  # The ack's atomic single-use hop (C-1) — every TYPED response consumes it
  # (4, 5, 6, 7 — one ack per token); followups never call this.
  defp consume_ack(interaction_id, token),
    do: Interactions.consume_callback_ack(interaction_id, token)

  # The token-sourced target (KTD4): EXCLUSIVELY the data map's ids — body
  # ids are never read on any update path. A component token always carries
  # both; anything else (a command token's type-7) is the 404 miss.
  defp token_target(%{channel_id: channel_id, message_id: message_id})
       when is_integer(channel_id) and is_integer(message_id),
       do: fetch_target(channel_id, message_id)

  defp token_target(_), do: {:error, :unknown_message}

  # The data-map bookkeeping (U3's ONLY per-token state — the tuple never
  # grows): advisory by contract — a racing sweep/revocation already killed
  # the token, and the marker's absence degrades to the @original 404, never
  # a wrong edit.
  defp mark_ack(interaction_id, token, fields) do
    _ = Interactions.merge_callback_data(interaction_id, token, fields)
    :ok
  end

  # ---------------------------------------------------------------------------
  # The clicker's "answered" signal (Discord's INTERACTION_SUCCESS)
  # ---------------------------------------------------------------------------

  # The client's correlation key for one interaction POST (Discord's
  # interaction `nonce`): optional, a string of 1-64 chars. The invoker's
  # client knows it BEFORE the POST answers, so the InteractionSuccess the
  # bot's answer triggers resolves the right control even when it outruns
  # the 202 (EMIT-BEFORE-ACK makes that the common case for a fast bot).
  defp interaction_nonce(nil), do: {:ok, nil}

  defp interaction_nonce(nonce) when is_binary(nonce) do
    length = String.length(nonce)
    if length >= 1 and length <= @max_nonce_chars, do: {:ok, nonce}, else: {:error, :invalid_nonce}
  end

  defp interaction_nonce(_), do: {:error, :invalid_nonce}

  # Recorded on the token's data map BEFORE the InteractionCreate fans to the
  # bot, so no answer can race ahead of it.
  defp remember_nonce(_minted, nil), do: :ok

  defp remember_nonce(minted, nonce) do
    _ = Interactions.merge_callback_data(minted.interaction_id, minted.token, %{nonce: nonce})
    :ok
  end

  # The bot ANSWERED the interaction: tell the human who made it, on their
  # own sessions, which interaction (and which control) it was. This is the
  # one exact signal the client resolves a pending click by; without it the
  # client could only infer an answer from the store (a flip of the card, a
  # new message by the bot), and a deferred ack (5/6) changes neither.
  #
  # Every way a bot can answer lands here, once per interaction (the first
  # answer wins; later legs of the same flow are no-ops): the initial
  # response — 4 reply, 5 deferred reply, 6 deferred update, 7 update,
  # 9 modal — and the continuation writes a bot may use without an initial
  # response first (a followup, or an @original edit). `response_type` names
  # the answering leg: the callback type, 4 for a posted followup or a
  # materialized deferred reply, 7 for an @original edit.
  #
  # A second answer racing the first may emit a second, identical signal —
  # clients key it by interaction, so that is harmless.
  defp notify_answered(interaction_id, token, data, response_type) do
    if data[:answered] != true do
      _ = Interactions.merge_callback_data(interaction_id, token, %{answered: true})

      case data[:invoked_by] do
        %{user_id: user_id} when not is_nil(user_id) ->
          :ok =
            GatewaySocket.fan_out(
              # Sessions register under the STRING id; claims may carry either.
              PushRegistry.user_key(to_string(user_id)),
              {"InteractionSuccess", interaction_success_json(interaction_id, data, response_type)}
            )

        _ ->
          :ok
      end
    end

    :ok
  end

  # The InteractionSuccess wire payload, every field named (the manifest
  # reads it from here). Absent context is an explicit null: a command's
  # interaction has no message/custom_id, a channel card no thread.
  defp interaction_success_json(interaction_id, data, response_type) do
    %{
      "interaction_id" => Integer.to_string(interaction_id),
      "nonce" => data[:nonce],
      "application_id" => Integer.to_string(data.application_id),
      "channel_id" => Integer.to_string(data.channel_id),
      "thread_id" => id_string(data[:thread_id]),
      "message_id" => id_string(data[:message_id]),
      "custom_id" => data[:custom_id],
      "response_type" => response_type
    }
  end

  defp id_string(id) when is_integer(id), do: Integer.to_string(id)
  defp id_string(_), do: nil

  # ---------------------------------------------------------------------------
  # Error rendering (the Discord shapes, one funnel per surface)
  # ---------------------------------------------------------------------------

  defp callback_error(conn, {:halted, conn}), do: conn

  defp callback_error(conn, {:error, :ack_consumed}), do: Errors.unknown_interaction(conn)
  defp callback_error(conn, {:error, :unknown_interaction}), do: Errors.unauthorized(conn)
  defp callback_error(conn, {:error, :expired}), do: Errors.unauthorized(conn)
  defp callback_error(conn, {:error, :bad_token}), do: Errors.unauthorized(conn)
  defp callback_error(conn, {:error, :unknown_application}), do: Errors.unknown_application(conn)
  defp callback_error(conn, {:error, :missing_permissions}), do: Errors.missing_permissions(conn)
  defp callback_error(conn, {:error, :unknown_channel}), do: Errors.unknown_channel(conn)
  defp callback_error(conn, {:error, :unknown_message}), do: Errors.unknown_message(conn)
  defp callback_error(conn, {:error, :invalid_body}), do: Errors.invalid_form_body(conn)

  defp callback_error(conn, {:error, :ephemeral_unsupported}),
    do:
      Errors.invalid_form_body(
        conn,
        "flags",
        "Ephemeral responses (flags & 64) are not supported by this server; nothing was posted."
      )

  defp callback_error(conn, _), do: Errors.invalid_form_body(conn)

  defp continuation_error(conn, {:error, :unauthorized}), do: Errors.unauthorized(conn)
  defp continuation_error(conn, {:error, :unknown_application}), do: Errors.unknown_application(conn)
  defp continuation_error(conn, {:error, :missing_permissions}), do: Errors.missing_permissions(conn)
  defp continuation_error(conn, {:error, :unknown_channel}), do: Errors.unknown_channel(conn)
  defp continuation_error(conn, {:error, :unknown_message}), do: Errors.unknown_message(conn)
  defp continuation_error(conn, {:error, :invalid_body}), do: Errors.invalid_form_body(conn)

  # ---------------------------------------------------------------------------
  # Native ingress helpers (components plan U2)
  # ---------------------------------------------------------------------------

  # Components plan U2 (R4): only buttons (2) and string selects (3) are
  # minted — any other component_type is a 400 at ingress, before any read.
  defp component_type_ok(component_type) when component_type in [2, 3], do: :ok
  defp component_type_ok(_), do: :error

  # The custom_id shape (R1 caps): a 1–100 char string. Semantics are the
  # bot's namespace — matched against the stored row, never interpreted.
  defp custom_id_ok(custom_id) when is_binary(custom_id) do
    if String.length(custom_id) in 1..100, do: :ok, else: :error
  end

  defp custom_id_ok(_), do: :error

  defp native_command_json(command) do
    base = %{
      "id" => Integer.to_string(command.command_id),
      "application_id" => Integer.to_string(command.application_id),
      "name" => command.name,
      "description" => command.description
    }

    if command.options in [nil, %{}, []], do: base, else: Map.put(base, "options", command.options)
  end
end
