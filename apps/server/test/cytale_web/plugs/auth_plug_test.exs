defmodule CytaleWeb.Plugs.AuthPlugTest do
  @moduledoc """
  U2 (bots plan) — REST credential routing in CytaleWeb.Plugs.Auth:

    * `Authorization: Bearer <cytbot_…>` and `Authorization: Bot <cytbot_…>`
      resolve machine principals into the seven-key current_user map with
      `verified: true` (R2: machine principals have no email to verify);
    * the human Bearer JWT path stays byte-identical on its existing keys and
      grows `kind: :human`, `parent_user_id: nil`, `restrictions: nil`,
      `access: nil`;
    * the `Bot` scheme accepts `cytbot_` only — `Bot <JWT>` (or anything
      else) is a uniform 401, as are revoked/missing credentials.

  The plug is invoked directly (it is a plain Plug module) so the claims
  contract is pinned without dragging controller/permission surfaces in.
  """

  use Cytale.ScyllaCase, async: false

  alias Cytale.Accounts.{Auth, Principals, User}
  alias Cytale.Test.AgentGrants

  defp run_unique(base), do: base <> Integer.to_string(System.unique_integer([:positive]))

  defp run_nonce, do: "r" <> Cytale.TestNonce.get()

  defp make_user(prefix) do
    {:ok, user} = User.create(run_nonce() <> prefix, run_nonce() <> prefix <> "@example.com", "password-123")
    user
  end

  defp call_plug(header) do
    conn = Phoenix.ConnTest.build_conn()

    conn =
      if header,
        do: Plug.Conn.put_req_header(conn, "authorization", header),
        else: conn

    CytaleWeb.Plugs.Auth.call(conn, [])
  end

  defp assert_unauthorized(conn) do
    assert conn.halted
    assert conn.status == 401
    assert Jason.decode!(conn.resp_body)["error"]["key"] == "unauthorized"
  end

  # ---------------------------------------------------------------------------
  # Human path (regression pin: existing keys byte-identical + grown keys)
  # ---------------------------------------------------------------------------

  describe "human Bearer JWT" do
    test "claims keep user_id/username/verified exactly and grow kind/parent/restrictions/access" do
      user = make_user("humanplug")

      jwt = Auth.issue_access_token(user.user_id, user.username, false)

      conn = call_plug("Bearer " <> jwt)

      refute conn.halted

      # Exact map: the three pre-U2 keys byte-identical, and exactly the keys
      # the machine-claims model adds (kind/parent/restrictions/access) plus the
      # account credential epoch the terminal plan's R13a rides. Humans carry
      # `access: nil` — only machine principals hold a document.
      assert conn.assigns.current_user == %{
               user_id: user.user_id,
               username: user.username,
               verified: false,
               kind: :human,
               parent_user_id: nil,
               restrictions: nil,
               access: nil,
               epoch: 0
             }
    end

    test "verified humans keep verified: true" do
      user = make_user("humanverplug")

      conn = call_plug("Bearer " <> Auth.issue_access_token(user.user_id, user.username, true))

      assert conn.assigns.current_user.verified == true
      assert conn.assigns.current_user.kind == :human
    end

    test "expired/tampered JWT → uniform 401" do
      assert_unauthorized(call_plug("Bearer eyJhbGciOiJIUzI1NiJ9.bogus.sig"))
    end
  end

  # ---------------------------------------------------------------------------
  # Machine path (cytbot_ static tokens)
  # ---------------------------------------------------------------------------

  describe "machine credentials" do
    test "Bearer cytbot_… → the machine current_user shape with verified: true" do
      parent = make_user("botparent")

      # The claims SHAPE is the subject here, so no policy is needed (a policy
      # naming a channel with no row has no workspace to be granted against).
      {:ok, bot} = AgentGrants.mint_all(parent.user_id, :agent, run_unique("Plug Agent"))

      conn = call_plug("Bearer " <> bot.token)

      refute conn.halted
      parent_id = parent.user_id

      assert conn.assigns.current_user == %{
               user_id: bot.user_id,
               username: bot.username,
               verified: true,
               # One internal kind: the UI's word for both is Agent.
               kind: :bot,
               parent_user_id: parent_id,
               restrictions: nil,
               # The agent's whole authority rides the claims.
               access: bot.access
             }
    end

    test "Bot cytbot_… → the same machine claims as Bearer" do
      parent = make_user("botparent2")
      {:ok, bot} = AgentGrants.mint_all(parent.user_id, :bot, run_unique("Plug Bot"))

      conn = call_plug("Bot " <> bot.token)

      refute conn.halted

      assert conn.assigns.current_user ==
               %{
                 user_id: bot.user_id,
                 username: bot.username,
                 verified: true,
                 kind: :bot,
                 parent_user_id: parent.user_id,
                 restrictions: nil,
                 access: bot.access
               }
    end

    test "revoked credential → uniform 401 under both schemes" do
      parent = make_user("botparent3")
      {:ok, bot} = AgentGrants.mint_all(parent.user_id, :webhook, run_unique("Dead Hook"))
      :ok = Principals.revoke(bot.user_id)

      assert_unauthorized(call_plug("Bot " <> bot.token))
      assert_unauthorized(call_plug("Bearer " <> bot.token))
    end

    test "unknown cytbot_ token → uniform 401" do
      assert_unauthorized(call_plug("Bearer cytbot_" <> String.duplicate("Q", 43)))
      assert_unauthorized(call_plug("Bot cytbot_" <> String.duplicate("Q", 43)))
    end

    test "machine principal with nil label still carries its tag" do
      parent = make_user("botparent4")
      {:ok, bot} = AgentGrants.mint_all(parent.user_id, :bot, run_unique("Labelled"))

      Cytale.Repo.execute!(
        "UPDATE #{Cytale.Repo.keyspace()}.users SET display_name = null WHERE user_id = ?",
        [{"bigint", bot.user_id}]
      )

      conn = call_plug("Bot " <> bot.token)

      refute conn.halted
      # The label is gone; the TAG is the handle and it survives.
      assert conn.assigns.current_user.username == bot.username
      assert conn.assigns.current_user.verified == true
    end
  end

  # ---------------------------------------------------------------------------
  # Scheme routing + 401s
  # ---------------------------------------------------------------------------

  describe "scheme routing" do
    test "Bot <JWT> → 401 (Bot accepts cytbot_ only, never the human JWT)" do
      user = make_user("botjwt")

      assert_unauthorized(call_plug("Bot " <> Auth.issue_access_token(user.user_id, user.username, true)))
    end

    test "Bot with garbage → 401" do
      assert_unauthorized(call_plug("Bot not-a-real-credential-at-all"))
      assert_unauthorized(call_plug("Bot "))
    end

    test "missing header / unknown scheme / non-prefixed Bearer → uniform 401" do
      assert_unauthorized(call_plug(nil))
      assert_unauthorized(call_plug("Basic dXNlcjpwYXNz"))
      assert_unauthorized(call_plug("Bearer not-a-token"))
      assert_unauthorized(call_plug("Token abc"))
    end
  end
end
