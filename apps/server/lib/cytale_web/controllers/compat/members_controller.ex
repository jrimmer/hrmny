defmodule CytaleWeb.Compat.MembersController do
  @moduledoc """
  PATCH /guilds/:guild_id/members/@me and /guilds/:guild_id/members/:user_id
  (compat, #169): Discord's "Modify Current Member" and the `nick` field of
  "Modify Guild Member" — what discord.py's `guild.me.edit(nick=…)` and
  `member.edit(nick=…)` send. The same path as the native nickname route
  (`CytaleWeb.Nicknames`): a bot's own nickname needs CHANGE_NICKNAME (its
  grant at read_write), anyone else's MANAGE_NICKNAMES below it in the role
  hierarchy. Answers the updated Discord member object.

  Only `nick` is supported; other "Modify Guild Member" fields (roles, mute,
  deaf, channel moves, timeouts) have no Cytale equivalent here and are a
  400 rather than a silent success.
  """

  use CytaleWeb, :controller

  alias Cytale.{Snowflake, Workspaces}
  alias CytaleWeb.Compat.{Errors, MessageCodec}

  @supported ~w(nick)

  def update(conn, %{"guild_id" => gid, "user_id" => uid} = params) do
    claims = conn.assigns.current_user
    body = Map.drop(params, ["guild_id", "user_id"])

    with {:ok, guild_id} <- Snowflake.parse(gid),
         {:ok, target} <- target(uid, claims),
         :ok <- only_nick(body),
         {:ok, nick} <- nick(body),
         {:ok, saved} <- CytaleWeb.Nicknames.change(guild_id, claims, target, nick) do
      entry = Workspaces.roster_entry(guild_id, target)

      json(
        conn,
        MessageCodec.member(MessageCodec.author_object(target), Integer.to_string(guild_id),
          nick: saved,
          joined_at: entry && entry.joined_at
        )
      )
    else
      {:error, :unknown_workspace} ->
        Errors.unknown_guild(conn)

      {:error, :not_member} ->
        Errors.render(conn, 404, 10_007, "Unknown Member")

      {:error, :forbidden} ->
        Errors.missing_permissions(conn)

      {:error, :invalid_nickname} ->
        Errors.invalid_form_body(conn, "nick", "Must be 32 or fewer in length.")

      {:error, :name_taken} ->
        Errors.invalid_form_body(conn, "nick", "Someone in this server already goes by that name.")

      {:error, {:unsupported, field}} ->
        Errors.invalid_form_body(conn, field, "Not supported by this server.")

      _ ->
        Errors.invalid_form_body(conn)
    end
  end

  defp target("@me", %{user_id: me}), do: {:ok, me}
  defp target(uid, _claims), do: Snowflake.parse(uid)

  defp only_nick(body) do
    case Enum.find(Map.keys(body), &(&1 not in @supported)) do
      nil -> :ok
      field -> {:error, {:unsupported, field}}
    end
  end

  # Discord: `nick` null or "" resets it; an absent `nick` changes nothing,
  # but this route supports nothing else, so it is required.
  defp nick(%{"nick" => nick}) when is_binary(nick) or is_nil(nick), do: {:ok, nick}
  defp nick(_), do: {:error, :invalid_nickname}
end
