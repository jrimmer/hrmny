defmodule CytaleWeb.ChannelController do
  @moduledoc """
  U9 — channel surface: create/list within a workspace, read/update/delete a
  channel. Writes are content-producing mutations (verified gate applies via
  the pipeline) and gated on MANAGE_CHANNELS by the permission plug.
  """

  use CytaleWeb, :controller

  alias Cytale.Permissions.Bitfield
  alias Cytale.Permissions.RightsEpoch
  alias Cytale.Workspaces
  alias CytaleWeb.Compat.Authorize
  import CytaleWeb.API.Params, only: [snowflake: 1, snowflake_opt: 1]
  import CytaleWeb.API.Error, only: [error: 4]

  @doc "POST /workspaces/{id}/channels — create (type: text|category)."
  def create(conn, %{"workspace_id" => ws_id, "name" => name} = params) do
    %{user_id: user_id} = conn.assigns.current_user

    with {:ok, workspace_id} <- snowflake(ws_id),
         true <- Workspaces.get_workspace(workspace_id) != nil,
         type <- parse_type(params["type"]),
         parent_id <- snowflake_opt(params["parent_id"]),
         {:parent, :ok} <- {:parent, parent_check(workspace_id, params, parent_id, type, nil)} do
      case Workspaces.create_channel(workspace_id, name,
             type: type,
             parent_id: parent_id,
             topic: params["topic"],
             position: parse_int(params["position"], 0),
             created_by: user_id
           ) do
        {:ok, ch} ->
          # A new channel changes every compat session's visible set — bump
          # the epoch BEFORE the fan-out so the U7 visibility memo recomputes
          # and the CHANNEL_CREATE membership check sees the new channel.
          # (Channel DELETE deliberately does NOT bump: the deleted row is
          # gone by fan-out time, so the memo's last-epoch set — which still
          # lists the channel when it was in-profile — is the only record
          # CHANNEL_DELETE visibility can be decided against.)
          RightsEpoch.bump(workspace_id)

          # #55: the epoch bump fixes the MEMO; it does nothing for ROUTES.
          # Live sessions computed their fan-out keys at Identify/Resume, so
          # without this poke they hold no `{:channel, id}` key for the new
          # channel — and its renames and new threads (both channel-keyed)
          # would reach nobody, viewer included, until those sessions
          # reconnect. The workspace-scoped announce below still arrives, which
          # is why the gap was easy to miss.
          CytaleWeb.GatewaySocket.refresh_workspace_routes(workspace_id)

          # ChannelCreate is workspace-scoped (the new channel has no
          # subscribers yet — a channel-routed publish would find nobody).
          #
          # `type` and `parent_id` ride along because the reader needs them and
          # cannot derive them: every gateway Channel event carries no `type`
          # key at all (see ChannelTypeWire), so a client that has to guess
          # types EVERY new channel as text — including a category — and files
          # it outside the category it was created in, until a reload replaces
          # the row with the REST shape. The rest is the same object the REST
          # path emits (channel_json), so the two readings cannot drift;
          # `created_at` is added back because channel_json leaves it out and
          # the client's row carries it.
          CytaleWeb.GatewaySocket.fan_out(
            Cytale.Gateway.PushRegistry.workspace_key(Integer.to_string(workspace_id)),
            {"ChannelCreate", Map.put(channel_json(ch), "created_at", DateTime.to_iso8601(ch.created_at))}
          )

          conn
          |> put_status(201)
          |> json(%{"channel" => channel_json(ch)})
      end
    else
      {:parent, _} -> invalid_parent(conn)
      _ -> error(conn, 404, "workspace_not_found", "No workspace with that id")
    end
  end

  def create(conn, _params), do: error(conn, 400, "validation_failed", "name is required")

  # A PRESENT parent_id must pass `Workspaces.check_channel_parent/4`; an
  # unparseable one is refused too (it used to read as "no category").
  defp parent_check(workspace_id, params, parent_id, own_type, own_id) do
    cond do
      not Map.has_key?(params, "parent_id") -> :ok
      params["parent_id"] in [nil, ""] -> :ok
      is_nil(parent_id) -> {:error, :invalid_parent}
      true -> Workspaces.check_channel_parent(workspace_id, parent_id, own_type, own_id)
    end
  end

  defp invalid_parent(conn),
    do: error(conn, 400, "validation_failed", "parent_id must be a category in the same workspace")

  @doc "GET /workspaces/{id}/channels — list channels of a workspace."
  def index(conn, %{"workspace_id" => ws_id}) do
    with {:ok, workspace_id} <- snowflake(ws_id),
         true <- Workspaces.get_workspace(workspace_id) != nil,
         true <- Workspaces.get_member(workspace_id, conn.assigns.current_user.user_id) != nil do
      # Only the channels this principal may VIEW — the same one visibility
      # computation the gateway memo and compat `guild_channels` use. The
      # unfiltered list named every private channel (name, topic, parent) to
      # any member.
      all = Workspaces.list_channels(workspace_id)

      visible =
        CytaleWeb.Compat.GatewayDialect.visible_channel_ids(workspace_id, conn.assigns.current_user, all)

      channels =
        all
        |> Enum.filter(&MapSet.member?(visible, &1.channel_id))
        |> Enum.map(&channel_json/1)

      json(conn, %{"channels" => channels})
    else
      _ -> error(conn, 404, "workspace_not_found", "No workspace with that id")
    end
  end

  @doc "GET /channels/{id}."
  def show(conn, %{"channel_id" => id}) do
    with {:ok, channel_id} <- snowflake(id),
         # The uniform channel gate (#35 P0-1): a channel object (including
         # private-channel shape and overwrite targets one could infer) was
         # readable cross-workspace. DM ids render the DM object for their
         # participants (participation IS authorization, B-1).
         {:ok, channel, _bits} <- Authorize.channel_gate(conn.assigns.current_user, channel_id) do
      case channel do
        %{type: :dm} = dm ->
          json(conn, %{"channel" => dm_channel_json(dm, conn.assigns.current_user.user_id)})

        ch ->
          json(conn, %{"channel" => channel_json(ch)})
      end
    else
      _ -> error(conn, 404, "channel_not_found", "No channel with that id")
    end
  end

  @doc "PATCH /channels/{id} — name/topic/position/parent."
  def update(conn, %{"channel_id" => id} = params) do
    with {:ok, channel_id} <- snowflake(id),
         ch when not is_nil(ch) <- Workspaces.get_channel(channel_id),
         {:parent, :ok} <-
           {:parent, parent_check(ch.workspace_id, params, snowflake_opt(params["parent_id"]), ch.type, channel_id)} do
      # PATCH semantics (the documented contract): an ABSENT key leaves the
      # field unchanged; an explicit null clears it. Passing every key
      # unconditionally wiped name/topic on a partial body — e.g. the
      # category move ({"parent_id": ...}) nulled the channel's name.
      changes =
        %{}
        |> put_present(params, "name", & &1)
        |> put_present(params, "topic", & &1)
        |> put_present(params, "position", &parse_int(&1, nil))
        |> put_present(params, "parent_id", &snowflake_opt(&1))

      :ok = Workspaces.update_channel(channel_id, changes)

      updated = Workspaces.get_channel(channel_id)

      CytaleWeb.GatewaySocket.fan_out(
        Cytale.Gateway.PushRegistry.channel_key(Integer.to_string(channel_id)),
        {"ChannelUpdate",
         %{
           "id" => Integer.to_string(channel_id),
           "name" => updated.name,
           "topic" => updated.topic,
           "position" => updated.position,
           "parent_id" => updated.parent_id && Integer.to_string(updated.parent_id)
         }}
      )

      json(conn, %{"channel" => channel_json(updated)})
    else
      {:parent, _} -> invalid_parent(conn)
      _ -> error(conn, 404, "channel_not_found", "No channel with that id")
    end
  end

  @doc "DELETE /channels/{id}."
  def delete(conn, %{"channel_id" => id}) do
    with {:ok, channel_id} <- snowflake(id),
         ch when not is_nil(ch) <- Workspaces.get_channel(channel_id) do
      :ok = Workspaces.delete_channel(channel_id)

      CytaleWeb.GatewaySocket.fan_out(
        Cytale.Gateway.PushRegistry.workspace_key(Integer.to_string(ch.workspace_id)),
        {"ChannelDelete", %{"id" => Integer.to_string(ch.channel_id)}}
      )

      json(conn, %{"deleted" => Integer.to_string(ch.channel_id)})
    else
      _ -> error(conn, 404, "channel_not_found", "No channel with that id")
    end
  end

  # -- helpers -------------------------------------------------------------------

  defp parse_type("category"), do: 1
  defp parse_type(_), do: 0

  # PATCH-semantic accumulator: only keys the request actually carried land
  # in the changes map (Workspaces.update_channel preserves absent keys).
  #
  # #125 triage (2026-09-20, sobelow DOS.StringToAtom High Confidence): `key`
  # is a CALLER-SUPPLIED LITERAL (the call sites pass fixed names), never user
  # input — the params map is only ever READ here. No attacker-reachable atom
  # creation. The finding is on scripts/security-scan.sh's ledger.
  defp put_present(changes, params, key, transform) do
    if Map.has_key?(params, key) do
      Map.put(changes, String.to_atom(key), transform.(params[key]))
    else
      changes
    end
  end

  # Public for the native READY (lane D #5): the gateway hands the client the
  # same channel rows the workspace channel index does.
  @doc false
  def channel_json(ch) do
    %{
      "id" => Integer.to_string(ch.channel_id),
      "workspace_id" => ch.workspace_id && Integer.to_string(ch.workspace_id),
      "name" => ch.name,
      "type" => ch.type,
      "parent_id" => ch.parent_id && Integer.to_string(ch.parent_id),
      "topic" => ch.topic,
      "position" => ch.position,
      "last_message_id" => ch.last_message_id && Integer.to_string(ch.last_message_id)
    }
  end

  # The DM object shape (matches DmController's channel payload) for the
  # gate-passing participant on GET /channels/:id. `recipients` carries the
  # OTHER participant's full summary (username + avatar for rendering — the
  # DM column resolves its peer from this, no roster needed).
  defp dm_channel_json(dm, viewer_id) do
    %{
      "id" => Integer.to_string(dm.channel_id),
      "workspace_id" => nil,
      "name" => nil,
      "type" => :dm,
      "user_ids" => Enum.map(dm.user_ids || [], &Integer.to_string/1),
      "recipients" => dm_recipients(dm.user_ids || [], viewer_id),
      "last_message_id" => dm.last_message_id && Integer.to_string(dm.last_message_id)
    }
  end

  defp dm_recipients(user_ids, viewer_id) do
    user_ids
    |> Enum.reject(&(&1 == viewer_id))
    |> Enum.map(fn uid ->
      case Cytale.Accounts.User.get(uid) do
        nil ->
          %{"id" => Integer.to_string(uid), "username" => nil, "display_name" => nil, "avatar_url" => nil}

        u ->
          %{
            "id" => Integer.to_string(u.user_id),
            "username" => u.username,
            "display_name" => u.display_name,
            "avatar_url" => u.avatar_url
          }
      end
    end)
  end

  defp parse_int(nil, default), do: default

  defp parse_int(bin, default) when is_binary(bin) do
    case Integer.parse(bin) do
      {n, ""} -> n
      _ -> default
    end
  end

  defp snowflake_str(bin) when is_binary(bin) do
    case Integer.parse(bin) do
      {int, ""} when int > 0 -> {:ok, int}
      _ -> :error
    end
  end

  defp parse_target_type("role"), do: :role
  defp parse_target_type("member"), do: :member
  defp parse_target_type(_), do: :error

  # nil → 0 bits; a list of permission names (wire strings) → their union;
  # anything else is a validation failure. Unknown names stay :error rather
  # than crashing String.to_existing_atom.
  defp perm_names_to_bits(nil), do: {:ok, 0}

  defp perm_names_to_bits(names) when is_list(names) do
    known = MapSet.new(Bitfield.names(), &Atom.to_string/1)

    if Enum.all?(names, &(is_binary(&1) and MapSet.member?(known, &1))) do
      bits =
        Enum.reduce(names, 0, fn name, acc ->
          Bitwise.bor(acc, Bitfield.bit(String.to_existing_atom(name)))
        end)

      {:ok, bits}
    else
      {:error, :bad_names}
    end
  end

  defp perm_names_to_bits(_), do: {:error, :bad_names}

  # ---------------------------------------------------------------------------
  # Channel overwrites (permission deny/allow per target)
  # ---------------------------------------------------------------------------

  @doc "GET /channels/{id}/overwrites — the channel's overwrite rows."
  def overwrites(conn, %{"channel_id" => cid}) do
    with {:ok, channel_id} <- snowflake(cid),
         # Member-target ids of private-channel allow/deny entries are
         # sensitive metadata (#35 P0-1) — gate on the channel's view right
         # first. DMs carry no overwrites; a participant's probe 404s as
         # before.
         {:ok, %{type: type}, _bits} <-
           Authorize.channel_gate(conn.assigns.current_user, channel_id),
         false <- type == :dm do
      rows =
        Workspaces.overwrites(channel_id)
        |> Enum.map(fn ow ->
          %{
            "target_id" => Integer.to_string(ow.target_id),
            "target_type" => if(ow.target_type == :role, do: "role", else: "member"),
            "allow" => Bitfield.to_list(ow.allow || 0),
            "deny" => Bitfield.to_list(ow.deny || 0)
          }
        end)

      json(conn, %{"overwrites" => rows})
    else
      _ -> error(conn, 404, "channel_not_found", "No channel with that id")
    end
  end

  @doc "PUT /channels/{id}/overwrites — upsert one deny/allow row."
  def put_overwrite(conn, %{"channel_id" => cid} = params) do
    with {:ok, channel_id} <- snowflake(cid),
         {:ok, target_id} <- snowflake_str(params["target_id"]),
         target_type when target_type in [:role, :member] <-
           parse_target_type(params["target_type"]),
         {:ok, allow} <- perm_names_to_bits(params["allow"]),
         {:ok, deny} <- perm_names_to_bits(params["deny"]) do
      Workspaces.put_overwrite(channel_id, target_type, target_id, allow, deny)
      bump_channel_workspace_epoch(channel_id)
      json(conn, %{"ok" => true})
    else
      {:error, :bad_names = reason} ->
        error(conn, 400, "validation_failed", "unknown permission name: #{inspect(reason)}")

      _ ->
        error(conn, 404, "channel_not_found", "No channel with that id")
    end
  end

  @doc "DELETE /channels/{id}/overwrites/{target_id} — remove one row."
  def delete_overwrite(conn, %{"channel_id" => cid, "target_id" => tid}) do
    with {:ok, channel_id} <- snowflake(cid),
         {:ok, target_id} <- snowflake_str(tid) do
      Workspaces.delete_overwrite(channel_id, target_id)
      bump_channel_workspace_epoch(channel_id)
      json(conn, %{"ok" => true})
    else
      _ -> error(conn, 404, "channel_not_found", "No channel with that id")
    end
  end

  # An overwrite mutation is a rights mutation (KTD4): bump the PARENT
  # workspace's epoch so every memoized rights consumer recomputes.
  defp bump_channel_workspace_epoch(channel_id) do
    case Workspaces.get_channel(channel_id) do
      %{workspace_id: workspace_id} when is_integer(workspace_id) ->
        RightsEpoch.bump(workspace_id)

      _ ->
        :ok
    end
  end
end
