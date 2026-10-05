defmodule Cytale.Webhooks do
  @moduledoc """
  Webhook persistence + Discord-execute semantics (bots plan U11, R12).

  A webhook is a channel-scoped capability URL pair — `webhook_id` (a :webhook
  PRINCIPAL from U1, so attribution rides every message) plus a `url_token`
  stored PLAINTEXT in `webhooks` by decision (KTD12: re-viewability requires
  recovery; the single-node threat model means an encryption key would sit
  beside the data; the real mitigations are anti-enumeration 404s, the
  per-webhook rate bucket, and delete/regenerate).

  Execute validity (KD8, binding): the webhook row + the channel existing.
  Capability URLs are EXEMPT from the parent-rights intersection at execute —
  the creating admin leaving the workspace does NOT kill the webhook. There is
  deliberately NO permission/resolver check here; bots/agents keep the full
  invariant (they authenticate, webhooks merely present their URL).

  Storage:

    * `webhooks (webhook_id → channel_id, url_token, created_at)` — the
      capability row; `webhook_id` IS the principal's user_id.
    * `webhooks_by_channel (channel_id, webhook_id)` — the channel-delete
      cascade index.
    * `message_author_overrides (message_id → override_username,
      override_avatar_url)` — per-message `username`/`avatar_url` overrides;
      `author_id` stays the webhook principal (presentation-only override).

  The webhook principal's minted `cytbot_` credential is revoked at creation:
  the URL token is the ONLY capability a webhook holds (no gateway sessions,
  no REST identity — a stray mint credential would be a second, unintended
  capability nobody can be told about). Provenance survives for attribution
  and roster synthesis (U5 projects :webhook kinds).
  """

  alias Cytale.Accounts.Principals
  alias Cytale.Accounts.User
  alias Cytale.Messages
  alias Cytale.Repo
  alias Cytale.Workspaces

  @typedoc "A webhook row as returned by get/list/resolve (token included — re-viewable by decision)."
  @type t :: %{
          id: integer(),
          channel_id: integer(),
          token: String.t(),
          name: String.t() | nil,
          created_at: DateTime.t()
        }

  # Per-message override caps (Discord's webhook username cap; avatar_url is
  # a plain URL with a sane length bound).
  @max_username 80
  @max_avatar_url 2_048

  # B6g: per-channel webhook budget — bounds capability-URL sprawl (and the
  # per-webhook rate table's distinct pair keys).
  @channel_webhook_cap 50

  # ---------------------------------------------------------------------------
  # Management (native surface, gated manage_channels upstream)
  # ---------------------------------------------------------------------------

  @doc """
  Create a webhook for `channel_id` under `creator_id` (must be a human
  parent — `Principals.mint/4` enforces depth-1). Writes the principal, the
  capability rows, and the channel index. The URL token is generated here and
  returned in the result (it is re-viewable from `list_webhooks/1`). B6g: a
  channel holds at most `channel_webhook_cap/0` webhooks (`{:error,
  :webhook_cap}` past it).
  """
  @spec create_webhook(integer(), String.t(), integer()) ::
          {:ok, t()} | {:error, :unknown_channel | :invalid_name | :invalid_parent | :webhook_cap}
  def create_webhook(channel_id, name, creator_id)
      when is_integer(channel_id) and is_integer(creator_id) and is_binary(name) do
    trimmed = String.trim(name)

    with :ok <- validate_name(trimmed),
         true <- Workspaces.get_channel(channel_id) != nil || {:error, :unknown_channel},
         :ok <- ensure_channel_webhook_cap(channel_id),
         {:ok, principal} <- Principals.mint(creator_id, :webhook, trimmed, nil) do
      # The URL token is the ONLY capability: revoke the mint credential the
      # principal machinery created (provenance rows survive — attribution).
      :ok = Principals.revoke(principal.user_id)

      url_token = mint_url_token()
      now = DateTime.utc_now() |> DateTime.truncate(:millisecond)

      Repo.execute!(
        "INSERT INTO {{K}}.webhooks (webhook_id, channel_id, url_token, created_at) VALUES (?, ?, ?, ?)",
        [{"bigint", principal.user_id}, {"bigint", channel_id}, {"text", url_token}, {"timestamp", now}]
      )

      Repo.execute!(
        "INSERT INTO {{K}}.webhooks_by_channel (channel_id, webhook_id) VALUES (?, ?)",
        [{"bigint", channel_id}, {"bigint", principal.user_id}]
      )

      {:ok,
       %{
         id: principal.user_id,
         channel_id: channel_id,
         token: url_token,
         name: trimmed,
         created_at: now
       }}
    else
      {:error, _} = err -> err
    end
  end

  def create_webhook(_channel_id, _name, _creator_id), do: {:error, :invalid_name}

  @doc "Fetch one webhook (capability row + display label)."
  @spec get_webhook(integer()) :: t() | nil
  def get_webhook(webhook_id) when is_integer(webhook_id) do
    rows =
      Repo.execute!(
        "SELECT webhook_id, channel_id, url_token, created_at FROM {{K}}.webhooks WHERE webhook_id = ?",
        [{"bigint", webhook_id}]
      )
      |> Enum.to_list()

    case rows do
      [row] -> row_to_webhook(row)
      [] -> nil
    end
  end

  @doc """
  Whether `user_id` CREATED this webhook — the creator's claim, read from the
  principal the mint wrote (`principals.parent_user_id`), not from a column.

  This is what makes the owner-scoped routes safe without a schema change: the
  relationship has been recorded since the webhook surface shipped, so every
  webhook that exists today already answers this correctly. A caller who is not
  the parent is a no, and callers must render that as the SAME not-found as an
  unknown id — the check is not an oracle for other people's webhook ids.
  """
  @spec owner?(integer(), integer()) :: boolean()
  def owner?(webhook_id, user_id) when is_integer(webhook_id) and is_integer(user_id) do
    case Principals.get(webhook_id) do
      %{parent_user_id: ^user_id} -> true
      _ -> false
    end
  end

  @doc """
  A user's OWN webhooks, newest first, each with its DESTINATION (the channel
  and its workspace) — the creator's view.

  No new storage: `list_by_parent/1` already enumerates them, because the mint
  writes both the parent column and the `subs_by_parent` index row. The only
  work here is resolving each principal to its live capability row and naming
  where it posts, so a user-scoped list is readable without the caller knowing
  any workspace.

  Two kinds of row are DROPPED rather than returned: a principal whose
  `webhooks` row is gone (revoked), and one whose channel is gone (the channel
  cascade deletes the capability row, so this is the belt to that braces).
  `list_by_parent/1` answers about PROVENANCE, which survives revocation for
  attribution; this answers about live webhooks, and a zombie with a URL that
  cannot post is worse than no row.
  """
  @spec list_by_owner(integer()) :: [map()]
  def list_by_owner(user_id) when is_integer(user_id) do
    Principals.list_by_parent(user_id)
    |> Enum.filter(&(&1.kind == :webhook))
    |> Enum.flat_map(fn principal ->
      case describe_for_owner(principal.user_id) do
        nil -> []
        row -> [row]
      end
    end)
    |> Enum.sort_by(& &1.created_at, {:desc, DateTime})
  end

  @doc """
  ONE webhook in the owner's shape: the capability row plus its named
  destination, or nil when either is gone.

  Exposed so a single-row response (a rename) and the list cannot disagree
  about what an owner's webhook looks like — the list applies this per row.
  """
  @spec describe_for_owner(integer()) :: map() | nil
  def describe_for_owner(webhook_id) when is_integer(webhook_id) do
    with %{} = webhook <- get_webhook(webhook_id),
         %{} = destination <- destination_of(webhook.channel_id) do
      Map.put(webhook, :destination, destination)
    else
      _ -> nil
    end
  end

  # The webhook's destination, named: the channel the row points at and the
  # workspace that owns it. Nil when either is gone — a webhook posting into a
  # channel that no longer exists cannot post at all.
  defp destination_of(channel_id) do
    case Workspaces.get_channel(channel_id) do
      nil ->
        nil

      channel ->
        workspace = channel.workspace_id && Workspaces.get_workspace(channel.workspace_id)

        %{
          channel_id: channel.channel_id,
          channel_name: channel.name,
          workspace_id: channel.workspace_id,
          workspace_name: workspace && workspace.name
        }
    end
  end

  @doc "A channel's webhooks, webhook_id ascending (token re-viewable — Discord parity)."
  @spec list_webhooks(integer()) :: [t()]
  def list_webhooks(channel_id) when is_integer(channel_id) do
    Repo.execute!(
      "SELECT webhook_id FROM {{K}}.webhooks_by_channel WHERE channel_id = ?",
      [{"bigint", channel_id}]
    )
    |> Enum.to_list()
    |> Enum.sort_by(& &1["webhook_id"])
    |> Enum.map(&get_webhook(&1["webhook_id"]))
    |> Enum.reject(&is_nil/1)
  end

  @doc "Rename (display label only — metadata, no capability effect)."
  @spec rename_webhook(integer(), String.t()) :: :ok | {:error, :invalid_name | :unknown_webhook}
  def rename_webhook(webhook_id, name) when is_integer(webhook_id) and is_binary(name) do
    trimmed = String.trim(name)

    with :ok <- validate_name(trimmed),
         true <- get_webhook(webhook_id) != nil || {:error, :unknown_webhook} do
      :ok = User.update_profile!(webhook_id, trimmed, nil)
      :ok
    else
      {:error, _} = err -> err
    end
  end

  def rename_webhook(_webhook_id, _), do: {:error, :invalid_name}

  @doc """
  Delete a webhook: capability row + channel index row die (execute 404s from
  then on — the anti-enumeration shape covers it). Provenance (principal,
  users label, subs_by_parent) survives for attribution, like bot revocation.
  """
  @spec delete_webhook(integer()) :: :ok
  def delete_webhook(webhook_id) when is_integer(webhook_id) do
    case get_webhook(webhook_id) do
      %{channel_id: channel_id} ->
        Repo.execute!(
          "DELETE FROM {{K}}.webhooks WHERE webhook_id = ?",
          [{"bigint", webhook_id}]
        )

        Repo.execute!(
          "DELETE FROM {{K}}.webhooks_by_channel WHERE channel_id = ? AND webhook_id = ?",
          [{"bigint", channel_id}, {"bigint", webhook_id}]
        )

        :ok

      nil ->
        :ok
    end
  end

  @doc """
  Channel-delete cascade: every webhook pointing at `channel_id` dies with the
  channel (called from `Workspaces.delete_channel/1`). Execute validity needs
  the channel row anyway, but removing the capability rows keeps the surface
  honest — no zombie URLs, and listing shows nothing for a dead channel.
  """
  @spec delete_for_channel(integer()) :: :ok
  def delete_for_channel(channel_id) when is_integer(channel_id) do
    Repo.execute!(
      "SELECT webhook_id FROM {{K}}.webhooks_by_channel WHERE channel_id = ?",
      [{"bigint", channel_id}]
    )
    |> Enum.to_list()
    |> Enum.each(fn %{"webhook_id" => webhook_id} ->
      Repo.execute!(
        "DELETE FROM {{K}}.webhooks WHERE webhook_id = ?",
        [{"bigint", webhook_id}]
      )
    end)

    Repo.execute!(
      "DELETE FROM {{K}}.webhooks_by_channel WHERE channel_id = ?",
      [{"bigint", channel_id}]
    )

    :ok
  end

  # ---------------------------------------------------------------------------
  # Resolve (the execute gate)
  # ---------------------------------------------------------------------------

  @doc """
  Resolve a capability URL pair. Valid ⟺ the webhook row exists, the token
  matches (constant-time compare — no early-exit oracle), and the channel
  still exists (KD8: webhook row + channel existing; NO rights intersection).
  nil for every miss — callers render the identical anti-enumeration 404.
  """
  @spec resolve_by_url_token(integer(), String.t()) :: t() | nil
  def resolve_by_url_token(webhook_id, url_token)
      when is_integer(webhook_id) and is_binary(url_token) do
    case get_webhook(webhook_id) do
      %{token: stored} = webhook ->
        if Plug.Crypto.secure_compare(stored, url_token) and
             Workspaces.get_channel(webhook.channel_id) != nil,
           do: webhook,
           else: nil

      nil ->
        nil
    end
  end

  # ---------------------------------------------------------------------------
  # Execute (Discord semantics)
  # ---------------------------------------------------------------------------

  @doc """
  Execute a webhook: persist the message authored by the webhook PRINCIPAL and
  (when present) the per-message author override row.

  `payload` is the Discord execute body: `content`, `username`,
  `avatar_url`, `embeds` (validated via the shared U10 caps), `attachments`
  (either the multipart flow's stored file objects or plain descriptor
  metadata — normalized through `Messages.normalize_attachments/1`), plus
  `tts` (accepted, ignored), `allowed_mentions` (Discord's semantics, as for
  every sender — `Cytale.Messages.AllowedMentions`; malformed is
  `:invalid_body`) and `components` (R6,
  components plan: full R1 validation, then the webhook scoping — INTERACTIVE
  components, anything that is not a style-5 link button, are REJECTED
  `{:error, :invalid_components}` because a webhook principal has no gateway
  session to receive clicks; style-5-only link rows are allowed and STORED —
  client-side anchors need no interaction). At least one of `content`/
  `embeds` is required — an embed-only execute persists `""` (KTD11's
  GitHub/Sentry shape). The transformers (`/slack`, `/github`) produce the
  same payload shape.

  Returns `{:ok, message}` where `message` carries `:author_override` (the
  string-keyed wire map) when an override was stored, or `{:error, reason}`
  with reason ∈ `:unknown_webhook | :invalid_body | :invalid_embeds |
  :invalid_components`.
  """
  @spec execute(integer(), String.t(), map()) ::
          {:ok, Messages.t()}
          | {:error, :unknown_webhook | :invalid_body | :invalid_embeds | :invalid_components}
  def execute(webhook_id, url_token, payload) when is_integer(webhook_id) and is_map(payload) do
    with %{channel_id: channel_id, id: principal_id} <-
           resolve_by_url_token(webhook_id, url_token) || {:error, :unknown_webhook},
         # The composed body through the ONE parser every send route shares
         # (a webhook is a machine author: embeds and action rows accepted
         # under the shared caps), then the webhook's own component scoping.
         {:ok, %{content: content, embeds: embeds, components: components, allowed_mentions: allowed_mentions}} <-
           composed(payload),
         :ok <- link_rows_only?(components),
         {:ok, attachments} <- attachments_param(payload["attachments"]),
         {:ok, override} <- override_param(payload["username"], payload["avatar_url"]),
         override = disambiguate_override(override, channel_id) do
      {:ok, msg} =
        Messages.create_message(%{
          channel_id: channel_id,
          author_id: principal_id,
          content: content,
          thread_id: nil,
          attachments: attachments,
          embeds: embeds,
          components: components,
          # The execute body's `allowed_mentions`, applied by the create
          # itself exactly as for every other sender: a capability URL may
          # broadcast only when it permits it AND the webhook's creator holds
          # `mention_everyone` in the channel (`BroadcastGate`), and it
          # narrows the user mentions that notify.
          allowed_mentions: allowed_mentions
        })

      override = write_override!(msg.id, override)
      {:ok, Map.put(msg, :author_override, override)}
    else
      {:error, _} = err -> err
    end
  end

  # -- payload validation (the shared send rules, U10/KTD11) ---------------------

  # `Cytale.Messages.SendBody` — content, embeds and components exactly as a
  # bot's send parses them — in this surface's error vocabulary.
  defp composed(payload) do
    case Messages.SendBody.parse(payload, %{kind: :webhook}) do
      {:ok, composed} -> {:ok, composed}
      {:error, :invalid_content} -> {:error, :invalid_body}
      {:error, :invalid_allowed_mentions} -> {:error, :invalid_body}
      {:error, reason} -> {:error, reason}
    end
  end

  # Components (components plan R6): after the shared R1 validation, the
  # webhook scoping — INTERACTIVE components (anything that is not a style-5
  # link button) are REJECTED: a webhook principal has no gateway session to
  # receive clicks, so a clickable component would be a dead surface.
  # Style-5-only link rows pass and ride the message stored (client-side
  # anchors).
  defp link_rows_only?([]), do: :ok

  # Every child of every row must be a style-5 link button.
  defp link_rows_only?(list) do
    link_button? = fn child ->
      is_map(child) and match?(%{"type" => 2, "style" => 5}, child)
    end

    if Enum.all?(list, fn row ->
         is_map(row) and is_list(row["components"]) and row["components"] != [] and
           Enum.all?(row["components"], link_button?)
       end),
       do: :ok,
       else: {:error, :invalid_components}
  end

  # Attachment descriptors (the multipart flow's stored objects, or plain
  # metadata for self-hosted URLs) — shared normalization, :invalid_body on
  # the same non-scalar shapes the compat create rejects.
  defp attachments_param(list) do
    case Messages.normalize_attachments(list) do
      {:ok, attachments} -> {:ok, attachments}
      {:error, :invalid_attachments} -> {:error, :invalid_body}
    end
  end

  # username/avatar_url overrides: optional strings; one present stores the
  # row (nil legs stay absent from the wire map).
  defp override_param(username, avatar_url) do
    with :ok <- username_param(username),
         :ok <- avatar_param(avatar_url) do
      override =
        %{}
        |> maybe_override("username", username && String.trim(username))
        |> maybe_override("avatar_url", avatar_url)

      {:ok, override}
    end
  end

  defp username_param(nil), do: :ok

  defp username_param(username) when is_binary(username) do
    trimmed = String.trim(username)

    if String.length(trimmed) in 1..@max_username, do: :ok, else: {:error, :invalid_body}
  end

  defp username_param(_), do: {:error, :invalid_body}

  defp avatar_param(nil), do: :ok

  defp avatar_param(avatar_url) when is_binary(avatar_url) do
    if byte_size(avatar_url) <= @max_avatar_url, do: :ok, else: {:error, :invalid_body}
  end

  defp avatar_param(_), do: {:error, :invalid_body}

  defp maybe_override(map, _key, nil), do: map
  defp maybe_override(map, key, value), do: Map.put(map, key, value)

  defp write_override!(_message_id, override) when map_size(override) == 0, do: nil

  defp write_override!(message_id, override) do
    Repo.execute!(
      "INSERT INTO {{K}}.message_author_overrides (message_id, override_username, override_avatar_url) VALUES (?, ?, ?)",
      [
        {"bigint", message_id},
        {"text", override["username"]},
        {"text", override["avatar_url"]}
      ]
    )

    # The wire map says what the override IS (the read path stamps the same —
    # `Messages`): clients badge the message as a webhook from the message
    # itself, never only from a roster row that may not be loaded.
    Map.put(override, "kind", "webhook")
  end

  # Impersonation guard (Tier 3 B, 10b): an override username that EXACTLY
  # names a member of the channel's workspace — username, display name or
  # workspace nickname, case-insensitively — is suffixed " (webhook)" instead
  # of rendering as that member. Suffixed rather than refused so an
  # integration whose name happens to collide keeps posting. Costs one member
  # read of the workspace (plus one batched user read) per execute that
  # carries an override username; none otherwise.
  @impersonation_suffix " (webhook)"

  defp disambiguate_override(%{"username" => name} = override, channel_id) when is_binary(name) do
    if member_name?(channel_id, name) do
      keep = @max_username - String.length(@impersonation_suffix)
      Map.put(override, "username", String.slice(name, 0, keep) <> @impersonation_suffix)
    else
      override
    end
  end

  defp disambiguate_override(override, _channel_id), do: override

  defp member_name?(channel_id, name) do
    wanted = normalize_name(name)

    with %{workspace_id: workspace_id} when is_integer(workspace_id) <- Workspaces.get_channel(channel_id) do
      rows =
        Repo.stream_rows!(
          "SELECT user_id, nickname FROM {{K}}.workspace_members WHERE workspace_id = ?",
          [{"bigint", workspace_id}]
        )
        |> Enum.to_list()

      Enum.any?(rows, &(normalize_name(&1["nickname"]) == wanted)) or
        rows
        |> Enum.map(& &1["user_id"])
        |> Enum.chunk_every(100)
        |> Enum.any?(fn ids ->
          ids
          |> User.get_many()
          |> Enum.any?(fn {_id, user} ->
            normalize_name(user.username) == wanted or normalize_name(user.display_name) == wanted
          end)
        end)
    else
      _ -> false
    end
  end

  defp normalize_name(nil), do: nil
  defp normalize_name(name) when is_binary(name), do: name |> String.trim() |> String.downcase()

  # ---------------------------------------------------------------------------
  # Internals
  # ---------------------------------------------------------------------------

  @doc """
  Per-channel webhook cap (B6g — default 50).
  """
  @spec channel_webhook_cap :: pos_integer()
  def channel_webhook_cap, do: @channel_webhook_cap

  defp ensure_channel_webhook_cap(channel_id) do
    count =
      Repo.execute!(
        "SELECT webhook_id FROM {{K}}.webhooks_by_channel WHERE channel_id = ?",
        [{"bigint", channel_id}]
      )
      |> Enum.count()

    if count >= @channel_webhook_cap, do: {:error, :webhook_cap}, else: :ok
  end

  defp validate_name(name) do
    if String.length(name) in 1..100, do: :ok, else: {:error, :invalid_name}
  end

  # 32 bytes of strong randomness, url-safe (43 chars) — the URL-legible
  # counterpart of the cytbot_ secret shape (no prefix: it never appears in
  # an Authorization header, only in a URL path).
  defp mint_url_token, do: Base.url_encode64(:crypto.strong_rand_bytes(32), padding: false)

  defp row_to_webhook(row) do
    %{
      id: row["webhook_id"],
      channel_id: row["channel_id"],
      token: row["url_token"],
      name: label_for(row["webhook_id"]),
      created_at: row["created_at"]
    }
  end

  # The display label lives in the principal's users row (U1 shape), exactly
  # like bots/agents.
  defp label_for(webhook_id) do
    case Principals.get(webhook_id) do
      %{label: label} -> label
      nil -> nil
    end
  end
end
