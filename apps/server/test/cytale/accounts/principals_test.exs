defmodule Cytale.Accounts.PrincipalsTest do
  @moduledoc """
  U1 (bots plan) — principal storage: mint writes the users row (null
  email/password_hash, no login-lookup rows, label in display_name) plus the
  provenance rows (principals, subs_by_parent) and a hash-at-rest cytbot_
  credential; get/list/revoke; restrictions parse/validate. Kind ints are a
  storage detail mapped at this boundary (0 human, 1 bot, 2 webhook, 3 agent).
  """

  use Cytale.ScyllaCase, async: false

  alias Cytale.Accounts.{Principals, User}
  alias Cytale.Test.AgentGrants
  alias Cytale.Repo

  defp run_nonce, do: "r" <> Cytale.TestNonce.get()
  defp run_unique(base), do: base <> run_nonce()

  defp make_parent(prefix \\ "botparent") do
    {:ok, user} = User.create(run_unique(prefix), run_unique(prefix <> "@example.com"), "password-123")
    user
  end

  defp raw_rows(table, where, params) do
    Repo.execute!(
      "SELECT * FROM #{Repo.keyspace()}.#{table} WHERE #{where}",
      params
    )
    |> Enum.to_list()
  end

  describe "mint/4 happy path" do
    test "bot → users + principal + subs + token rows exist; token is cytbot_ shape with >=32 bytes entropy" do
      parent = make_parent()

      label = run_unique("Deploy Bot")

      assert {:ok, bot} = Principals.mint(parent.user_id, :bot, label)

      # Token shape: secret-scanner-friendly prefix, url-safe, >= 32 bytes of
      # entropy (43+ base64url chars for 32 bytes).
      assert String.starts_with?(bot.token, "cytbot_")
      secret = String.trim_leading(bot.token, "cytbot_")
      assert byte_size(secret) >= 43
      assert Regex.match?(~r/^[A-Za-z0-9_-]+$/, secret)

      # users row exists with the label in display_name.
      user = User.get(bot.user_id)
      assert user.display_name == label
      assert %DateTime{} = user.created_at

      # principals row exists with the kind stored as int (1 = bot).
      parent_id = parent.user_id
      bot_id = bot.user_id

      assert [%{"kind" => 1, "parent_user_id" => ^parent_id}] =
               raw_rows("principals", "user_id = ?", [{"bigint", bot_id}])

      # subs_by_parent row exists (roster synthesis / cascade fan-out).
      assert [%{"principal_id" => ^bot_id, "kind" => 1}] =
               raw_rows("subs_by_parent", "parent_user_id = ? AND principal_id = ?", [
                 {"bigint", parent_id},
                 {"bigint", bot_id}
               ])

      # bot_tokens row stores the SHA-256 hex of the plaintext — never the raw.
      hash = Base.encode16(:crypto.hash(:sha256, bot.token), case: :lower)

      assert [%{"token_hash" => ^hash, "principal_id" => ^bot_id}] =
               raw_rows("bot_tokens", "token_hash = ?", [{"text", hash}])
    end

    test "plaintext token is returned exactly once — later fetches are metadata only" do
      parent = make_parent()
      {:ok, bot} = Principals.mint(parent.user_id, :bot, "Once Bot")

      fetched = Principals.get(bot.user_id)
      listed = Principals.list_by_parent(parent.user_id)
      by_token = Principals.get_by_token(bot.token)

      Enum.each([fetched, by_token | listed], fn m ->
        refute Map.has_key?(m, :token)
        refute Map.has_key?(m, :token_hash)
      end)

      assert fetched.user_id == bot.user_id
      assert by_token.user_id == bot.user_id
    end

    test "all machine kinds round-trip as atoms; humans get no principal row" do
      parent = make_parent()

      for kind <- [:bot, :agent, :webhook] do
        {:ok, p} = Principals.mint(parent.user_id, kind, "K" <> Atom.to_string(kind))
        assert p.kind == kind
        assert Principals.get(p.user_id).kind == kind
      end

      # A human user is a principal conceptually (R1) but carries no
      # provenance row — kind :human is synthesized at the boundary (U2).
      assert Principals.get(parent.user_id) == nil
    end
  end

  describe "machine principals can never log in" do
    test "users row has null email/password_hash/username and no lookup rows" do
      parent = make_parent()
      {:ok, bot} = Principals.mint(parent.user_id, :bot, "Ghost Bot")

      user = User.get(bot.user_id)
      # It HAS a tag now (a credential is a user, with a unique handle)…
      assert is_binary(user.username)
      # …and still nothing that could log in.
      assert user.email == nil
      assert user.password_hash == nil

      # Login identifier lookup can never resolve the label (or anything else)
      # to the machine principal.
      assert User.get_by_identifier("Ghost Bot") == nil
      assert User.get_by_identifier("ghost bot") == nil
      assert raw_rows("users_by_username", "username_lower = ?", [{"text", "ghost bot"}]) == []
      assert raw_rows("users_by_email", "email_lower = ?", [{"text", "ghost bot"}]) == []

      # The parent still resolves unchanged.
      assert User.get_by_identifier(parent.username).user_id == parent.user_id
    end
  end

  describe "restrictions" do
    test "JSON round-trips through mint → get" do
      parent = make_parent()

      # The label carries the run nonce: the DERIVED TAG is unique per server,
      # so a bare name collides with any other suite minting "Scoped Agent".
      {:ok, bot} =
        Principals.mint(parent.user_id, :agent, run_unique("Scoped Agent"), %{
          actions: ["read"],
          channels: ["123", "456"]
        })

      assert Principals.get(bot.user_id).restrictions == %{
               "actions" => ["read"],
               "channels" => ["123", "456"]
             }
    end

    test "nil and empty restrictions are unrestricted (nil policy)" do
      parent = make_parent()
      {:ok, a} = Principals.mint(parent.user_id, :bot, "Free Bot")
      {:ok, b} = Principals.mint(parent.user_id, :bot, "Empty Bot", %{actions: [], channels: []})

      assert Principals.get(a.user_id).restrictions == nil
      assert Principals.get(b.user_id).restrictions == nil
    end

    test "invalid actions rejected at mint" do
      parent = make_parent()

      assert {:error, :invalid_restrictions} =
               Principals.mint(parent.user_id, :bot, "X", %{actions: ["read", "delete"]})

      assert {:error, :invalid_restrictions} = Principals.mint(parent.user_id, :bot, "X", %{actions: [1]})
      assert {:error, :invalid_restrictions} = Principals.mint(parent.user_id, :bot, "X", %{actions: "read"})
    end

    test "invalid channel ids rejected at mint" do
      parent = make_parent()

      assert {:error, :invalid_restrictions} =
               Principals.mint(parent.user_id, :bot, "X", %{channels: ["not-an-id"]})

      assert {:error, :invalid_restrictions} = Principals.mint(parent.user_id, :bot, "X", %{channels: [123]})
      assert {:error, :invalid_restrictions} = Principals.mint(parent.user_id, :bot, "X", %{channels: "123"})
    end

    test "unknown restriction keys rejected" do
      parent = make_parent()
      assert {:error, :invalid_restrictions} = Principals.mint(parent.user_id, :bot, "X", %{webscale: true})
    end
  end

  describe "list_by_parent/1" do
    test "lists the parent's principals only, in principal_id order" do
      parent = make_parent()
      other = make_parent("otherparent")

      {:ok, b1} = Principals.mint(parent.user_id, :bot, run_unique("One"))
      {:ok, a1} = Principals.mint(parent.user_id, :agent, run_unique("Two"))
      {:ok, _other_bot} = AgentGrants.mint_all(other.user_id, :bot, "Not Mine")

      ids = parent.user_id |> Principals.list_by_parent() |> Enum.map(& &1.user_id)
      assert ids == Enum.sort([b1.user_id, a1.user_id])
    end
  end

  describe "error paths" do
    test "duplicate labels for the same parent are allowed (display names not unique)" do
      parent = make_parent()

      assert {:ok, first} = Principals.mint(parent.user_id, :bot, "Twin")
      # The NAME may repeat; the TAG may not — and an explicit tag is how a
      # second "Twin" exists at all.
      assert {:error, :username_taken} = Principals.mint(parent.user_id, :bot, "Twin")
      assert {:ok, second} = Principals.mint(parent.user_id, :bot, "Twin", nil, "twin-2")

      assert first.user_id != second.user_id
      assert Enum.count(Principals.list_by_parent(parent.user_id), &(&1.label == "Twin")) == 2
    end

    test "kind must be a machine kind" do
      parent = make_parent()
      assert {:error, :invalid_kind} = Principals.mint(parent.user_id, :human, "Nope")
      assert {:error, :invalid_kind} = Principals.mint(parent.user_id, :derp, "Nope")
    end

    # B6g: a parent's machine-principal budget — all kinds combined.
    test "the 51st principal for a parent is rejected (:principal_cap)" do
      parent = make_parent()
      cap = Principals.principal_cap()

      for i <- 1..cap do
        kind = if rem(i, 2) == 0, do: :bot, else: :agent
        assert {:ok, _} = Principals.mint(parent.user_id, kind, "Sub #{i}")
      end

      assert Enum.count(Principals.list_by_parent(parent.user_id)) == cap
      assert {:error, :principal_cap} = Principals.mint(parent.user_id, :webhook, "Over Budget")

      # Another parent is unaffected (the budget is per-parent).
      other = make_parent("other_parent")
      assert {:ok, _} = AgentGrants.mint_all(other.user_id, :bot, "Fresh Start")
    end

    test "label must be a non-empty string" do
      parent = make_parent()
      assert {:error, :invalid_label} = Principals.mint(parent.user_id, :bot, "")
      assert {:error, :invalid_label} = Principals.mint(parent.user_id, :bot, String.duplicate("x", 101))
      assert {:error, :invalid_label} = Principals.mint(parent.user_id, :bot, :not_a_string)
    end

    test "parent must exist and be human (depth 1)" do
      assert {:error, :unknown_parent} = AgentGrants.mint_all(999_999_999, :bot, "Orphan")

      parent = make_parent()
      {:ok, bot} = Principals.mint(parent.user_id, :bot, run_unique("Parent Bot"))
      # A machine principal cannot mint sub-identities (R1: depth 1).
      assert {:error, :invalid_parent} = AgentGrants.mint_all(bot.user_id, :agent, "Nested")
    end
  end

  describe "revoke/1" do
    test "deletes token rows; metadata rows remain; get_by_token goes nil" do
      parent = make_parent()
      label = run_unique("Doomed Bot")
      {:ok, bot} = Principals.mint(parent.user_id, :bot, label)

      assert Principals.get_by_token(bot.token) != nil

      assert :ok = Principals.revoke(bot.user_id)

      assert Principals.get_by_token(bot.token) == nil
      hash = Base.encode16(:crypto.hash(:sha256, bot.token), case: :lower)
      assert raw_rows("bot_tokens", "token_hash = ?", [{"text", hash}]) == []

      # Provenance survives revocation (only the credential dies).
      assert Principals.get(bot.user_id).label == label
      assert length(Principals.list_by_parent(parent.user_id)) == 1
    end

    test "revoking a revoked principal is an idempotent no-op" do
      parent = make_parent()
      {:ok, bot} = Principals.mint(parent.user_id, :webhook, "Twice Revoked")

      assert :ok = Principals.revoke(bot.user_id)
      assert :ok = Principals.revoke(bot.user_id)
      assert Principals.get_by_token(bot.token) == nil
    end

    # PERF-8: revocation resolves the credential set through the index
    # partition (no ALLOW FILTERING scan), so the index must be born with the
    # credential and die with it.
    test "mint maintains bot_tokens_by_principal and revoke deletes through it" do
      parent = make_parent()
      {:ok, bot} = Principals.mint(parent.user_id, :bot, "Indexed Bot")

      hash = Base.encode16(:crypto.hash(:sha256, bot.token), case: :lower)
      bot_id = bot.user_id

      assert [%{"principal_id" => ^bot_id, "token_hash" => ^hash}] =
               raw_rows("bot_tokens_by_principal", "principal_id = ?", [{"bigint", bot_id}])

      assert :ok = Principals.revoke(bot.user_id)

      assert raw_rows("bot_tokens_by_principal", "principal_id = ?", [{"bigint", bot_id}]) == []
      assert raw_rows("bot_tokens", "token_hash = ?", [{"text", hash}]) == []
      assert Principals.get_by_token(bot.token) == nil
    end

    # No data-migration framework exists, so a credential minted before
    # bot_tokens_by_principal shipped has a bot_tokens row and NO index row.
    # revoke/1 must self-heal: empty index → one bounded scan → backfill →
    # delete — and the legacy credential must not survive the revoke.
    test "a legacy credential with no index row still revokes (self-healing backfill)" do
      parent = make_parent()
      # The label DERIVES the bot's username, which is unique server-wide —
      # bot_controller_test mints a "Legacy Bot" too, so a fixed label here
      # collides with it (:username_taken) depending on module order.
      {:ok, bot} = Principals.mint(parent.user_id, :bot, run_unique("Legacy Bot"))

      hash = Base.encode16(:crypto.hash(:sha256, bot.token), case: :lower)
      bot_id = bot.user_id

      # Simulate the pre-index state: the credential row exists, the index
      # row was never written.
      Repo.execute!(
        "DELETE FROM {{K}}.bot_tokens_by_principal WHERE principal_id = ?",
        [{"bigint", bot_id}]
      )

      assert raw_rows("bot_tokens", "token_hash = ?", [{"text", hash}]) != []

      assert :ok = Principals.revoke(bot_id)

      assert raw_rows("bot_tokens", "token_hash = ?", [{"text", hash}]) == []
      assert raw_rows("bot_tokens_by_principal", "principal_id = ?", [{"bigint", bot_id}]) == []
      assert Principals.get_by_token(bot.token) == nil
    end
  end

  describe "get_by_token/1" do
    test "resolves the principal (with parent + restrictions) from the plaintext token" do
      parent = make_parent()

      {:ok, bot} =
        Principals.mint(parent.user_id, :agent, "Token Agent", %{actions: ["read"]})

      parent_id = parent.user_id

      assert %{user_id: id, kind: :agent, parent_user_id: ^parent_id, restrictions: %{"actions" => ["read"]}} =
               Principals.get_by_token(bot.token)

      assert id == bot.user_id
    end

    test "unknown / malformed tokens resolve nil without storage errors" do
      assert Principals.get_by_token("cytbot_totally-made-up") == nil
      assert Principals.get_by_token("") == nil
      assert Principals.get_by_token(nil) == nil
    end
  end

  describe "the credential's tag (a bot is a user: one identity rule)" do
    test "an absent username is DERIVED from the display name" do
      {:ok, parent} =
        Cytale.Accounts.User.create(run_unique("tagp"), run_unique("tagp") <> "@example.com", "password-123")

      label = "Helper - Mia #{run_unique("slug")}"
      {:ok, bot} = Principals.mint(parent.user_id, :bot, label, nil)

      # The PROPERTY, not a copy of the slug rule: a valid, lowercase handle
      # derived from the name, with the spaces and capitals gone.
      assert bot.username =~ ~r/^[a-z0-9_.-]{2,32}$/
      assert String.starts_with?(bot.username, "helper-mia")
      refute String.contains?(bot.username, " ")
      # The display name is untouched: the label is free-form, the tag is not.
      assert bot.label == label
      # And the tag is the REAL users-row username, not a display-name echo.
      assert Cytale.Accounts.User.get(bot.user_id).username == bot.username
    end

    test "a taken name REFUSES the mint — never a silent suffix (owner rule)" do
      {:ok, parent} =
        Cytale.Accounts.User.create(run_unique("tagq"), run_unique("tagq") <> "@example.com", "password-123")

      # The handle space is shared and persists across the run, so the label
      # carries a nonce — the RULE under test is the refusal, not the literal.
      label = "Helper - Mia #{run_unique("dup")}"

      {:ok, first} = Principals.mint(parent.user_id, :bot, label, nil)
      assert String.starts_with?(first.username, "helper-mia")

      # Same name again → refused, so the CALLER decides (different name or an
      # explicit tag). A mint must not rename your credential behind your back.
      assert {:error, :username_taken} = Principals.mint(parent.user_id, :bot, label, nil)

      # The explicit-tag door is still open: a chosen tag mints fine even when
      # the NAME is what collides.
      assert {:ok, chosen} = Principals.mint(parent.user_id, :bot, label, nil, "max-agent")
      assert chosen.username == "max-agent"
    end

    test "an explicit username is honored, and refuses a taken one instead of altering it" do
      {:ok, parent} =
        Cytale.Accounts.User.create(run_unique("tagr"), run_unique("tagr") <> "@example.com", "password-123")

      {:ok, bot} = Principals.mint(parent.user_id, :bot, "Whatever", nil, "chosen-tag")
      assert bot.username == "chosen-tag"

      # Refused, NOT silently derived: an explicit tag is a choice.
      assert {:error, :username_taken} =
               Principals.mint(parent.user_id, :bot, "Other", nil, "chosen-tag")

      # And it shares the SAME space as human handles, case-insensitively.
      assert {:error, :username_taken} =
               Principals.mint(parent.user_id, :bot, "Other", nil, "CHOSEN-TAG")

      assert {:error, :invalid_username} =
               Principals.mint(parent.user_id, :bot, "Other", nil, "has spaces")

      assert {:error, :invalid_username} =
               Principals.mint(parent.user_id, :bot, "Other", nil, "x")
    end

    test "revocation FREES the tag — mint → revoke → re-mint same tag (owner loop)" do
      {:ok, parent} =
        Cytale.Accounts.User.create(run_unique("tagfree"), run_unique("tagfree") <> "@example.com", "password-123")

      {:ok, bot} = Principals.mint(parent.user_id, :bot, "Ada Openclaw", nil, "ada")
      assert Cytale.Accounts.User.username_taken?("ada")

      :ok = Principals.delete_machine_principal!(bot.user_id)

      # The tag is back in the pool…
      refute Cytale.Accounts.User.username_taken?("ada")

      # …so the same credential can be recreated under the same tag.
      assert {:ok, reborn} = Principals.mint(parent.user_id, :bot, "Ada Openclaw", nil, "ada")
      assert reborn.username == "ada"

      # Attribution survives: the DEAD credential's users row is still there.
      assert Cytale.Accounts.User.get(bot.user_id) != nil
    end

    test "revocation does NOT free a HUMAN handle (account deletion keeps it)" do
      {:ok, human} =
        Cytale.Accounts.User.create(
          run_unique("humanhandle"),
          run_unique("humanhandle") <> "@example.com",
          "password-123"
        )

      handle = human.username

      # Soft-delete, the way account deletion actually ships.
      Cytale.Repo.execute!(
        "UPDATE #{Cytale.Repo.keyspace()}.users SET deleted_at = ? WHERE user_id = ?",
        [{"timestamp", DateTime.utc_now() |> DateTime.truncate(:millisecond)}, {"bigint", human.user_id}]
      )

      # The "handle not reusable" rule for accounts is untouched.
      assert Cytale.Accounts.User.username_taken?(handle)
    end

    test "the tag cannot forge a mention, and a human handle cannot be taken" do
      {:ok, human} =
        Cytale.Accounts.User.create(
          run_unique("takenhuman"),
          run_unique("takenhuman") <> "@example.com",
          "password-123"
        )

      assert {:error, :username_taken} =
               Principals.mint(human.user_id, :bot, "Sneaky", nil, human.username)

      assert {:error, :invalid_username} =
               Principals.mint(human.user_id, :bot, "At", nil, "at@thing")
    end
  end
end
