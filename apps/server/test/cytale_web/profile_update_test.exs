defmodule CytaleWeb.ProfileUpdateTest do
  @moduledoc """
  `UserUpdate` is ONE shape for people and bots (2026-10-02): `username` is
  always the handle (the @tag) and `display_name` the name it shows. A bot
  rename used to publish its new LABEL as `username`, so every open client
  replaced the bot's @tag with its display name.
  """

  use Cytale.ScyllaCase, async: false

  import Phoenix.ConnTest
  import Plug.Conn

  alias Cytale.Accounts.{Auth, User}
  alias Cytale.Test.AgentGrants
  alias Cytale.Workspaces

  @endpoint CytaleWeb.Endpoint

  # Captures user-scoped publishes (the UserUpdate seam) to the test process.
  defmodule CapturePublish do
    @behaviour Cytale.Publish
    @key {__MODULE__, :listener}

    def listen(pid), do: :persistent_term.put(@key, pid)
    def unlisten, do: :persistent_term.erase(@key)

    @impl true
    def publish(_channel_id, _event), do: :ok

    @impl true
    def publish_user_update(user_id, event) do
      case :persistent_term.get(@key, nil) do
        nil -> :ok
        pid -> send(pid, {:user_update, user_id, event})
      end

      :ok
    end
  end

  defp nonce, do: "m" <> Cytale.TestNonce.get()

  defp person(base) do
    {:ok, user} = User.create(base <> nonce(), base <> nonce() <> "@example.com", "password-123")
    user
  end

  defp conn_for(user) do
    Phoenix.ConnTest.build_conn()
    |> put_req_header("accept", "application/json")
    |> put_req_header("content-type", "application/json")
    |> put_req_header("authorization", "Bearer " <> Auth.issue_access_token(user.user_id, user.username, true))
  end

  setup do
    owner = person("roster_owner")
    {:ok, ws} = Workspaces.create_workspace(owner.user_id, "roster-" <> nonce())
    {:ok, owner: owner, ws_id: ws.workspace_id}
  end

  describe "UserUpdate: one shape for people and bots" do
    setup do
      old = Application.get_env(:cytale, Cytale.Publish)
      Application.put_env(:cytale, Cytale.Publish, CapturePublish)
      CapturePublish.listen(self())

      on_exit(fn ->
        CapturePublish.unlisten()

        if old,
          do: Application.put_env(:cytale, Cytale.Publish, old),
          else: Application.delete_env(:cytale, Cytale.Publish)
      end)

      :ok
    end

    test "a bot rename keeps its handle in `username`; the new label rides `display_name`", %{owner: owner} do
      {:ok, bot} = AgentGrants.mint_all(owner.user_id, :bot, "Hermes " <> nonce())
      handle = User.get(bot.user_id).username
      assert is_binary(handle)

      resp = patch(conn_for(owner), "/api/v1/bots/#{bot.user_id}", %{"name" => "Hermes Prime"})
      assert resp.status == 200

      bot_id = bot.user_id
      assert_receive {:user_update, ^bot_id, {"UserUpdate", payload}}, 1_000
      assert payload["id"] == Integer.to_string(bot_id)
      assert payload["username"] == handle
      assert payload["display_name"] == "Hermes Prime"
      assert Map.has_key?(payload, "avatar_url")

      # …exactly what a reload reads: the people row names it by label, tags it by handle.
      assert %{username: ^handle, display_name: "Hermes Prime"} =
               Workspaces.roster_entry(hd(Workspaces.workspace_ids_of_user(owner.user_id)), bot_id)
    end

    test "a person's display-name change publishes the same keys", %{owner: owner} do
      resp = patch(conn_for(owner), "/api/v1/users/@me", %{"display_name" => "Owner Person"})
      assert resp.status == 200

      owner_id = owner.user_id
      assert_receive {:user_update, ^owner_id, {"UserUpdate", payload}}, 1_000

      assert payload == %{
               "id" => Integer.to_string(owner_id),
               "username" => owner.username,
               "display_name" => "Owner Person",
               "avatar_url" => nil
             }
    end
  end
end
