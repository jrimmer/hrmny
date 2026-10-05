defmodule Cytale.Workspaces.MediaSettings do
  @moduledoc """
  Calls V2 plan U8 (R16/R17) — the workspace media-capability settings
  context: the workspace MASTER toggles (calls / video / screenshare plus
  the "channels may override" flag), the per-channel tri-state overrides,
  and the effective-capability resolver the U3 op gates consult.

  Resolution rule (R16): a channel's effective capability is its override
  value when the workspace allows overrides AND the override column is
  non-NULL, else the master value. While `overrides_allowed` is false the
  master applies EVERYWHERE — existing override rows stay inert (no
  deletion, instant re-activation when the flag flips back).

  Defaults on absent row (first read, no migration): every capability
  enabled, overrides disallowed — explicit opt-in.

  Gating mirrors the house role machinery (`Cytale.Permissions.Principal`):
  workspace settings are owner/admin (the MANAGE_WORKSPACE bit — the owner
  holds every bit implicitly); channel overrides are manage-channels AND
  only while `overrides_allowed` is set. Denials keep the resolver's oracle
  semantics: unknown workspace/channel (or a non-member actor) is
  `{:error, :unknown_channel}` / `{:error, :not_found}` — never a
  membership oracle; a member without the bit is a real `{:error,
  :forbidden}`.

  DM channels never carry overrides (DM calls skip capability checks —
  `effective_capabilities(nil, _)` is all-true and a DM id resolves as
  `{:error, :unknown_channel}` on the write paths).
  """

  alias Cytale.Permissions.Bitfield
  alias Cytale.Permissions.Principal
  alias Cytale.Repo
  alias Cytale.Workspaces

  @typedoc "The four master switches (R16)."
  @type settings :: %{
          calls: boolean(),
          video: boolean(),
          screenshare: boolean(),
          overrides_allowed: boolean()
        }

  @typedoc "A channel's tri-state override (NULL columns inherit the master)."
  @type override :: %{calls: boolean() | nil, video: boolean() | nil, screenshare: boolean() | nil}

  @typedoc "Effective capabilities for one channel (the op-gate answer)."
  @type capabilities :: %{calls: boolean(), video: boolean(), screenshare: boolean()}

  @capabilities ~w(calls video screenshare)a

  @default_settings %{calls: true, video: true, screenshare: true, overrides_allowed: false}
  @default_override %{calls: nil, video: nil, screenshare: nil}

  # -- workspace master settings ---------------------------------------------------

  @doc """
  The workspace's master media settings. Absent row → the documented
  defaults (everything enabled, overrides disallowed).
  """
  @spec get_workspace_settings(integer()) :: settings()
  def get_workspace_settings(workspace_id) when is_integer(workspace_id) do
    rows =
      Repo.execute!(
        "SELECT calls, video, screenshare, overrides_allowed FROM {{K}}.workspace_media_settings WHERE workspace_id = ?",
        [{"bigint", workspace_id}]
      )
      |> Enum.to_list()

    case rows do
      [r] ->
        %{
          calls: r["calls"] == true,
          video: r["video"] == true,
          screenshare: r["screenshare"] == true,
          overrides_allowed: r["overrides_allowed"] == true
        }

      [] ->
        @default_settings
    end
  end

  @doc """
  Write the workspace's master media settings (owner/admin — the
  MANAGE_WORKSPACE bit through the principal resolver, exactly the
  `PATCH /workspaces/{id}` tier). `attrs` keys are optional; absent keys
  keep their current values. Returns the merged settings.

  `{:error, :not_found}` (unknown workspace) | `{:error, :forbidden}`
  (non-member, or member without the bit).
  """
  @spec put_workspace_settings(integer(), Principal.claims(), map()) ::
          {:ok, settings()} | {:error, :not_found | :forbidden}
  def put_workspace_settings(workspace_id, claims, attrs)
      when is_integer(workspace_id) and is_map(attrs) do
    with {:ok, bits} <- Principal.resolve(workspace_id, claims, nil),
         true <- Bitfield.has?(bits, :manage_workspace) do
      current = get_workspace_settings(workspace_id)

      merged =
        Map.new(@capabilities ++ [:overrides_allowed], fn key ->
          value = Map.get(attrs, key, Map.get(current, key))
          {key, value == true}
        end)

      now = DateTime.utc_now() |> DateTime.truncate(:millisecond)

      Repo.execute!(
        "INSERT INTO {{K}}.workspace_media_settings (workspace_id, calls, video, screenshare, overrides_allowed, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
        [
          {"bigint", workspace_id},
          {"boolean", merged.calls},
          {"boolean", merged.video},
          {"boolean", merged.screenshare},
          {"boolean", merged.overrides_allowed},
          {"timestamp", now}
        ]
      )

      {:ok, merged}
    else
      # A member resolving without the bit is a real 403; unknown workspace
      # and non-member keep the resolver's 404/403 oracle semantics.
      false -> {:error, :forbidden}
      {:error, reason} -> {:error, reason}
    end
  end

  # -- channel overrides -----------------------------------------------------------

  @doc """
  The channel's media override (pure read): NULL columns inherit the
  master. Absent row → all-NULL. DM channels have no rows by design.
  """
  @spec get_channel_override(integer()) :: override()
  def get_channel_override(channel_id) when is_integer(channel_id) do
    rows =
      Repo.execute!(
        "SELECT calls, video, screenshare FROM {{K}}.channel_media_overrides WHERE channel_id = ?",
        [{"bigint", channel_id}]
      )
      |> Enum.to_list()

    case rows do
      [r] ->
        %{calls: r["calls"], video: r["video"], screenshare: r["screenshare"]}

      [] ->
        @default_override
    end
  end

  @doc """
  The channel-override management view for the REST GET: the override row,
  the workspace master, and the `overrides_allowed` flag (manage-channels
  gated — the reader is the channel manager who acts on it).

  `{:error, :unknown_channel}` for unknown channels, DM channels, and
  non-member actors (anti-enumeration); `{:error, :forbidden}` for a
  member without manage-channels.
  """
  @spec get_channel_override_view(integer(), Principal.claims()) ::
          {:ok, %{override: override(), master: settings()}} | {:error, :unknown_channel | :forbidden}
  def get_channel_override_view(channel_id, claims) do
    with {:ok, workspace_id, bits} <- channel_rights(channel_id, claims),
         true <- Bitfield.has?(bits, :manage_channels) do
      {:ok,
       %{
         override: get_channel_override(channel_id),
         master: get_workspace_settings(workspace_id)
       }}
    else
      false -> {:error, :forbidden}
      {:error, reason} -> {:error, reason}
    end
  end

  @doc """
  Write the channel's media override (manage-channels gated, and only
  while the workspace allows overrides). `attrs` keys are optional
  tri-states: a `false`/`true` writes the explicit value, `nil` resets
  that capability to inherit the master; absent keys keep their current
  values. Returns the merged override.

  `{:error, :unknown_channel}` (unknown channel, DM, non-member) |
  `{:error, :forbidden}` (member without manage-channels) |
  `{:error, :overrides_not_allowed}` (workspace disallows overrides).
  """
  @spec put_channel_override(integer(), Principal.claims(), map()) ::
          {:ok, override()} | {:error, :unknown_channel | :forbidden | :overrides_not_allowed}
  def put_channel_override(channel_id, claims, attrs)
      when is_integer(channel_id) and is_map(attrs) do
    with {:ok, workspace_id, bits} <- channel_rights(channel_id, claims),
         true <- Bitfield.has?(bits, :manage_channels),
         settings <- get_workspace_settings(workspace_id),
         true <- settings.overrides_allowed do
      current = get_channel_override(channel_id)

      merged =
        Map.new(@capabilities, fn key ->
          case attrs do
            %{^key => value} -> {key, tri_state(value)}
            _ -> {key, Map.get(current, key)}
          end
        end)

      now = DateTime.utc_now() |> DateTime.truncate(:millisecond)

      Repo.execute!(
        "INSERT INTO {{K}}.channel_media_overrides (channel_id, calls, video, screenshare, updated_at) VALUES (?, ?, ?, ?, ?)",
        [
          {"bigint", channel_id},
          {"boolean", merged.calls},
          {"boolean", merged.video},
          {"boolean", merged.screenshare},
          {"timestamp", now}
        ]
      )

      {:ok, merged}
    else
      false ->
        # The `true <-` guard that failed names the real reason: a
        # bit-missing member is forbidden; an allowed-off workspace is the
        # 409-shape conflict.
        override_conflict?(channel_id, claims)

      {:error, reason} ->
        {:error, reason}
    end
  end

  # -- effective resolution (the U3 op-gate seam, R17) ------------------------------

  @doc """
  The channel's EFFECTIVE capabilities for the requesting member:
  override-then-master. `workspace_id` nil (DM channels) → all true — DM
  calls skip capability checks as ever. While the workspace disallows
  overrides the master applies everywhere (rows stay inert, R16).
  """
  @spec effective_capabilities(integer() | nil, integer()) :: capabilities()
  def effective_capabilities(nil, _channel_id),
    do: %{calls: true, video: true, screenshare: true}

  def effective_capabilities(workspace_id, channel_id) do
    master = get_workspace_settings(workspace_id)

    if master.overrides_allowed do
      override = get_channel_override(channel_id)

      %{
        calls: resolve_cap(override.calls, master.calls),
        video: resolve_cap(override.video, master.video),
        screenshare: resolve_cap(override.screenshare, master.screenshare)
      }
    else
      %{calls: master.calls, video: master.video, screenshare: master.screenshare}
    end
  end

  defp resolve_cap(nil, master), do: master
  defp resolve_cap(override, _master), do: override

  # -- internals -------------------------------------------------------------------

  # The channel-scoped rights pre-check shared by the override surfaces:
  # load the workspace channel, resolve the actor's bits IN that channel
  # (overwrites apply), keep the anti-enumeration oracle (unknown channel,
  # DM id, or non-member all → :unknown_channel).
  defp channel_rights(channel_id, claims) do
    case Workspaces.get_channel(channel_id) do
      %{workspace_id: workspace_id} when is_integer(workspace_id) ->
        case Principal.resolve(workspace_id, claims, channel_id) do
          {:ok, bits} -> {:ok, workspace_id, bits}
          {:error, _} -> {:error, :unknown_channel}
        end

      _ ->
        {:error, :unknown_channel}
    end
  end

  # Which `true <-` guard failed on the put path: a member without the bit
  # (forbidden) vs an allowed-off workspace (the 409-shape conflict).
  defp override_conflict?(channel_id, claims) do
    case channel_rights(channel_id, claims) do
      {:ok, workspace_id, bits} ->
        cond do
          not Bitfield.has?(bits, :manage_channels) -> {:error, :forbidden}
          not get_workspace_settings(workspace_id).overrides_allowed -> {:error, :overrides_not_allowed}
          true -> {:error, :forbidden}
        end

      {:error, reason} ->
        {:error, reason}
    end
  end

  defp tri_state(true), do: true
  defp tri_state(false), do: false
  defp tri_state(nil), do: nil
end
