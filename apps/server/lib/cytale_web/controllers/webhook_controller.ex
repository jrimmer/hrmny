defmodule CytaleWeb.WebhookController do
  @moduledoc """
  U11 (bots plan) — Discord-compatible INCOMING webhooks, one controller, two
  very different trust tiers:

    * **Management** (`/api/v1/channels/{id}/webhooks...`) — the native
      envelope: Bearer-authenticated, verified, gated MANAGE_CHANNELS by the
      router pipeline. The URL token is RE-VIEWABLE here (Discord parity,
      KTD12) — unlike bot/agent credentials.
    * **Execute** (`/api/webhooks/{id}/{token}`) — UNAUTHENTICATED by design:
      the URL token IS the credential (KD8 capability semantics). No Auth
      plug, no permission resolver at execute — validity is the webhook row +
      the channel existing. Every miss renders the byte-identical Discord
      `404 {code: 10015, message: "Unknown Webhook"}` (anti-enumeration: no
      oracle across unknown id / wrong token / deleted webhook / deleted
      channel). Discord payload shapes via the compat errors/codec modules.

  Execute semantics (Discord): bare POST returns **204 empty** unless
  `?wait=true` (the created message object); `/slack` and `/github` wait
  DEFAULT TRUE (Discord parity) unless `?wait=false`. `tts` is accepted
  and ignored; `allowed_mentions` has Discord's semantics, applied as for
  every sender (`Cytale.Messages.AllowedMentions`); `components` are validated
  and SCOPED (components plan R6): interactive components (custom_id
  buttons/selects) are rejected 400 50035 — webhook principals have no
  gateway session to receive clicks — while style-5-only link rows are
  accepted, stored, and rendered (client-side anchors); `username`/
  `avatar_url` become the per-message author override (KTD12). The message
  is authored by the webhook PRINCIPAL (attribution intact; roster shows it
  via U5 synthesis) and fans out as a native MessageCreate exactly like a
  human/bot write (KD2 merge parity).

  Per-webhook rate bucket (5 requests / 2s, keyed `{webhook_id, url_token}` —
  independent per webhook, NOT the global api bucket): an exhausted bucket is
  Discord's 429 `{message, code: 0, retry_after: <float>, global: false}` +
  `Retry-After` + the compat X-RateLimit set. The bucket is consumed BEFORE
  resolution, so enumeration hammering throttles identically for valid and
  bogus pairs (still no oracle).

  Miss-path dam (B2): forged pairs are 404s, and a forger mints a FRESH
  `{webhook_id, token}` per attempt — the per-pair bucket never fills, so
  enumeration would otherwise run at full request rate. Every
  anti-enumeration 404 (execute AND info) therefore also consumes a per-IP
  miss bucket (30 / 10s, `{:miss, ip}` in the webhook table); past the
  ceiling the miss renders the shared Discord 429 instead. Valid-webhook
  traffic never touches the miss bucket — the 5/2s pair bucket stays its
  only limit.

  Execute also accepts Discord's multipart file model (`files[n]` parts +
  `payload_json`, shared `CytaleWeb.MultipartUpload`): stored files ride the
  message as Discord attachment objects (fresh snowflake id, absolute URL);
  JSON bodies behave byte-identically to the pre-multipart surface.
  """

  use CytaleWeb, :controller

  alias Cytale.Messages
  alias Cytale.Publish
  alias Cytale.Snowflake
  alias Cytale.Webhooks
  alias Cytale.Workspaces
  alias CytaleWeb.Compat.{Errors, MessageCodec, RateLimit, RateTables}
  alias CytaleWeb.ExternalUrl
  alias CytaleWeb.MessageController
  alias CytaleWeb.MultipartUpload
  import CytaleWeb.API.Error, only: [error: 4]

  # -- per-webhook rate bucket (the compat plug's fixed-window algorithm, ------
  #    own table + per-webhook identity)

  @rate_limit 5
  @rate_window_ms 2_000

  # B2: the per-IP miss-path dam over the SAME table (forged-pair
  # enumeration cannot mint fresh pair buckets faster than this ceiling).
  @miss_ip_limit 30
  @miss_window_ms 10_000
  @miss_bucket RateLimit.bucket("webhook-execute-miss-ip")

  # ---------------------------------------------------------------------------
  # Management (native envelope)
  # ---------------------------------------------------------------------------

  @doc "POST /api/v1/channels/{id}/webhooks {\"name\"} → 201 %{id, url}."
  def create(conn, %{"channel_id" => cid, "name" => name}) do
    %{user_id: creator_id} = conn.assigns.current_user

    with {:ok, channel_id} <- Snowflake.parse(cid),
         {:ok, webhook} <- Webhooks.create_webhook(channel_id, name, creator_id) do
      conn
      |> put_status(201)
      |> json(%{"id" => Integer.to_string(webhook.id), "url" => webhook_url(conn, webhook)})
    else
      {:error, :unknown_channel} ->
        error(conn, 404, "channel_not_found", "No channel with that id")

      {:error, :invalid_name} ->
        error(conn, 400, "validation_failed", "name must be 1-100 characters")

      {:error, :webhook_cap} ->
        # B6g: the per-channel budget — Discord's 30008 analogue, native key.
        error(conn, 400, "webhook_cap", "This channel already holds its webhook limit (50)")

      {:error, _parent} ->
        # Machine principals / deleted parents cannot mint (R1 depth-1) — the
        # permission gate already ran; this is the remaining minter check.
        error(conn, 403, "forbidden", "Only human principals may mint webhooks")
    end
  end

  def create(conn, _params), do: error(conn, 400, "validation_failed", "name is required")

  @doc """
  GET /api/v1/channels/{id}/webhooks → the channel's webhooks: id, name,
  channel_id, created_at.

  NO `url`. This is the DESTINATION's governance read — "what posts into my
  channel, and how do I stop it" — and its reader is a channel manager who is
  usually not the creator, so the capability token is not theirs to see (KD3).
  It used to be re-viewable here (Discord parity, KTD12), which meant any
  manager could take a colleague's URL and post as it, and keep doing so after
  that colleague lost access. The creator still gets the full URL: from `POST`
  (once, at create) and from `GET /users/@me/webhooks` (always). The divergence
  from Discord is deliberate; `docs/protocol/rest.md` records it.
  """
  def index(conn, %{"channel_id" => cid}) do
    with {:ok, channel_id} <- Snowflake.parse(cid),
         true <- Workspaces.get_channel(channel_id) != nil do
      webhooks =
        Webhooks.list_webhooks(channel_id)
        |> Enum.map(&webhook_json/1)

      json(conn, %{"webhooks" => webhooks})
    else
      _ -> error(conn, 404, "channel_not_found", "No channel with that id")
    end
  end

  @doc """
  GET /api/v1/users/@me/webhooks → the caller's OWN webhooks.

  The creator's view, and the only read that carries the capability URL
  (KD2/KD3). Each row names its destination, so the list is readable without
  the caller knowing any workspace; ownership comes from the principal the mint
  already wrote, so this needs no new storage.
  """
  def mine(conn, _params) do
    %{user_id: user_id} = conn.assigns.current_user

    webhooks = Webhooks.list_by_owner(user_id) |> Enum.map(&owner_webhook_json(conn, &1))
    json(conn, %{"webhooks" => webhooks})
  end

  @doc """
  PATCH /api/v1/webhooks/{id} {"name"} — the OWNER renames their own webhook.

  The creator's path, and the point of it: losing `manage_channels` on the
  destination must not strand the webhook you minted. A caller who is not the
  owner gets the SAME not-found as an unknown id, so the route cannot be used
  to enumerate other people's webhook ids.
  """
  def owner_update(conn, %{"id" => id, "name" => name}) do
    %{user_id: user_id} = conn.assigns.current_user

    with {:ok, webhook_id} <- Snowflake.parse(id),
         %{} = _webhook <- owned_webhook(user_id, webhook_id),
         :ok <- Webhooks.rename_webhook(webhook_id, name) do
      publish_rename(webhook_id)
      json(conn, %{"webhook" => owner_webhook_json(conn, Webhooks.describe_for_owner(webhook_id))})
    else
      {:error, :invalid_name} ->
        error(conn, 400, "validation_failed", "name must be 1-100 characters")

      _ ->
        error(conn, 404, "webhook_not_found", "No such webhook")
    end
  end

  def owner_update(conn, _params), do: error(conn, 400, "validation_failed", "name is required")

  @doc "DELETE /api/v1/webhooks/{id} — the OWNER revokes their own webhook."
  def owner_delete(conn, %{"id" => id}) do
    %{user_id: user_id} = conn.assigns.current_user

    with {:ok, webhook_id} <- Snowflake.parse(id),
         %{} = _webhook <- owned_webhook(user_id, webhook_id) do
      :ok = Webhooks.delete_webhook(webhook_id)
      send_resp(conn, :no_content, "")
    else
      _ -> error(conn, 404, "webhook_not_found", "No such webhook")
    end
  end

  # The owner check, in-controller exactly as `BotController.fetch_owned_bot/2`
  # does it: not-the-owner and not-found are the SAME answer, so the route is
  # not an oracle for ids the caller does not hold.
  defp owned_webhook(user_id, webhook_id) do
    case Webhooks.get_webhook(webhook_id) do
      %{} = webhook -> if Webhooks.owner?(webhook_id, user_id), do: webhook, else: nil
      nil -> nil
    end
  end

  # The roster-visible label converge, shared by both rename paths (webhook_id
  # IS the principal's user_id): the one UserUpdate builder people and bots
  # use, read back from the stored row.
  defp publish_rename(webhook_id), do: CytaleWeb.MemberEvents.announce_profile(webhook_id)

  @doc "PATCH /api/v1/channels/{id}/webhooks/{webhook_id} {\"name\"} — rename (manager's path)."
  def update(conn, %{"channel_id" => cid, "id" => id, "name" => name}) do
    with {:ok, channel_id} <- Snowflake.parse(cid),
         {:ok, webhook_id} <- Snowflake.parse(id),
         %{} = _webhook <- scoped_webhook(channel_id, webhook_id),
         :ok <- Webhooks.rename_webhook(webhook_id, name) do
      publish_rename(webhook_id)
      json(conn, %{"webhook" => webhook_json(Webhooks.get_webhook(webhook_id))})
    else
      {:error, :invalid_name} ->
        error(conn, 400, "validation_failed", "name must be 1-100 characters")

      {:error, :unknown_webhook} ->
        error(conn, 404, "webhook_not_found", "No such webhook in that channel")

      nil ->
        error(conn, 404, "webhook_not_found", "No such webhook in that channel")

      _ ->
        error(conn, 404, "channel_not_found", "No channel with that id")
    end
  end

  def update(conn, _params), do: error(conn, 400, "validation_failed", "name is required")

  @doc "DELETE /api/v1/channels/{id}/webhooks/{webhook_id} — 204; execute 404s after."
  def delete(conn, %{"channel_id" => cid, "id" => id}) do
    with {:ok, channel_id} <- Snowflake.parse(cid),
         {:ok, webhook_id} <- Snowflake.parse(id),
         %{} = _webhook <- scoped_webhook(channel_id, webhook_id) do
      :ok = Webhooks.delete_webhook(webhook_id)
      send_resp(conn, :no_content, "")
    else
      nil -> error(conn, 404, "webhook_not_found", "No such webhook in that channel")
      _ -> error(conn, 404, "channel_not_found", "No channel with that id")
    end
  end

  # ---------------------------------------------------------------------------
  # Execute (UNAUTHENTICATED capability surface — Discord shapes)
  # ---------------------------------------------------------------------------

  @doc """
  GET /api/webhooks/{id}/{token} — webhook info `{id, name, channel_id,
  type: 1}`. NO `user` field (Discord token-fetch parity). Miss → the
  anti-enumeration 404.
  """
  def info(conn, %{"webhook_id" => id, "token" => token}) do
    with {:ok, webhook_id} <- Snowflake.parse(id),
         %{} = webhook <- Webhooks.resolve_by_url_token(webhook_id, token) do
      json(conn, %{
        "id" => Integer.to_string(webhook.id),
        "name" => webhook.name,
        "channel_id" => Integer.to_string(webhook.channel_id),
        "type" => 1
      })
    else
      _ -> conn |> miss_path() |> unknown_webhook_unless_limited()
    end
  end

  @doc """
  POST /api/webhooks/{id}/{token} — Discord execute body `{content?, username?,
  avatar_url?, tts?, embeds?, allowed_mentions?, components?}` — as JSON, or
  as multipart (`payload_json` part + `files[n]` parts). 204 empty by
  default; `?wait=true` returns the created Discord message object.
  """
  def execute(conn, %{"webhook_id" => id, "token" => token} = params) do
    with_request_payload(conn, fn payload, files ->
      run_execute(conn, id, token, payload, files, params["wait"] == "true")
    end)
  end

  @doc """
  POST /api/webhooks/{id}/{token}/slack — Slack-compat `{text}` (+ optional
  `username`), JSON or multipart (`payload_json` carries the event body).
  wait DEFAULTS TRUE (Discord parity): the message object unless
  `?wait=false`.
  """
  def execute_slack(conn, %{"webhook_id" => id, "token" => token} = params) do
    with_request_payload(conn, fn body, files ->
      case Webhooks.Transformers.slack(body) do
        {:ok, payload} ->
          run_execute(
            conn,
            id,
            token,
            transformer_body(payload),
            files,
            params["wait"] != "false"
          )

        {:error, :invalid_body} ->
          run_execute(conn, id, token, %{"content" => nil}, files, params["wait"] != "false")
      end
    end)
  end

  @doc """
  POST /api/webhooks/{id}/{token}/github — GitHub event JSON
  (`X-GitHub-Event` header; push/pull_request/issues render content + embed
  card, others a generic "event received" line), JSON or multipart. wait
  DEFAULTS TRUE.
  """
  def execute_github(conn, %{"webhook_id" => id, "token" => token} = params) do
    with_request_payload(conn, fn body, files ->
      event = List.first(get_req_header(conn, "x-github-event"))
      {:ok, payload} = Webhooks.Transformers.github(body, event)

      run_execute(
        conn,
        id,
        token,
        transformer_body(payload),
        files,
        params["wait"] != "false"
      )
    end)
  end

  # The transformers return atom-keyed internal maps; execute consumes the
  # Discord string-key body — adapt once, here.
  defp transformer_body(payload) do
    %{
      "content" => payload.content,
      "username" => payload.username,
      "avatar_url" => payload.avatar_url,
      "embeds" => payload.embeds
    }
  end

  # -- the shared execute core ---------------------------------------------------

  # One request-body seam for all three execute routes: a JSON body passes
  # through verbatim (byte-identical behavior); a multipart body decodes the
  # `payload_json` part and hands the `files[n]` parts to the execute core.
  # Parsing only — files STORE later, after the URL token verifies (S-P1-7:
  # forged pairs used to write their blobs to the shared volume before any
  # credential check, an unauthenticated disk-fill vector).
  defp with_request_payload(conn, fun) do
    with {:ok, body} <- MultipartUpload.payload(conn),
         {:ok, files} <- MultipartUpload.files(conn) do
      fun.(body, files)
    else
      {:error, :invalid_form_body} -> Errors.invalid_form_body(conn)
    end
  end

  # The bare execute merges stored attachments straight into the Discord
  # payload; the transformer routes merge into the TRANSFORMED body (the raw
  # Slack/GitHub event's own `attachments` key means cards, never files).
  defp with_stored_attachments(payload, []), do: payload
  defp with_stored_attachments(payload, stored_attachments), do: Map.put(payload, "attachments", stored_attachments)

  defp run_execute(conn, id, token, payload, files, wait?) do
    case Snowflake.parse(id) do
      {:ok, webhook_id} ->
        conn = consume_bucket(conn, webhook_id, token)

        if conn.halted do
          # The 429 is already on the wire — never double-render.
          conn
        else
          # Credential check BEFORE the disk write (S-P1-7): resolve the
          # capability pair first; only a verified webhook's files land in
          # the content-addressed store. `Webhooks.execute` re-resolves
          # internally — the double read is the price of the ordering, and
          # it keeps this function's miss path byte-identical.
          case Webhooks.resolve_by_url_token(webhook_id, token) do
            nil ->
              conn |> miss_path() |> unknown_webhook_unless_limited()

            _webhook ->
              with {:ok, stored_attachments} <- MultipartUpload.store(conn, files) do
                do_execute(conn, webhook_id, token, with_stored_attachments(payload, stored_attachments), wait?)
              else
                {:error, :invalid_form_body} -> Errors.invalid_form_body(conn)
                {:error, :too_large} -> Errors.invalid_form_body(conn)
                {:error, :disallowed_mime} -> Errors.invalid_form_body(conn)
                {:error, :volume_full} -> storage_full(conn)
              end
          end
        end

      :error ->
        conn |> miss_path() |> unknown_webhook_unless_limited()
    end
  end

  defp do_execute(conn, webhook_id, token, payload, wait?) do
    case Webhooks.execute(webhook_id, token, payload) do
      {:ok, msg} ->
        # Identical side effects to a human/bot write (KD2 merge parity): the
        # native MessageCreate projection (embeds + author_override ride as
        # optional keys) + the last_message_id denormalization.
        MessageController.publish_created(msg)

        if wait?, do: json(conn, MessageCodec.message(msg)), else: send_resp(conn, :no_content, "")

      {:error, :unknown_webhook} ->
        conn |> miss_path() |> unknown_webhook_unless_limited()

      {:error, :invalid_body} ->
        Errors.invalid_form_body(conn)

      {:error, :invalid_embeds} ->
        Errors.invalid_form_body(conn)

      {:error, :invalid_components} ->
        Errors.invalid_form_body(conn)
    end
  end

  # -- per-webhook rate bucket -----------------------------------------------------

  # Consume one slot for {webhook_id, token} through the shared
  # RateLimit.consume (the compat plug's algorithm over this controller's
  # own table). Halts with the shared Discord 429 when the bucket is
  # exhausted; otherwise returns the conn carrying the X-RateLimit set for
  # the eventual response (the ONE shared header stamp — byte-identical to
  # the route plug's).
  defp consume_bucket(conn, webhook_id, token) do
    now = now_ms()
    key = {webhook_id, token}
    {count, window_end} = RateLimit.consume(rate_table(), key, @rate_limit, @rate_window_ms, now)
    retry_ms = max(1, window_end - now)

    conn
    |> RateLimit.stamp_headers(@rate_limit, count, window_end, retry_ms, bucket_id(webhook_id, token))
    |> RateLimit.maybe_limited(count, @rate_limit, retry_ms,
      bucket: bucket_id(webhook_id, token),
      key: key,
      scope: :webhook,
      window_ms: @rate_window_ms
    )
  end

  # -- miss-path dam (B2) -----------------------------------------------------------

  # Consume the per-IP miss bucket for the caller's IP. Ordinary misses pass
  # through untouched (their 404 keeps the per-pair bucket's headers,
  # byte-identical to the pre-dam wire); past the ceiling the conn halts
  # with the shared Discord 429.
  defp miss_path(conn) do
    now = now_ms()
    key = {:miss, RateLimit.ip_key(conn.remote_ip)}

    {count, window_end} =
      RateLimit.consume(rate_table(), key, @miss_ip_limit, @miss_window_ms, now)

    if count > @miss_ip_limit do
      retry_ms = max(1, window_end - now)

      conn
      |> RateLimit.stamp_headers(@miss_ip_limit, count, window_end, retry_ms, @miss_bucket)
      |> RateLimit.maybe_limited(count, @miss_ip_limit, retry_ms,
        bucket: @miss_bucket,
        key: key,
        scope: :network,
        window_ms: @miss_window_ms
      )
    else
      conn
    end
  end

  # The 404 renderer for the miss path: when the dam already halted with a
  # 429, pass the conn through untouched (never double-render).
  defp unknown_webhook_unless_limited(%Plug.Conn{halted: true} = conn), do: conn
  defp unknown_webhook_unless_limited(conn), do: unknown_webhook(conn)

  # The bucket table is owned by the long-lived `CytaleWeb.Compat.RateTables`
  # GenServer (app tree) — this controller only reads/writes the public
  # named table, never creates it (a connection-process-owned table died
  # with the process and reset the buckets).
  defp rate_table, do: RateTables.webhook_table()

  # Stable per-webhook bucket id (the identity IS the capability pair —
  # distinct from the compat route-template buckets).
  defp bucket_id(webhook_id, token),
    do: Base.encode16(:crypto.hash(:md5, "webhook-execute:#{webhook_id}:#{token}"), case: :lower)

  # -- rendering --------------------------------------------------------------------

  # The token rides the URL — re-viewable by managers (KTD12), so the list
  # and PATCH responses carry the full capability URL. The origin builder is
  # the shared `CytaleWeb.ExternalUrl` (`cytale, :external_base_url` — C-5b,
  # when set — supplies the origin verbatim; behind a proxy with a different
  # public origin the returned URL must be the one integrators can actually
  # POST, not the request's internal host).
  # The channel-scoped (MANAGER) shape: what posts into this channel, WITHOUT
  # the capability URL. See `index/2` for why the token is not here.
  defp webhook_json(webhook) do
    %{
      "id" => Integer.to_string(webhook.id),
      "name" => webhook.name,
      "channel_id" => Integer.to_string(webhook.channel_id),
      "created_at" => webhook.created_at && DateTime.to_iso8601(webhook.created_at)
    }
  end

  # The owner's shape: the same row PLUS the URL, because the caller is the one
  # who can already post with it — and minus nothing, so a "my webhooks" list is
  # complete on its own. `destination` is the two names that make a
  # user-scoped row readable without knowing any workspace id.
  defp owner_webhook_json(conn, webhook) do
    %{
      "id" => Integer.to_string(webhook.id),
      "name" => webhook.name,
      "channel_id" => Integer.to_string(webhook.channel_id),
      "created_at" => webhook.created_at && DateTime.to_iso8601(webhook.created_at),
      "url" => webhook_url(conn, webhook),
      "destination" => destination_json(webhook.destination)
    }
  end

  defp destination_json(nil), do: nil

  defp destination_json(destination) do
    %{
      "channel_id" => Integer.to_string(destination.channel_id),
      "channel_name" => destination.channel_name,
      "workspace_id" => destination.workspace_id && Integer.to_string(destination.workspace_id),
      "workspace_name" => destination.workspace_name
    }
  end

  @external_path "/api/webhooks"

  defp webhook_url(conn, webhook) do
    ExternalUrl.build(conn, "#{@external_path}/#{webhook.id}/#{webhook.token}")
  end

  # The attachment store hit its reject watermark mid-execute: not a client
  # error, not one of Discord's codes — a bare 507 with code 0.
  defp storage_full(conn), do: Errors.render(conn, 507, 0, "Attachment storage is full; try again later.")

  defp unknown_webhook(conn), do: Errors.render(conn, 404, 10_015, "Unknown Webhook")

  # A management action is scoped to the channel in the path: the webhook row
  # must exist AND point at that channel (no cross-channel oracle).
  defp scoped_webhook(channel_id, webhook_id) do
    case Webhooks.get_webhook(webhook_id) do
      %{channel_id: ^channel_id} = webhook -> webhook
      _ -> nil
    end
  end

  defp now_ms, do: System.system_time(:millisecond)
end
