defmodule CytaleWeb.Compat.UsersController do
  @moduledoc """
  GET /api/v10/users/@me (compat, bots plan U6): the authenticated machine
  principal as a bare Discord user object (no envelope wrapper). Bot-scheme
  auth and the rate-limit header set ride the :compat pipeline; there is no
  permission gate — the caller IS the subject.
  """

  use CytaleWeb, :controller

  alias Cytale.{Access, Snowflake, Workspaces}
  alias Cytale.Gateway.PushRegistry
  alias CytaleWeb.Compat.{Errors, GatewayDialect, MessageCodec}

  @doc "GET /users/@me — Discord user object (`bot: true`, `discriminator: \"0\"`)."
  def me(conn, _params) do
    json(conn, MessageCodec.user_object(conn.assigns.current_user))
  end

  @doc """
  GET /users/@me/guilds — what discord.py's `fetch_guilds()` calls. A bare
  array of PARTIAL guild objects for the workspaces this credential is
  ASSOCIATED with: the parent's memberships ∩ a non-none grant (membership by
  association — the same inclusion rule the roster applies), so an un-granted
  credential lists nothing. Each entry carries the credential's OWN resolved
  workspace bits (parent ∩ grant) as Discord's string permissions.
  """
  def guilds(conn, _params) do
    claims = conn.assigns.current_user
    doc = Map.get(claims, :access)

    guilds =
      claims.parent_user_id
      |> Workspaces.workspaces_of_user()
      |> Enum.filter(&(Access.level_for_workspace(doc, &1.workspace_id) != :none))
      |> Enum.map(&MessageCodec.partial_guild/1)

    json(conn, guilds)
  end

  @doc """
  GET /guilds/:guild_id — fetch_guild(). Same association rule as the index;
  anything else is Discord's compat-shaped 404 10004, so a client raises
  NotFound instead of dying on a native error body (the missing-route shape
  is not something discord.py parses). `with_counts` — which discord.py sends
  BY DEFAULT — adds the approximate member/presence counts.
  """
  def guild(conn, %{"guild_id" => id} = params) do
    claims = conn.assigns.current_user
    doc = Map.get(claims, :access)

    with {:ok, guild_id} <- Snowflake.parse(id),
         ws when ws != nil <- Workspaces.get_workspace(guild_id),
         true <- associated?(doc, claims, guild_id) do
      payload =
        ws
        |> MessageCodec.partial_guild()
        |> with_counts(params, guild_id)

      json(conn, payload)
    else
      _ -> Errors.unknown_guild(conn)
    end
  end

  @doc """
  GET /guilds/:guild_id/channels — guild.fetch_channels(). The guild must be
  ASSOCIATED (else 10004, same as fetch_guild); the listed channels are the
  credential's VISIBLE set from `GatewayDialect.visible_channel_ids/3` — the
  ONE visibility computation the gateway memo and the REST thread surface
  already share, so all three answer identically. Objects are
  `MessageCodec.channel/1`, the same shape GUILD_CREATE carries (`position`
  is REQUIRED by discord.py: #64).
  """
  def guild_channels(conn, %{"guild_id" => id}) do
    claims = conn.assigns.current_user
    doc = Map.get(claims, :access)

    with {:ok, guild_id} <- Snowflake.parse(id),
         ws when ws != nil <- Workspaces.get_workspace(guild_id) do
      # ONE channels read and ONE visibility computation for both the
      # association gate and the listing (hardening plan 5.10): the gate used to
      # resolve the whole visible set — its own channels list plus the batch
      # overwrites read — and the body immediately did it again.
      channels = Workspaces.list_channels(guild_id)
      visible = GatewayDialect.visible_channel_ids(guild_id, claims, channels)

      if associated_with?(doc, guild_id, visible) do
        json(conn, Enum.map(Enum.filter(channels, &MapSet.member?(visible, &1.channel_id)), &MessageCodec.channel/1))
      else
        Errors.unknown_guild(conn)
      end
    else
      _ -> Errors.unknown_guild(conn)
    end
  end

  # Association = ANY reach in the workspace: a ws-level grant, OR a
  # channel-level one. `level: none` with a channel read is the narrowing
  # shape the gateway already treats as in-profile — this route must agree
  # with it, or fetch_channels would 404 a guild fetch_guild could see.
  defp associated?(doc, claims, guild_id) do
    associated_with?(doc, guild_id, GatewayDialect.visible_channel_ids(guild_id, claims, nil))
  end

  # The set-taking half, so a caller that already computed visibility (the
  # channels route) does not compute it twice.
  defp associated_with?(doc, guild_id, visible) do
    Access.level_for_workspace(doc, guild_id) != :none or MapSet.size(visible) > 0
  end

  defp with_counts(payload, params, guild_id) do
    if params["with_counts"] in [true, 1, "true", "1"] do
      # A BOUNDED count, not a roster (hardening plan 5.10): the field is
      # Discord's APPROXIMATE member count, and the old shape paged 1000 FULL
      # member rows (nickname, joined_at, roles) into memory to call `length/1`
      # on them.
      members = Workspaces.approximate_member_count(guild_id)

      presence =
        guild_id
        |> Integer.to_string()
        |> PushRegistry.workspace_key()
        |> PushRegistry.subscribers()
        |> Enum.map(fn {_pid, user_id} -> user_id end)
        |> Enum.uniq()

      Map.merge(payload, %{
        "approximate_member_count" => members,
        "approximate_presence_count" => length(presence)
      })
    else
      payload
    end
  end
end
