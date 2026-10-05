defmodule Cytale.WebhooksTest do
  @moduledoc """
  U11 (bots plan) — the webhooks context: capability-row lifecycle (create /
  list / rename / delete / channel cascade), resolve-by-url-token (the
  execute gate), Discord execute semantics (content/embeds/override rows),
  and the /slack + /github payload transformers (pure functions).
  """

  use Cytale.ScyllaCase, async: false

  alias Cytale.Accounts.Principals
  alias Cytale.Test.AgentGrants
  alias Cytale.Accounts.User
  alias Cytale.Messages
  alias Cytale.Webhooks
  alias Cytale.Workspaces

  defp run_nonce,
    do:
      "r" <>
        Integer.to_string(
          :erlang.phash2({System.system_time(:millisecond), System.unique_integer([:positive])}, 1_000_000_000)
        )

  defp run_unique(base), do: base <> run_nonce()

  setup do
    {:ok, owner} = User.create(run_unique("whc_owner"), run_unique("whc_owner@example.com"), "password-123")
    {:ok, ws} = Workspaces.create_workspace(owner.user_id, run_unique("whc-ws"))
    {:ok, ch} = Workspaces.create_channel(ws.workspace_id, "alerts")
    {:ok, owner: owner, ch: ch}
  end

  # ---------------------------------------------------------------------------
  # Management lifecycle
  # ---------------------------------------------------------------------------

  describe "create/list/rename/delete" do
    test "create writes the principal + capability rows; the token is url-safe 43 chars", %{
      ch: ch,
      owner: owner
    } do
      assert {:ok,
              %{
                id: webhook_id,
                channel_id: channel_id,
                token: token,
                name: "Deploy Hook",
                created_at: %DateTime{}
              }} = Webhooks.create_webhook(ch.channel_id, " Deploy Hook ", owner.user_id)

      assert channel_id == ch.channel_id
      assert byte_size(token) == 43
      assert token =~ ~r/^[A-Za-z0-9_-]+$/

      # Principal provenance (roster synthesis picks it up via U5).
      principal = Principals.get(webhook_id)
      assert principal.kind == :webhook
      assert principal.label == "Deploy Hook"

      # The capability rows resolve back.
      assert Webhooks.get_webhook(webhook_id).token == token
      assert Enum.map(Webhooks.list_webhooks(ch.channel_id), & &1.id) == [webhook_id]
    end

    test "create validations: unknown channel, blank/oversize name, machine parent", %{
      ch: ch,
      owner: owner
    } do
      assert {:error, :unknown_channel} =
               Webhooks.create_webhook(Cytale.Snowflake.next(), "X", owner.user_id)

      assert {:error, :invalid_name} = Webhooks.create_webhook(ch.channel_id, "   ", owner.user_id)
      assert {:error, :invalid_name} = Webhooks.create_webhook(ch.channel_id, String.duplicate("x", 101), owner.user_id)
      assert {:error, :invalid_name} = Webhooks.create_webhook(ch.channel_id, :not_a_name, owner.user_id)

      # R1 depth-1: a machine principal cannot mint.
      {:ok, bot} = AgentGrants.mint_all(owner.user_id, :bot, run_unique("Parent Bot"))
      assert {:error, :invalid_parent} = Webhooks.create_webhook(ch.channel_id, "X", bot.user_id)
    end

    test "list is id-ascending and scoped to the channel", %{ch: ch, owner: owner} do
      {:ok, other} = Workspaces.create_channel(ch.workspace_id, "other")
      {:ok, a} = Webhooks.create_webhook(ch.channel_id, "A", owner.user_id)
      {:ok, b} = Webhooks.create_webhook(ch.channel_id, "B", owner.user_id)
      {:ok, c} = Webhooks.create_webhook(other.channel_id, "C", owner.user_id)

      assert Enum.map(Webhooks.list_webhooks(ch.channel_id), & &1.id) == Enum.sort([a.id, b.id])
      assert Enum.map(Webhooks.list_webhooks(other.channel_id), & &1.id) == [c.id]
    end

    test "rename updates the display label; delete removes rows but keeps provenance", %{
      ch: ch,
      owner: owner
    } do
      {:ok, webhook} = Webhooks.create_webhook(ch.channel_id, "Old", owner.user_id)

      assert :ok = Webhooks.rename_webhook(webhook.id, "New")
      assert Principals.get(webhook.id).label == "New"
      assert Webhooks.get_webhook(webhook.id).name == "New"

      assert {:error, :invalid_name} = Webhooks.rename_webhook(webhook.id, "")
      assert {:error, :unknown_webhook} = Webhooks.rename_webhook(Cytale.Snowflake.next(), "X")

      assert :ok = Webhooks.delete_webhook(webhook.id)
      assert Webhooks.get_webhook(webhook.id) == nil
      assert Webhooks.list_webhooks(ch.channel_id) == []
      # Idempotent, and provenance survives for attribution (like bot revoke).
      assert :ok = Webhooks.delete_webhook(webhook.id)
      assert Principals.get(webhook.id).kind == :webhook
    end

    test "channel-delete cascade removes every webhook of the channel", %{ch: ch, owner: owner} do
      {:ok, a} = Webhooks.create_webhook(ch.channel_id, "A", owner.user_id)
      {:ok, b} = Webhooks.create_webhook(ch.channel_id, "B", owner.user_id)

      :ok = Workspaces.delete_channel(ch.channel_id)

      assert Webhooks.get_webhook(a.id) == nil
      assert Webhooks.get_webhook(b.id) == nil
      assert Webhooks.list_webhooks(ch.channel_id) == []
    end

    # B6g: the per-channel webhook budget — the 51st create is rejected
    # before any principal is minted.
    test "the 51st webhook in a channel is rejected (:webhook_cap)", %{ch: ch, owner: owner} do
      cap = Webhooks.channel_webhook_cap()

      for i <- 1..cap do
        assert {:ok, _} = Webhooks.create_webhook(ch.channel_id, "Hook #{i}", owner.user_id)
      end

      assert Enum.count(Webhooks.list_webhooks(ch.channel_id)) == cap
      assert {:error, :webhook_cap} = Webhooks.create_webhook(ch.channel_id, "Over Budget", owner.user_id)

      # The budget is per-CHANNEL (and per-owner: this owner's principal
      # budget is now full from the 50 mints) — a fresh owner on a fresh
      # channel mints freely.
      {:ok, other_owner} = User.create(run_unique("cap_owner2"), run_unique("cap2@example.com"), "password-123")
      {:ok, ws} = Workspaces.create_workspace(other_owner.user_id, run_unique("cap-ws"))
      {:ok, other_ch} = Workspaces.create_channel(ws.workspace_id, "fresh")
      assert {:ok, _} = Webhooks.create_webhook(other_ch.channel_id, "Elsewhere", other_owner.user_id)
    end
  end

  # ---------------------------------------------------------------------------
  # Resolve (the execute gate)
  # ---------------------------------------------------------------------------

  describe "resolve_by_url_token" do
    test "exact pair resolves; every miss is nil (no oracle legs)", %{ch: ch, owner: owner} do
      {:ok, webhook} = Webhooks.create_webhook(ch.channel_id, "Gate", owner.user_id)

      assert %{id: id} = Webhooks.resolve_by_url_token(webhook.id, webhook.token)
      assert id == webhook.id

      # Wrong token / unknown id / non-integer id.
      assert Webhooks.resolve_by_url_token(webhook.id, webhook.token <> "x") == nil
      assert Webhooks.resolve_by_url_token(Cytale.Snowflake.next(), webhook.token) == nil

      # Deleted webhook.
      :ok = Webhooks.delete_webhook(webhook.id)
      assert Webhooks.resolve_by_url_token(webhook.id, webhook.token) == nil
    end

    test "channel deleted → nil (channel existence is part of validity, KD8)", %{
      ch: ch,
      owner: owner
    } do
      {:ok, webhook} = Webhooks.create_webhook(ch.channel_id, "Gate", owner.user_id)
      :ok = Workspaces.delete_channel(ch.channel_id)
      assert Webhooks.resolve_by_url_token(webhook.id, webhook.token) == nil
    end
  end

  # ---------------------------------------------------------------------------
  # Execute semantics
  # ---------------------------------------------------------------------------

  describe "execute" do
    test "persists a message authored by the webhook principal + the override row", %{
      ch: ch,
      owner: owner
    } do
      {:ok, webhook} = Webhooks.create_webhook(ch.channel_id, "Exec", owner.user_id)

      assert {:ok, msg} =
               Webhooks.execute(webhook.id, webhook.token, %{
                 "content" => "hello",
                 "username" => "Dep Roy",
                 "avatar_url" => "https://cdn.example.com/a.png"
               })

      # `kind` stamps the message as a webhook's (Tier 3 B, 10b).
      override = %{"username" => "Dep Roy", "avatar_url" => "https://cdn.example.com/a.png", "kind" => "webhook"}

      assert msg.author_id == webhook.id
      assert msg.content == "hello"
      assert msg.author_override == override

      # The read path joins the override row back (the U10 embed join shape).
      assert Messages.get_message(ch.channel_id, msg.id).author_override == override
    end

    test "no override → no row, nil author_override on reads", %{ch: ch, owner: owner} do
      {:ok, webhook} = Webhooks.create_webhook(ch.channel_id, "Exec", owner.user_id)
      {:ok, msg} = Webhooks.execute(webhook.id, webhook.token, %{"content" => "plain"})
      assert msg.author_override == nil
      assert Messages.get_message(ch.channel_id, msg.id).author_override == nil
    end

    test "username-only and avatar-only overrides store partial rows", %{ch: ch, owner: owner} do
      {:ok, webhook} = Webhooks.create_webhook(ch.channel_id, "Exec", owner.user_id)

      {:ok, msg} =
        Webhooks.execute(webhook.id, webhook.token, %{"content" => "x", "username" => "Just A Name"})

      assert msg.author_override == %{"username" => "Just A Name", "kind" => "webhook"}

      {:ok, msg2} =
        Webhooks.execute(webhook.id, webhook.token, %{"content" => "y", "avatar_url" => "https://x/y.png"})

      assert msg2.author_override == %{"avatar_url" => "https://x/y.png", "kind" => "webhook"}
    end

    test "embed-only execute persists embeds verbatim; history join carries them", %{
      ch: ch,
      owner: owner
    } do
      {:ok, webhook} = Webhooks.create_webhook(ch.channel_id, "Exec", owner.user_id)
      embed = %{"title" => "Deploy OK", "unknown_future_key" => %{"rides" => ["untouched"]}}

      assert {:ok, msg} = Webhooks.execute(webhook.id, webhook.token, %{"embeds" => [embed]})
      assert msg.content == ""
      assert msg.embeds == [embed]
      assert Messages.get_message(ch.channel_id, msg.id).embeds == [embed]
    end

    test "validation: at least one of content/embeds; caps mirrored; components scoped (R6)",
         %{ch: ch, owner: owner} do
      {:ok, webhook} = Webhooks.create_webhook(ch.channel_id, "Exec", owner.user_id)
      exec = fn payload -> Webhooks.execute(webhook.id, webhook.token, payload) end

      assert {:error, :invalid_body} = exec.(%{})
      assert {:error, :invalid_body} = exec.(%{"tts" => true})
      assert {:error, :invalid_body} = exec.(%{"content" => ""})
      assert {:error, :invalid_body} = exec.(%{"content" => String.duplicate("x", 4_001)})
      assert {:error, :invalid_embeds} = exec.(%{"embeds" => [%{"t" => "x"} | List.duplicate(%{}, 10)]})
      assert {:error, :invalid_embeds} = exec.(%{"embeds" => [%{"description" => String.duplicate("x", 9_000)}]})
      assert {:error, :invalid_embeds} = exec.(%{"embeds" => "not-a-list"})
      assert {:error, :invalid_body} = exec.(%{"content" => "x", "username" => String.duplicate("u", 81)})
      assert {:error, :invalid_body} = exec.(%{"content" => "x", "avatar_url" => 42})

      # Components (components plan R6): a NON-list or a rule-breaking shape
      # fails full R1 validation → :invalid_components.
      assert {:error, :invalid_components} = exec.(%{"content" => "x", "components" => "not-a-list"})
      assert {:error, :invalid_components} = exec.(%{"content" => "x", "components" => [42]})

      # INTERACTIVE components are REJECTED on webhooks (dead surfaces — no
      # gateway session to receive clicks): custom button, select, and a
      # custom button mixed into a link row all bounce.
      assert {:error, :invalid_components} =
               exec.(%{
                 "content" => "x",
                 "components" => [
                   %{"type" => 1, "components" => [%{"type" => 2, "style" => 1, "label" => "B", "custom_id" => "b"}]}
                 ]
               })

      assert {:error, :invalid_components} =
               exec.(%{
                 "content" => "x",
                 "components" => [
                   %{
                     "type" => 1,
                     "components" => [
                       %{"type" => 3, "custom_id" => "pick", "options" => [%{"label" => "L", "value" => "v"}]}
                     ]
                   }
                 ]
               })

      assert {:error, :invalid_components} =
               exec.(%{
                 "content" => "x",
                 "components" => [
                   %{
                     "type" => 1,
                     "components" => [
                       %{"type" => 2, "style" => 5, "label" => "L", "url" => "https://x.y"},
                       %{"type" => 2, "style" => 1, "label" => "B", "custom_id" => "mixed"}
                     ]
                   }
                 ]
               })

      # Style-5-ONLY link rows are the scoped allowance: accepted AND stored
      # (client-side anchors need no interaction), riding reads verbatim.
      link_rows = [
        %{
          "type" => 1,
          "components" => [
            %{"type" => 2, "style" => 5, "label" => "Docs", "url" => "https://docs.example.com/x"}
          ]
        }
      ]

      assert {:ok, msg} = exec.(%{"content" => "links only", "components" => link_rows})
      assert msg.components == link_rows
      assert Messages.get_message(ch.channel_id, msg.id).components == link_rows

      # Unknown webhook.
      assert {:error, :unknown_webhook} =
               Webhooks.execute(Cytale.Snowflake.next(), "nope", %{"content" => "x"})
    end
  end

  # ---------------------------------------------------------------------------
  # Transformers (pure functions)
  # ---------------------------------------------------------------------------

  describe "Transformers.slack/1" do
    test "text → content; optional username rides; missing text is invalid" do
      assert {:ok, %{content: "hello", username: "Slack Bot", avatar_url: nil, embeds: []}} =
               Webhooks.Transformers.slack(%{"text" => "hello", "username" => "Slack Bot"})

      assert {:ok, %{username: nil}} = Webhooks.Transformers.slack(%{"text" => "hello"})
      assert {:error, :invalid_body} = Webhooks.Transformers.slack(%{})
      assert {:error, :invalid_body} = Webhooks.Transformers.slack(%{"text" => ""})
    end

    test "oversize text truncates inside the 4000-byte cap" do
      assert {:ok, %{content: content}} = Webhooks.Transformers.slack(%{"text" => String.duplicate("é", 3_000)})
      # 3000 é chars = 6000 bytes → truncated to ≤ 4000 on a codepoint edge.
      assert byte_size(content) <= 4_000
      assert byte_size(content) >= 4_000 - 4
      assert String.valid?(content)
    end
  end

  describe "Transformers.github/2" do
    test "push: content line + embed card with commits, pusher, compare url" do
      {:ok, payload} =
        Webhooks.Transformers.github(
          %{
            "ref" => "refs/heads/main",
            "compare" => "https://github.com/acme/app/c/abc",
            "pusher" => %{"name" => "jordan"},
            "repository" => %{"full_name" => "acme/app"},
            "commits" => [%{"id" => "c0ffee123", "message" => "fix: widget\n\nbody"}]
          },
          "push"
        )

      assert payload.content =~ "[acme/app] jordan pushed 1 commit to main: c0ffee1: fix: widget"

      assert [embed] = payload.embeds
      assert embed["title"] == "[acme/app] 1 new commit to main"
      assert embed["url"] == "https://github.com/acme/app/c/abc"
      assert embed["description"] == "- c0ffee1: fix: widget"
      assert embed["fields"] == [%{"name" => "Pusher", "value" => "jordan"}]
    end

    test "pull_request and issues render action cards" do
      {:ok, pr} =
        Webhooks.Transformers.github(
          %{
            "action" => "opened",
            "repository" => %{"full_name" => "acme/app"},
            "pull_request" => %{
              "number" => 12,
              "title" => "Add widgets",
              "body" => "does things",
              "html_url" => "https://github.com/acme/app/pull/12",
              "user" => %{"login" => "jordan"}
            }
          },
          "pull_request"
        )

      assert pr.content == "[acme/app] pull request #12 opened: Add widgets (by jordan)"
      assert [embed] = pr.embeds
      assert embed["title"] == "PR #12 opened: Add widgets"
      assert embed["url"] == "https://github.com/acme/app/pull/12"
      assert embed["description"] == "does things"

      {:ok, issue} =
        Webhooks.Transformers.github(
          %{
            "action" => "closed",
            "repository" => %{"full_name" => "acme/app"},
            "issue" => %{
              "number" => 3,
              "title" => "Broken",
              "html_url" => "https://github.com/acme/app/issues/3",
              "user" => %{"login" => "ada"}
            }
          },
          "issues"
        )

      assert issue.content == "[acme/app] issue #3 closed: Broken (by ada)"
      assert [%{"title" => "Issue #3 closed: Broken"}] = issue.embeds
    end

    test "uncovered events get the generic line; hostile payloads degrade safely" do
      assert {:ok, %{content: "GitHub release event received", embeds: []}} =
               Webhooks.Transformers.github(%{}, "release")

      assert {:ok, %{content: "GitHub unlabeled event received"}} =
               Webhooks.Transformers.github(%{}, nil)

      # Odd shapes: placeholders, never errors, never oversized output.
      assert {:ok, push} = Webhooks.Transformers.github(%{"commits" => "nope"}, "push")
      assert push.content =~ "pushed 0 commits"
      assert push.content =~ "unknown repository"

      assert {:ok, huge} =
               Webhooks.Transformers.github(
                 %{
                   "repository" => %{"full_name" => "acme/app"},
                   "commits" => [%{"id" => String.duplicate("a", 500), "message" => String.duplicate("m", 10_000)}]
                 },
                 "push"
               )

      assert byte_size(huge.content) <= 4_000
      assert [embed] = huge.embeds
      assert byte_size(Jason.encode!(embed)) <= 8 * 1024
    end

    # B6e: TOTAL guards — hostile JSON (nested objects/arrays/numbers where
    # strings belong) must never raise, for ANY covered event builder.
    # Property-style: seeded random shapes at every field the builders touch.
    test "hostile random shapes never raise and always produce a valid payload" do
      :rand.seed(:exsss, {2026, 9, 4})

      hostiles = [
        nil,
        42,
        [],
        %{},
        %{"nested" => %{"deep" => [%{"deeper" => [%{}]}]}},
        String.duplicate("x", 5_000)
      ]

      field_paths = [
        ["pusher", "name"],
        ["repository", "full_name"],
        ["commits"],
        ["compare"],
        ["ref"],
        ["action"],
        ["number"],
        ["title"],
        ["body"],
        ["html_url"],
        ["user", "login"],
        ["id"],
        ["sha"],
        ["message"]
      ]

      events = ["push", "pull_request", "issues", "status", nil]

      for _ <- 1..400,
          event <- events do
        body =
          Enum.reduce(field_paths, %{}, fn path, acc ->
            deep_put(acc, path, Enum.random(hostiles))
          end)

        assert {:ok, payload} = Webhooks.Transformers.github(body, event)

        assert is_binary(payload.content) and payload.content != ""
        assert payload.username == nil and payload.avatar_url == nil
        assert is_list(payload.embeds)
        assert byte_size(payload.content) <= 4_000

        for embed <- payload.embeds do
          assert is_map(embed)
          assert is_binary(embed["title"])
          assert embed["url"] == nil or is_binary(embed["url"])
          assert byte_size(Jason.encode!(embed)) <= 8 * 1024
        end
      end
    end

    # Nested put that self-heals missing intermediates (put_in on a nil
    # intermediate raises — the property body must tolerate any path).
    defp deep_put(acc, [key], value), do: Map.put(acc, key, value)

    defp deep_put(acc, [key | rest], value) do
      Map.put(acc, key, deep_put(Map.get(acc, key) || %{}, rest, value))
    end

    test "specifically lethal shapes (objects where strings belong) degrade to placeholders" do
      lethal = %{
        "action" => %{"injected" => true},
        "number" => [1, 2, %{}],
        "title" => %{"x" => [%{"y" => []}]},
        "body" => [%{"deep" => {1, 2}}],
        "html_url" => %{"no" => "url"},
        "user" => %{"login" => [%{"not" => "a string"}]},
        "repository" => %{"full_name" => %{}},
        "pusher" => %{"name" => [%{"nope" => [1]}]},
        "commits" => [%{"id" => %{}, "message" => %{"x" => 1}}, %{"sha" => []}, "junk", 7],
        "compare" => [:not, :a, :url]
      }

      for event <- ["push", "pull_request", "issues"] do
        assert {:ok, payload} = Webhooks.Transformers.github(lethal, event)
        assert is_binary(payload.content)
        assert payload.content =~ "unknown repository"

        for embed <- payload.embeds do
          assert is_binary(embed["title"])
          assert embed["url"] == nil
        end
      end
    end
  end
end
