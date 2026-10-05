defmodule CytaleWeb.UserController do
  @moduledoc """
  U9 — current-user + people-directory surface. `GET /workspaces/{id}/people`
  is the directory contract U24 search / U26 directory consume: `query=`,
  `before=`, `limit=` (Discord-style pagination over the membership
  partition).
  """

  use CytaleWeb, :controller

  alias Cytale.Accounts.User
  alias Cytale.Workspaces
  import CytaleWeb.API.Params, only: [parse_limit: 2, snowflake: 1, snowflake_opt: 1]
  import CytaleWeb.API.Error, only: [error: 4]

  @doc "GET /users/@me."
  def show_me(conn, _params) do
    %{user_id: user_id} = conn.assigns.current_user

    case User.get(user_id) do
      nil -> error(conn, 404, "user_not_found", "No such user")
      user -> json(conn, %{"user" => user_json(user, conn.assigns.current_user)})
    end
  end

  @doc "PATCH /users/@me — display-name/avatar settings."
  def update_me(conn, params) do
    %{user_id: user_id} = conn.assigns.current_user
    current = User.get(user_id)

    # PATCH semantics: an ABSENT key leaves the field unchanged (renaming
    # must not wipe the avatar); an explicit null/"" clears it.
    display_name =
      if Map.has_key?(params, "display_name"),
        do: map_nilable(params["display_name"]),
        else: current && current.display_name

    # A shown name is unique in a workspace (owner decision 2026-10-04): a
    # NEW display name another member of any of the caller's workspaces is
    # already shown by is refused. Keeping or clearing it never is.
    taken_in =
      if is_binary(display_name) and display_name != (current && current.display_name),
        do: Workspaces.name_taken_in(Workspaces.workspace_ids_of_user(user_id), display_name, user_id),
        else: nil

    cond do
      # avatar_url is clear-only, mirroring the workspace icon contract: a
      # non-empty value is refused so every stored url was minted by the
      # validated upload endpoint (the field renders cross-user now — an
      # arbitrary string would point every viewer at a third-party host).
      Map.has_key?(params, "avatar_url") and not clearable?(params["avatar_url"]) ->
        error(conn, 400, "validation_failed", "avatar_url can only be cleared here; use the avatar upload endpoint.")

      taken_in != nil ->
        name = (Workspaces.get_workspace(taken_in) || %{name: "one of your workspaces"}).name

        error(conn, 409, "name_taken", "Someone in #{name} already goes by that name.")

      true ->
        save_profile(conn, user_id, current, params, display_name)
    end
  end

  defp save_profile(conn, user_id, current, params, display_name) do
    avatar_url =
      if Map.has_key?(params, "avatar_url"),
        do: map_nilable(params["avatar_url"]),
        else: current && current.avatar_url

    :ok = User.update_profile!(user_id, display_name, avatar_url)
    user = User.get(user_id)
    publish_user_update(user)

    json(conn, %{"user" => user_json(user, conn.assigns.current_user)})
  end

  @doc """
  POST /users/@me/avatar — multipart image upload (the `:avatar` purpose:
  2 MB cap, 4096px max dimension, raster images only). Stores the blob through the shared
  content-addressed path and sets `avatar_url` atomically with the upload —
  no two-step upload-then-PATCH, so there is no half-set state to reason
  about. Clearing stays on PATCH /users/@me (`avatar_url: ""`).
  """
  def upload_avatar(conn, params) do
    %{user_id: user_id} = conn.assigns.current_user
    current = User.get(user_id)

    with {:ok, upload} <- Cytale.Attachments.Upload.extract(params),
         {:ok, descriptor} <- Cytale.Attachments.Upload.validate_and_store(upload, :avatar) do
      :ok = User.update_profile!(user_id, current && current.display_name, descriptor["url"])
      user = User.get(user_id)
      publish_user_update(user)

      conn
      |> put_status(201)
      |> json(%{"user" => user_json(user, conn.assigns.current_user)})
    else
      {:error, :no_file} ->
        error(conn, 400, "validation_failed", "A file upload is required.")

      {:error, :too_large} ->
        cap_mb =
          String.trim_trailing(to_string(Float.round(Cytale.Config.avatar_max_upload_bytes() / 1024 / 1024, 1)), ".0")

        error(conn, 413, "file_too_large", "Avatar exceeds the #{cap_mb} MB cap.")

      {:error, :dimensions_exceeded} ->
        max_dim = Cytale.Config.avatar_max_dimension()
        error(conn, 400, "validation_failed", "Avatar image must be at most #{max_dim} pixels on a side.")

      {:error, :disallowed_mime} ->
        error(conn, 415, "unsupported_media_type", "Avatars must be PNG, JPEG, GIF, or WebP.")

      {:error, :volume_full} ->
        error(conn, 507, "storage_full", "Attachment storage is full; try again later.")
    end
  end

  # A lookup names at most one people page's worth of ids.
  @people_ids_cap 100
  @max_bigint 9_223_372_036_854_775_807

  @doc """
  GET /workspaces/:workspace_id/people?query=&before=&limit=

  `?ids=<id>,<id>,…` (at most #{@people_ids_cap}) is the LOOKUP form: the
  roster rows for exactly those ids, in the people page's shape, with every id
  that is not a member (or a granted machine) of the workspace left out — and
  `next_before: null`. It is how a client names an author it has not paged to:
  a workspace of thousands is many pages, but a screen renders only a few
  dozen authors.
  """
  def people(conn, %{"workspace_id" => ws_id, "ids" => ids} = _params) when is_binary(ids) do
    %{user_id: user_id} = conn.assigns.current_user

    with {:ok, workspace_id} <- snowflake(ws_id),
         true <- Workspaces.get_workspace(workspace_id) != nil,
         true <- Workspaces.get_member(workspace_id, user_id) != nil,
         {:ok, user_ids} <- parse_ids(ids) do
      members = workspace_id |> Workspaces.roster_entries(user_ids) |> Enum.map(&Workspaces.roster_entry_wire/1)
      json(conn, %{"people" => members, "next_before" => nil})
    else
      {:error, :too_many_ids} ->
        error(conn, 400, "validation_failed", "ids takes at most #{@people_ids_cap} ids")

      _ ->
        error(conn, 404, "workspace_not_found", "No workspace with that id")
    end
  end

  def people(conn, %{"workspace_id" => ws_id} = params) do
    %{user_id: user_id} = conn.assigns.current_user

    with {:ok, workspace_id} <- snowflake(ws_id),
         true <- Workspaces.get_workspace(workspace_id) != nil,
         true <- Workspaces.get_member(workspace_id, user_id) != nil do
      limit = parse_limit(params["limit"], default: 50, cap: 100)

      members =
        Workspaces.list_members(workspace_id,
          query: params["query"],
          before: snowflake_opt(params["before"]),
          limit: limit,
          include_principals: true
        )
        |> Enum.map(&Workspaces.roster_entry_wire/1)

      # Cursor only when the HUMAN page came back full — a short human page
      # means the roster is exhausted, and a non-nil cursor makes clients
      # render a dead "load more" affordance. Synthesized machine entries
      # ride their parent's row group and never key the cursor (they hold no
      # workspace_members rows, so a machine id would corrupt `before=`).
      humans = Enum.filter(members, &(&1["kind"] == "human"))

      next_cursor =
        case humans do
          [] -> nil
          full when length(full) < limit -> nil
          humans -> humans |> List.last() |> Access.get("user") |> Access.get("id")
        end

      json(conn, %{"people" => members, "next_before" => next_cursor})
    else
      _ -> error(conn, 404, "workspace_not_found", "No workspace with that id")
    end
  end

  # -- helpers -------------------------------------------------------------------

  # `ids=` → distinct snowflakes; a malformed entry is skipped (it names no
  # member either way), more than the cap is refused.
  defp parse_ids(raw) do
    ids =
      raw
      |> String.split(",", trim: true)
      |> Enum.flat_map(fn part ->
        case snowflake(String.trim(part)) do
          {:ok, id} -> [id]
          _ -> []
        end
      end)
      |> Enum.uniq()

    ids = Enum.filter(ids, &(&1 <= @max_bigint))

    if length(ids) > @people_ids_cap, do: {:error, :too_many_ids}, else: {:ok, ids}
  end

  # UserUpdate dispatch (avatar scope, live propagation): profile writes fan
  # out the PUBLIC user shape — id/username/display_name/avatar_url, never
  # email — through the ONE builder people and machines share.
  defp publish_user_update(user), do: CytaleWeb.MemberEvents.announce_profile(user)

  # The @me shape has ONE builder, shared with every token-pair response
  # (login/refresh/register/passkey/SSO/2FA) so a client can adopt the user a
  # login hands back instead of re-reading @me (see `CytaleWeb.API.SelfUser`).
  defp user_json(u, claims), do: CytaleWeb.API.SelfUser.json(u, claims)

  defp map_nilable(""), do: nil
  defp map_nilable(v), do: v

  # Explicit clear (nil/"") — the only PATCH-accepted avatar_url value.
  defp clearable?(nil), do: true
  defp clearable?(""), do: true
  defp clearable?(_), do: false
end
