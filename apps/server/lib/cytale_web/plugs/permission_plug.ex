defmodule CytaleWeb.Plugs.RequirePermitted do
  @moduledoc """
  U9 — permission plug: gates a route on the required permission bit via the
  U7 engine (`Cytale.Permissions.Behaviour`).

  Usage in the router:

      plug CytaleWeb.Plugs.RequirePermitted, permission: :send_messages

  U3 (bots plan): evaluation DELEGATES to `Cytale.Permissions.Principal`
  (KTD3 — the one resolver), so humans and machine principals share a
  single intersection logic with the gateway visibility filter (U7) and
  roster synthesis. HUMAN behavior is byte-identical to the pre-U3 plug:
  same owner check, same 8-step evaluate, same @everyone base, same
  403-vs-404 oracle. Machine principals resolve through the parent
  (`resolve/3`), intersecting the parent's current rights with the
  principal's restrictions (action mask + channel allowlist).

  Resolution context:

    * `:channel_id` param (default) — overwrites come from that channel;
      roles from the channel's parent workspace. The parsed channel id is
      handed to the resolver (the machine channel allowlist is enforced
      there).
    * `:workspace_id` param — workspace-level evaluation (no overwrites).

  A member who can see the resource but lacks the bit gets 403 `forbidden`;
  an unknown resource, a workspace the caller is not a member of, and a
  channel they cannot view are all the same 404 (never an existence oracle).
  """

  @behaviour Plug

  import Plug.Conn

  alias Cytale.Permissions
  alias Cytale.Permissions.Principal
  alias Cytale.Publish.ChannelRoutes
  alias Cytale.Repo
  import CytaleWeb.API.Params, only: [snowflake: 1]

  @impl true
  def init(opts), do: [permission: Keyword.fetch!(opts, :permission)]

  @impl true
  def call(%{assigns: %{current_user: %{user_id: _} = claims}} = conn, permission: required) do
    case resolve_context(conn) do
      {:ok, workspace_id, channel_id} ->
        # Memoized per {user, workspace, channel} under the workspace's
        # RightsEpoch (review #19): the resolve was 4–5 reads on EVERY gated
        # request. Machine principals still resolve fresh (their access
        # document is not epoch-versioned) — see `Principal.resolve_cached/3`.
        case Principal.resolve_cached(workspace_id, claims, channel_id) do
          {:ok, effective} ->
            cond do
              # A channel (or thread) the caller cannot VIEW does not exist
              # for them: 404, exactly like an unknown id — a 403 here would
              # confirm that a private channel exists (Tier 3 B, 11).
              not is_nil(channel_id) and not Permissions.Bitfield.has?(effective, :view_channel) ->
                halt_not_found(conn, not_found_key(conn))

              Permissions.Bitfield.has?(effective, required) ->
                conn
                |> assign(:effective_permissions, effective)
                |> assign_route(workspace_id)

              # A member who can see the resource but lacks the bit: the one
              # case that stays 403.
              true ->
                halt_forbidden(conn)
            end

          {:error, :not_found} ->
            halt_not_found(conn, not_found_key(conn))

          # No membership / unknown parent: "doesn't exist, or you are not a
          # member" is ONE answer — the same 404 as an unknown id (Tier 3 B,
          # 11; the thread paths already answered this way, #35 P0-1). The old
          # 403 for a real-but-foreign workspace or channel was an existence
          # oracle for any authenticated account.
          {:error, :forbidden} ->
            halt_not_found(conn, not_found_key(conn))
        end

      {:dm, dm} ->
        # DM channels (bots plan B-1): PARTICIPATION IS AUTHORIZATION — a
        # recipient passes with the full bitfield (Discord's DM rule). The
        # resolver's workspace-scoped restrictions cannot apply (a DM has no
        # workspace); a non-participant gets the same 404 as an unknown
        # channel (anti-enumeration — a DM's existence is not an oracle).
        dm_case(conn, claims, dm, required)

      {:error, :not_found} ->
        halt_not_found(conn, not_found_key(conn))

      _ ->
        halt_forbidden(conn)
    end
  end

  # Unauthenticated requests fail closed here (the Auth plug turns these into
  # 401s first; this clause only guards direct pipeline misconfig).
  def call(conn, _opts), do: halt_forbidden(conn)

  # -- context resolution -------------------------------------------------------

  # A channel param scopes to the channel's parent workspace (and hands the
  # resolver the channel id for overwrites + the machine allowlist); a
  # workspace param evaluates at workspace level (no overwrites). A channel
  # id with no workspace row resolves through dm_channels (the plug's DM
  # branch above) before falling to the 404.
  defp resolve_context(conn) do
    cond do
      channel_bin = path_param(conn, "channel_id") ->
        with {:ok, channel_id} <- snowflake(channel_bin) do
          case fetch_channel_workspace(channel_id) do
            {:ok, ws_id} -> {:ok, ws_id, channel_id}
            :error -> dm_context(channel_id)
          end
        else
          _ -> {:error, :not_found}
        end

      # Thread-scoped paths (#35 P0-1 / S-P2-14): a thread authorizes
      # through its PARENT channel — the same anchor the compat thread
      # routes use. Workspace parents resolve roles/overwrites; DM parents
      # resolve participation below. An unknown thread is a 404, never a
      # permission oracle.
      thread_bin = path_param(conn, "thread_id") ->
        with {:ok, thread_id} <- snowflake(thread_bin),
             %{channel_id: parent_id} <- Cytale.Threads.Thread.get(thread_id) do
          case fetch_channel_workspace(parent_id) do
            {:ok, ws_id} -> {:ok, ws_id, parent_id}
            :error -> dm_context(parent_id)
          end
        else
          _ -> {:error, :not_found}
        end

      ws_bin = path_param(conn, "workspace_id") ->
        with {:ok, ws_id} <- snowflake(ws_bin) do
          {:ok, ws_id, nil}
        end

      true ->
        :error
    end
  end

  # ONE dm_channels read decides both "is it a DM" and (below) participation —
  # the row rides the context instead of being fetched again.
  defp dm_context(channel_id) do
    case Cytale.Workspaces.get_dm(channel_id) do
      nil -> {:error, :not_found}
      dm -> {:dm, dm}
    end
  end

  # DM participation IS authorization (B-1): a recipient passes with the full
  # bitfield; anyone else gets the anti-enumeration 404 (keyed by the path's
  # resource — thread_not_found for thread-scoped paths).
  defp dm_case(conn, claims, dm, required) do
    # A machine participant holds only its access document's DM grant
    # (`Principal.dm_bits/1`); a person holds everything (Discord's rule).
    bits = Principal.dm_bits(claims)

    cond do
      not Cytale.Workspaces.dm_participant?(dm, claims.user_id) ->
        halt_not_found(conn, not_found_key(conn))

      not Permissions.Bitfield.has?(bits, :view_channel) ->
        halt_not_found(conn, not_found_key(conn))

      Permissions.Bitfield.has?(bits, required) ->
        conn
        |> assign(:effective_permissions, bits)
        |> assign_dm_route(dm)

      true ->
        halt_forbidden(conn)
    end
  end

  # What the gate learned about a `:channel_id` path, handed to the controller
  # as `conn.assigns.channel_route` so the send path never re-reads it (review
  # #18): `{:channel, workspace_id}` for a workspace channel, `{:dm, dm_row}`
  # for a DM. Only for channel-scoped paths — a thread path's route names its
  # PARENT, which is not what a controller holding the thread id would expect.
  defp assign_route(conn, workspace_id) do
    if path_param(conn, "channel_id"),
      do: assign(conn, :channel_route, {:channel, workspace_id}),
      else: conn
  end

  defp assign_dm_route(conn, dm) do
    if path_param(conn, "channel_id"),
      do: assign(conn, :channel_route, {:dm, dm}),
      else: conn
  end

  defp path_param(conn, key) do
    case conn.path_params do
      %{^key => v} -> v
      _ -> nil
    end
  end

  # The channel→workspace route: the publish seam's cache first (a channel
  # never changes workspace; a deleted one is tombstoned there by
  # `Workspaces.delete_channel/1`), the row read only on a miss.
  defp fetch_channel_workspace(channel_id) do
    case ChannelRoutes.fetch(channel_id) do
      {:ok, ws_id} ->
        {:ok, ws_id}

      :error ->
        case channel_rows(channel_id) do
          [%{"workspace_id" => ws_id}] when is_integer(ws_id) ->
            :ok = ChannelRoutes.put(channel_id, ws_id)
            {:ok, ws_id}

          _ ->
            :error
        end
    end
  end

  # -- data loading (partition-keyed point queries only) ------------------------

  defp channel_rows(channel_id) do
    Repo.query!(
      "SELECT workspace_id FROM {{K}}.channels_by_id WHERE channel_id = ?",
      [{"bigint", channel_id}]
    )
    |> Enum.to_list()
  rescue
    _ -> []
  end

  # -- denials -------------------------------------------------------------------

  defp halt_forbidden(conn) do
    conn
    |> put_resp_content_type("application/json")
    |> send_resp(403, Jason.encode!(error_envelope("forbidden", 40_003)))
    |> halt()
  end

  defp halt_not_found(conn, key) do
    conn
    |> put_resp_content_type("application/json")
    |> send_resp(404, Jason.encode!(error_envelope(key, 40_404)))
    |> halt()
  end

  # The scoped 404 key per the rest.md contract: whichever resource the plug
  # actually failed to resolve (channel first — the deeper path param).
  defp not_found_key(conn) do
    cond do
      path_param(conn, "channel_id") -> "channel_not_found"
      path_param(conn, "thread_id") -> "thread_not_found"
      path_param(conn, "workspace_id") -> "workspace_not_found"
      true -> "not_found"
    end
  end

  defp error_envelope(key, code) do
    %{"error" => %{"key" => key, "code" => code, "message" => "Request denied."}}
  end
end
