defmodule CytaleWeb.Controllers.WebhookReactionHardeningTest do
  @moduledoc """
  Tier 3 (B) finding 10:

    * (a) the unauthenticated interaction-continuation lookup resolves a token
      through a hash index, not a scan;
    * (b) a webhook message is stamped as a webhook message, and an override
      that names a member is suffixed rather than rendered as that member;
    * (c) adding a reaction needs ADD_REACTIONS (default-on for members,
      deniable per channel);
    * (d) a channel's parent_id must be a category of the same workspace.
  """

  use Cytale.ScyllaCase, async: false

  alias Cytale.Accounts.{Auth, User}
  alias Cytale.Interactions.TokenStore
  alias Cytale.Permissions.{Bitfield, RightsEpoch}
  alias Cytale.{Messages, Webhooks, Workspaces}

  @endpoint CytaleWeb.Endpoint

  defp uniq(base), do: base <> "wr" <> Cytale.TestNonce.get() <> Integer.to_string(System.unique_integer([:positive]))

  defp create_user(display_name \\ nil) do
    name = uniq("u")
    {:ok, user} = User.create(name, name <> "@example.com", "password-123")
    if display_name, do: :ok = User.update_profile!(user.user_id, display_name, nil)
    User.get(user.user_id)
  end

  defp as(user) do
    build_conn()
    |> put_req_header("accept", "application/json")
    |> put_req_header("content-type", "application/json")
    |> put_req_header("authorization", "Bearer " <> Auth.issue_access_token(user.user_id, user.username, true))
  end

  defp workspace_with_member do
    owner = create_user()
    member = create_user("Display Person")
    {:ok, ws} = Workspaces.create_workspace(owner.user_id, uniq("wr-ws"))
    {:ok, ch} = Workspaces.create_channel(ws.workspace_id, "general")
    :ok = Workspaces.add_member(ws.workspace_id, member.user_id, owner.user_id)
    %{owner: owner, member: member, ws: ws, ch: ch}
  end

  describe "(a) interaction tokens resolve by hash index" do
    test "resolves each token to its own interaction; unknown, expired and revoked miss" do
      app = System.unique_integer([:positive]) + 10_000_000
      id1 = System.unique_integer([:positive]) + 20_000_000
      id2 = id1 + 1
      t1 = "tok-" <> uniq("a")
      t2 = "tok-" <> uniq("b")

      :ok = TokenStore.put(id1, t1, %{application_id: app})
      :ok = TokenStore.put(id2, t2, %{application_id: app})

      assert {:ok, ^id1, %{application_id: ^app}} = TokenStore.resolve_by_token(t1)
      assert {:ok, ^id2, _} = TokenStore.resolve_by_token(t2)
      assert {:error, :unknown_interaction} = TokenStore.resolve_by_token("no-such-token")

      # Revocation purges the row; the index entry alone never resolves.
      assert TokenStore.revoke_principal(app) == 2
      assert {:error, :unknown_interaction} = TokenStore.resolve_by_token(t1)
    end

    test "an expired row does not resolve through the index" do
      saved = Application.get_env(:cytale, :interactions)
      on_exit(fn -> Application.put_env(:cytale, :interactions, saved) end)
      Application.put_env(:cytale, :interactions, Keyword.put(saved || [], :token_ttl_ms, -1))

      id = System.unique_integer([:positive]) + 30_000_000
      token = "tok-" <> uniq("c")
      :ok = TokenStore.put(id, token, %{application_id: 1})
      assert {:error, :unknown_interaction} = TokenStore.resolve_by_token(token)
    end
  end

  describe "(b) webhook identity" do
    test "an override naming a member (username, display name, nickname) is suffixed; others pass" do
      %{owner: owner, member: member, ch: ch} = workspace_with_member()
      {:ok, hook} = Webhooks.create_webhook(ch.channel_id, "Hook", owner.user_id)

      for name <- [member.username, String.upcase(member.username), "Display Person", "  display person "] do
        {:ok, msg} = Webhooks.execute(hook.id, hook.token, %{"content" => "hi", "username" => name})
        assert msg.author_override["username"] == String.trim(name) <> " (webhook)"
        assert msg.author_override["kind"] == "webhook"
      end

      {:ok, msg} = Webhooks.execute(hook.id, hook.token, %{"content" => "hi", "username" => "Deploy Bot"})
      assert msg.author_override["username"] == "Deploy Bot"
    end

    test "the stored message reads back stamped as a webhook message" do
      %{owner: owner, ch: ch} = workspace_with_member()
      {:ok, hook} = Webhooks.create_webhook(ch.channel_id, "Hook", owner.user_id)
      {:ok, msg} = Webhooks.execute(hook.id, hook.token, %{"content" => "hi", "username" => "CI"})

      assert %{author_override: %{"kind" => "webhook", "username" => "CI"}} =
               Messages.get_message(ch.channel_id, msg.id)

      %{"messages" => messages} = json_response(get(as(owner), "/api/v1/channels/#{ch.channel_id}/messages"), 200)
      wire = Enum.find(messages, &(&1["id"] == Integer.to_string(msg.id)))
      assert wire["author_override"] == %{"kind" => "webhook", "username" => "CI"}
    end
  end

  describe "(c) ADD_REACTIONS" do
    test "members may react by default; a channel overwrite denying the bit refuses 403" do
      %{owner: owner, member: member, ws: ws, ch: ch} = workspace_with_member()

      {:ok, msg} =
        Messages.create_message(%{channel_id: ch.channel_id, author_id: owner.user_id, content: "react to me"})

      path = "/api/v1/channels/#{ch.channel_id}/messages/#{msg.id}/reactions/#{URI.encode("👍")}/@me"

      assert put(as(member), path, %{}).status == 204

      Workspaces.put_overwrite(ch.channel_id, :member, member.user_id, 0, Bitfield.bit(:add_reactions))
      RightsEpoch.bump(ws.workspace_id)

      denied =
        put(as(member), "/api/v1/channels/#{ch.channel_id}/messages/#{msg.id}/reactions/#{URI.encode("🎉")}/@me", %{})

      assert %{"error" => %{"key" => "forbidden"}} = json_response(denied, 403)

      # Removing one's own existing reaction is unaffected.
      assert delete(as(member), path).status == 204
    end
  end

  describe "(d) channel parent_id" do
    test "must be a category of the same workspace, never itself" do
      %{owner: owner, ws: ws, ch: text} = workspace_with_member()
      {:ok, category} = Workspaces.create_channel(ws.workspace_id, "cat", type: 1)
      {:ok, other_ws} = Workspaces.create_workspace(owner.user_id, uniq("other"))
      {:ok, foreign_cat} = Workspaces.create_channel(other_ws.workspace_id, "fcat", type: 1)

      create = fn body ->
        post(as(owner), "/api/v1/workspaces/#{ws.workspace_id}/channels", Map.put(body, "name", "c"))
      end

      for bad <- [foreign_cat.channel_id, text.channel_id, 123_456_789, "not-an-id"] do
        resp = create.(%{"parent_id" => to_string(bad)})

        assert %{"error" => %{"key" => "validation_failed"}} = json_response(resp, 400),
               "parent #{inspect(bad)} accepted"
      end

      # A category cannot be nested.
      assert create.(%{"type" => "category", "parent_id" => Integer.to_string(category.channel_id)}).status == 400

      assert %{"channel" => %{"parent_id" => parent}} =
               json_response(create.(%{"parent_id" => Integer.to_string(category.channel_id)}), 201)

      assert parent == Integer.to_string(category.channel_id)
      assert create.(%{"parent_id" => nil}).status == 201

      patch_parent = fn id, parent -> patch(as(owner), "/api/v1/channels/#{id}", %{"parent_id" => parent}) end
      assert patch_parent.(text.channel_id, Integer.to_string(foreign_cat.channel_id)).status == 400
      assert patch_parent.(category.channel_id, Integer.to_string(category.channel_id)).status == 400
      assert patch_parent.(text.channel_id, Integer.to_string(category.channel_id)).status == 200
      assert patch_parent.(text.channel_id, nil).status == 200
    end
  end
end
