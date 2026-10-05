defmodule Cytale.Messages.MessageTest do
  @moduledoc """
  U11 — message hot path (persist → fan-out orchestration layer). Data-layer
  mechanics are covered by repo_test; this module asserts the orchestration:
  wire shaping, THREAD_MESSAGE_CREATE routing for thread replies, and that
  the publish rides the configured seam.
  """

  use Cytale.ScyllaCase, async: false

  import ExUnit.CaptureLog

  alias Cytale.Messages
  alias Cytale.Messages.Message

  setup do
    # Capture publishes through the Log impl (hermetic default) — the
    # workspace-process path is exercised in workspace_test.
    original = Application.get_env(:cytale, Cytale.Publish)
    Application.put_env(:cytale, Cytale.Publish, Cytale.Publish.Log)

    test_pid = self()

    on_exit(fn ->
      if original == nil do
        Application.delete_env(:cytale, Cytale.Publish)
      else
        Application.put_env(:cytale, Cytale.Publish, original)
      end
    end)

    {:ok, test_pid: test_pid}
  end

  defp ch_id, do: Cytale.Snowflake.next()

  test "send_message persists and returns the wire shape (string ids, ISO times)" do
    channel = ch_id()
    author = Cytale.Snowflake.next()

    assert {:ok, wire} =
             Message.send_message(%{
               channel_id: channel,
               author_id: author,
               content: "wire shape probe",
               thread_id: nil
             })

    assert wire["channel_id"] == Integer.to_string(channel)
    assert wire["author_id"] == Integer.to_string(author)
    assert wire["content"] == "wire shape probe"
    assert wire["thread_id"] == nil
    assert is_binary(wire["id"]) and String.length(wire["id"]) > 0
    assert Regex.match?(~r/^\d{4}-\d{2}-\d{2}T/, wire["created_at"])
    assert wire["edited_at"] == nil

    # Durable in ScyllaDB.
    assert [%{id: id, content: "wire shape probe"}] = Messages.history(channel, limit: 1)
    assert Integer.to_string(id) == wire["id"]
  end

  test "channel message emits MESSAGE_CREATE through the seam; thread reply emits THREAD_MESSAGE_CREATE" do
    channel = ch_id()

    log =
      capture_log(fn ->
        assert {:ok, _} =
                 Message.send_message(%{
                   channel_id: channel,
                   author_id: Cytale.Snowflake.next(),
                   content: "channel level",
                   thread_id: nil
                 })
      end)

    assert log =~ "event=MessageCreate"

    thread_id = Cytale.Snowflake.next()
    thread_author = Cytale.Snowflake.next()

    log2 =
      capture_log(fn ->
        assert {:ok, wire} =
                 Message.send_message(%{
                   channel_id: channel,
                   author_id: thread_author,
                   content: "thread reply",
                   thread_id: thread_id
                 })

        assert wire["thread_id"] == Integer.to_string(thread_id)

        # A7: the THREAD wire carries author_id as a decimal STRING like
        # every other id (events.md pins strings; reconcile compares
        # strictly) — the echo and the dual fan-out share to_wire.
        assert wire["author_id"] == Integer.to_string(thread_author)
      end)

    assert log2 =~ "event=ThreadMessageCreate"
    # …and the fan-out payload carries the same string author_id.
    assert log2 =~ "\"author_id\" => \"#{Integer.to_string(thread_author)}\""
  end

  test "publish failures do not lose the persisted message (persistence first)" do
    channel = ch_id()

    # Publish through a broken impl: persistence must still succeed and the
    # error must not crash the caller beyond the returned state.
    original = Application.get_env(:cytale, Cytale.Publish)

    Application.put_env(:cytale, Cytale.Publish, BrokenPublisher)

    try do
      # BrokenPublisher raises inside publish; send_message's pipeline calls it
      # after persistence. The data layer has no transaction over both stores,
      # so the persisted row is the source of truth (clients full-sync).
      result =
        try do
          Message.send_message(%{
            channel_id: channel,
            author_id: Cytale.Snowflake.next(),
            content: "persist survives fanout failure",
            thread_id: nil
          })
        rescue
          _ -> :publish_raised
        end

      # Either way the row landed.
      assert [%{content: "persist survives fanout failure"}] =
               Messages.history(channel, limit: 1)

      assert result == :publish_raised or match?({:ok, _}, result)
    after
      if original == nil do
        Application.delete_env(:cytale, Cytale.Publish)
      else
        Application.put_env(:cytale, Cytale.Publish, original)
      end
    end
  end

  # ---------------------------------------------------------------------------
  # Embeds (bots plan U10, KTD11: stored, not stripped)
  # ---------------------------------------------------------------------------

  describe "embed storage (U10 payload richness)" do
    test "create with embeds → get/history return decoded embeds, order preserved" do
      channel = ch_id()
      author = Cytale.Snowflake.next()

      e1 = %{
        "title" => "Deploy OK",
        "description" => "prod is green",
        "fields" => [%{"name" => "commit", "value" => "abc123", "inline" => true}]
      }

      e2 = %{"title" => "Second", "color" => 4_437_377}

      assert {:ok, msg} =
               Messages.create_message(%{
                 channel_id: channel,
                 author_id: author,
                 content: "with embeds",
                 thread_id: nil,
                 embeds: [e1, e2]
               })

      assert msg.embeds == [e1, e2]

      assert %{} = got = Messages.get_message(channel, msg.id)
      assert got.embeds == [e1, e2]

      assert [%{embeds: [^e1, ^e2]}] = Messages.history(channel, limit: 1)
    end

    test "create without embeds → reads carry [] (never nil)" do
      channel = ch_id()

      assert {:ok, msg} =
               Messages.create_message(%{
                 channel_id: channel,
                 author_id: Cytale.Snowflake.next(),
                 content: "plain",
                 thread_id: nil
               })

      assert msg.embeds == []
      assert Messages.get_message(channel, msg.id).embeds == []
      assert [%{embeds: []}] = Messages.history(channel, limit: 1)
    end

    test "embeds with arbitrary nested keys round-trip (Jason decode equality)" do
      channel = ch_id()

      weird = %{
        "title" => "github",
        "footer" => %{"text" => "f", "unknown_key" => [1, 2, %{"deep" => true}]},
        "video" => %{"url" => "https://example.com/v", "width" => 1_920}
      }

      assert {:ok, msg} =
               Messages.create_message(%{
                 channel_id: channel,
                 author_id: Cytale.Snowflake.next(),
                 content: "weird embed",
                 thread_id: nil,
                 embeds: [weird]
               })

      got = Messages.get_message(channel, msg.id)
      assert got.embeds == [weird]
      # Jason decode equality (byte-equal serialization semantics).
      assert Jason.decode!(Jason.encode!(got.embeds)) == [weird]
    end

    test "validate_embeds/1 pins the R11 caps" do
      assert :ok = Messages.validate_embeds(nil)
      assert :ok = Messages.validate_embeds([])
      assert :ok = Messages.validate_embeds([%{"title" => "ok"}])
      assert :ok = Messages.validate_embeds(Enum.map(1..10, &%{"title" => "e#{&1}"}))

      assert {:error, :invalid_embeds} = Messages.validate_embeds("nope")
      assert {:error, :invalid_embeds} = Messages.validate_embeds([42])
      assert {:error, :invalid_embeds} = Messages.validate_embeds([%{"title" => "ok"}, "junk"])
      # 11th embed.
      assert {:error, :invalid_embeds} = Messages.validate_embeds(Enum.map(1..11, &%{"title" => "e#{&1}"}))
      # 9 KB embed (cap: 8 KB serialized).
      assert {:error, :invalid_embeds} = Messages.validate_embeds([%{"description" => String.duplicate("x", 9_000)}])
    end

    test "delete cascades message_embeds rows (no orphans)" do
      channel = ch_id()

      assert {:ok, msg} =
               Messages.create_message(%{
                 channel_id: channel,
                 author_id: Cytale.Snowflake.next(),
                 content: "doomed",
                 thread_id: nil,
                 embeds: [%{"title" => "gone soon"}, %{"title" => "also gone"}]
               })

      assert embed_rows(msg.id) |> length() == 2

      :ok = Messages.delete_message(channel, msg.id)

      assert embed_rows(msg.id) == []
    end

    # B7c: the U11 override side table cascades on delete exactly like
    # message_embeds (mirrors the embeds no-orphans pin). The row is written
    # by the real webhook execute path (username override).
    test "delete cascades message_author_overrides rows (no orphans)" do
      nonce = System.unique_integer([:positive])

      {:ok, owner} =
        Cytale.Accounts.User.create("cascade_owner#{nonce}", "cascade#{nonce}@example.com", "password-123")

      # The channel row must exist for webhook validity (KD8).
      {:ok, ws} = Cytale.Workspaces.create_workspace(owner.user_id, "cascade-ws-#{nonce}")
      {:ok, ch} = Cytale.Workspaces.create_channel(ws.workspace_id, "overrides")
      channel = ch.channel_id

      {:ok, webhook} = Cytale.Webhooks.create_webhook(channel, "Cascade Hook", owner.user_id)

      assert {:ok, msg} =
               Cytale.Webhooks.execute(webhook.id, webhook.token, %{
                 "content" => "doomed override",
                 "username" => "Ghost Name"
               })

      assert override_rows(msg.id) |> length() == 1
      assert msg.author_override == %{"username" => "Ghost Name", "kind" => "webhook"}

      :ok = Messages.delete_message(channel, msg.id)

      assert override_rows(msg.id) == []
    end
  end

  # ---------------------------------------------------------------------------
  # Components (components plan U1, R1: stored beside embeds, read joins,
  # delete cascade — the embeds twin)
  # ---------------------------------------------------------------------------

  describe "component storage (components plan U1)" do
    defp button(id, style \\ 1), do: %{"type" => 2, "style" => style, "label" => "B#{id}", "custom_id" => id}

    defp link_button(url \\ "https://example.com/docs"),
      do: %{"type" => 2, "style" => 5, "label" => "Open", "url" => url}

    defp select(id \\ "pick") do
      %{
        "type" => 3,
        "custom_id" => id,
        "options" => [
          %{"label" => "One", "value" => "one"},
          %{"label" => "Two", "value" => "two", "description" => "the second", "default" => true}
        ]
      }
    end

    defp row(children), do: %{"type" => 1, "components" => children}

    # Map update for keys the base builders may not carry.
    defp merge(component, overrides), do: Map.merge(component, overrides)

    test "validate_components/1 accepts the anchors (caps boundaries are valid)" do
      assert :ok = Messages.validate_components(nil)
      assert :ok = Messages.validate_components([])

      # 2 rows: 3 buttons + 1 select — the happy wire.
      assert :ok = Messages.validate_components([row([button("a"), button("b"), button("c")]), row([select()])])

      # 5 rows exactly, 5 buttons in a row exactly, 25 options exactly.
      assert :ok =
               Messages.validate_components(Enum.map(1..5, fn i -> row([button("b#{i}")]) end))

      assert :ok = Messages.validate_components([row(Enum.map(1..5, &button("x#{&1}")))])

      full_options = Enum.map(1..25, &%{"label" => "o#{&1}", "value" => "v#{&1}"})
      assert :ok = Messages.validate_components([row([%{select() | "options" => full_options}])])

      # Style-5 link: valid https url, NO custom_id.
      assert :ok = Messages.validate_components([row([link_button()])])
      assert :ok = Messages.validate_components([row([link_button("http://cytale.local/x")])])

      # disabled rides buttons AND selects (the resolved-card state).
      assert :ok = Messages.validate_components([row([merge(button("d"), %{"disabled" => true})])])

      assert :ok =
               Messages.validate_components([
                 row([
                   merge(select(), %{
                     "disabled" => true,
                     "placeholder" => "pick one",
                     "min_values" => 0,
                     "max_values" => 1
                   })
                 ])
               ])

      # Multi-select (#30): the full range, bounded by the option count.
      assert :ok = Messages.validate_components([row([merge(select(), %{"max_values" => 2})])])
      assert :ok = Messages.validate_components([row([merge(select(), %{"min_values" => 2, "max_values" => 2})])])
      assert :ok = Messages.validate_components([row([merge(select(), %{"min_values" => 0, "max_values" => 2})])])

      # Unknown keys ride verbatim (the embeds posture — shallow caps only).
      assert :ok =
               Messages.validate_components([
                 %{"type" => 1, "components" => [button("u")], "future_key" => %{"rides" => [true]}}
               ])

      assert :ok = Messages.validate_components([row([merge(button("e"), %{"emoji" => %{"name" => "🔥"}})])])
    end

    test "validate_components/1 pins the R1 cap matrix (each → {:error, :invalid_components})" do
      bad = [
        # containers
        "nope",
        [42],
        [%{"type" => 1, "components" => [%{"type" => 2, "style" => 1, "custom_id" => "x"}]}, "junk"],
        # rows
        [row([])],
        [%{"components" => [button("a")]}],
        [%{"type" => 2, "style" => 1, "custom_id" => "top-level"}],
        [%{"type" => 1, "components" => "not-a-list"}],
        Enum.map(1..6, fn i -> row([button("r#{i}")]) end),
        # row composition
        row(Enum.map(1..6, &button("b#{&1}"))) |> List.wrap(),
        [row([button("mix"), select()])],
        [row([select(), select()])],
        [row([%{"type" => 4, "custom_id" => "future-type"}])],
        # custom_id
        [row([%{button("x") | "custom_id" => String.duplicate("c", 101)}])],
        [row([%{button("x") | "custom_id" => ""}])],
        [row([Map.delete(button("x"), "custom_id")])],
        # style lattice
        [row([%{"type" => 2, "style" => 6, "label" => "Premium", "custom_id" => "p"}])],
        [row([%{"type" => 2, "style" => 5, "label" => "L", "url" => "https://x.y", "custom_id" => "nope"}])],
        [row([%{"type" => 2, "style" => 5, "label" => "L", "url" => nil}])],
        [row([%{"type" => 2, "style" => 5, "label" => "L"}])],
        # url scheme gates (style 5)
        [row([link_button("javascript:alert(1)")])],
        [row([link_button("data:text/html;base64,PHNjcmlwdD4=")])],
        [row([link_button("//evil.com/phish")])],
        [row([link_button("ftp://files.example.com/x")])],
        # url FORBIDDEN on styles 1-4
        [row([merge(button("u"), %{"url" => "https://example.com"})])],
        [row([merge(button("u"), %{"url" => nil})])],
        # label caps / shapes
        [row([%{button("x") | "label" => String.duplicate("l", 81)}])],
        [row([%{button("x") | "label" => 42}])],
        [row([merge(button("x"), %{"disabled" => "yes"})])],
        # selects
        [row([Map.delete(select(), "custom_id")])],
        [row([merge(select(), %{"placeholder" => String.duplicate("p", 151)})])],
        # multi-select range (#30): max beyond the option count, beyond 25,
        # and a min above the DEFAULT max of 1.
        [row([merge(select(), %{"max_values" => 3})])],
        [row([merge(select(), %{"max_values" => 26})])],
        [row([merge(select(), %{"min_values" => 2})])],
        [row([merge(select(), %{"min_values" => 1, "max_values" => 0})])],
        [row([merge(select(), %{"max_values" => "1"})])],
        [row([%{select() | "options" => []}])],
        [row([%{select() | "options" => Enum.map(1..26, &%{"label" => "o#{&1}", "value" => "v#{&1}"})}])],
        [row([%{select() | "options" => [%{"label" => "L", "value" => "v"}, "junk"]}])],
        [row([%{select() | "options" => [%{"value" => "v"}]}])],
        [row([%{select() | "options" => [%{"label" => "L"}]}])],
        [row([%{select() | "options" => [%{"label" => String.duplicate("l", 101), "value" => "v"}]}])],
        [row([%{select() | "options" => [%{"label" => "L", "value" => String.duplicate("v", 101)}]}])],
        [
          row([
            %{select() | "options" => [%{"label" => "L", "value" => "v", "description" => String.duplicate("d", 101)}]}
          ])
        ],
        [row([%{select() | "options" => [%{"label" => "L", "value" => "v", "default" => "true"}]}])]
      ]

      for payload <- bad do
        assert {:error, :invalid_components} = Messages.validate_components(payload),
               "expected invalid_components for: #{inspect(payload, limit: :infinity)}"
      end
    end

    test "8 KB budget boundary: total serialized components cap" do
      # A single button whose unknown-key padding pushes the serialized row
      # past 8 KB (row/button caps pass; the TOTAL budget rejects). Unknown
      # keys ride verbatim, so the padding is a legal wire shape.
      over = [row([merge(button("z"), %{"pad" => String.duplicate("p", 8_200)})])]
      assert byte_size(Jason.encode!(over)) > 8 * 1024
      assert {:error, :invalid_components} = Messages.validate_components(over)

      under = [row([merge(button("z"), %{"pad" => String.duplicate("p", 7_000)})])]
      assert byte_size(Jason.encode!(under)) < 8 * 1024
      assert :ok = Messages.validate_components(under)
    end

    test "create with components → get/history return decoded rows, order + idx clustering preserved" do
      channel = ch_id()

      rows = [
        row([button("approve"), button("deny"), link_button()]),
        row([select()])
      ]

      assert {:ok, msg} =
               Messages.create_message(%{
                 channel_id: channel,
                 author_id: Cytale.Snowflake.next(),
                 content: "with components",
                 thread_id: nil,
                 components: rows
               })

      assert msg.components == rows

      assert %{} = got = Messages.get_message(channel, msg.id)
      assert got.components == rows
      # Jason decode equality (verbatim round-trip).
      assert Jason.decode!(Jason.encode!(got.components)) == rows

      assert [%{components: ^rows}] = Messages.history(channel, limit: 1)

      # Raw side table: idx clustering carries wire order (0, 1).
      assert [%{"idx" => 0}, %{"idx" => 1}] = component_rows(msg.id)
    end

    test "create without components → reads carry [] (never nil)" do
      channel = ch_id()

      assert {:ok, msg} =
               Messages.create_message(%{
                 channel_id: channel,
                 author_id: Cytale.Snowflake.next(),
                 content: "plain",
                 thread_id: nil
               })

      assert msg.components == []
      assert Messages.get_message(channel, msg.id).components == []
      assert [%{components: []}] = Messages.history(channel, limit: 1)
      assert component_rows(msg.id) == []
    end

    test "components with arbitrary nested keys round-trip (Jason decode equality)" do
      channel = ch_id()

      weird = row([merge(button("w"), %{"future_nested" => %{"deep" => [1, 2, %{"x" => true}]}})])

      assert {:ok, msg} =
               Messages.create_message(%{
                 channel_id: channel,
                 author_id: Cytale.Snowflake.next(),
                 content: "weird components",
                 thread_id: nil,
                 components: [weird]
               })

      got = Messages.get_message(channel, msg.id)
      assert got.components == [weird]
      assert Jason.decode!(Jason.encode!(got.components)) == [weird]
    end

    test "delete cascades message_components rows (raw table read proves empty)" do
      channel = ch_id()

      assert {:ok, msg} =
               Messages.create_message(%{
                 channel_id: channel,
                 author_id: Cytale.Snowflake.next(),
                 content: "doomed buttons",
                 thread_id: nil,
                 components: [row([button("a"), button("b")]), row([select()])]
               })

      assert component_rows(msg.id) |> length() == 2

      :ok = Messages.delete_message(channel, msg.id)

      assert component_rows(msg.id) == []
    end
  end

  # ---------------------------------------------------------------------------
  # Wholesale replace (components plan U3, R5/KTD4)
  # ---------------------------------------------------------------------------

  describe "component replace (components plan U3)" do
    # button/2 + row/1 are module-level defs from the U1 describe above.

    defp card!(components) do
      {:ok, msg} =
        Messages.create_message(%{
          channel_id: ch_id(),
          author_id: Cytale.Snowflake.next(),
          content: "card",
          thread_id: nil,
          components: components
        })

      msg
    end

    test "replace_components rewrites the side rows wholesale (verbatim JSON, order preserved)" do
      msg = card!([row([button("approve")]), row([button("other")])])

      replacement = [row([Map.put(button("approve"), "disabled", true)])]

      assert :ok = Messages.replace_components(msg.channel_id, msg.id, replacement)

      updated = Messages.get_message(msg.channel_id, msg.id)
      assert updated.components == replacement
      # Exactly one side row survives (the wholesale delete ran).
      assert component_rows(msg.id) |> length() == 1
    end

    test "replace with [] clears every row (the card-less resolved state)" do
      msg = card!([row([button("approve")]), row([button("deny")])])

      assert :ok = Messages.replace_components(msg.channel_id, msg.id, [])

      assert Messages.get_message(msg.channel_id, msg.id).components == []
      assert component_rows(msg.id) == []
    end

    # The KTD4 LWW construction: every write of one replace carries ONE
    # per-operation USING TIMESTAMP — a newer SMALLER replace must fully
    # bury a LARGER older one (without it, the older op's extra idx rows
    # would survive the delete and the state would be a MIX).
    test "two sequential replaces: the newer list survives EXACTLY (smaller beating larger — the LWW pin)" do
      msg = card!([row([button("a1")])])

      larger = Enum.map(1..5, &row([button("l#{&1}")]))
      assert :ok = Messages.replace_components(msg.channel_id, msg.id, larger)
      assert Messages.get_message(msg.channel_id, msg.id).components == larger

      smaller = [row([Map.put(button("s1"), "disabled", true)])]
      assert :ok = Messages.replace_components(msg.channel_id, msg.id, smaller)

      assert Messages.get_message(msg.channel_id, msg.id).components == smaller
      assert component_rows(msg.id) |> length() == 1
    end

    # The requirement the LWW construction RESTS ON, made explicit: the
    # per-operation stamps must be DISTINCT. Written with raw CQL because the
    # production path can no longer produce the collision (that is the fix in
    # `Cytale.StrictClock`) — this pins WHY the clock has to be strict, so a
    # future "system_time is monotonic enough" edit meets a failing test instead
    # of an argument.
    test "the same operation stamp on two replaces MERGES both lists (the hazard the strict clock removes)" do
      msg = card!([row([button("a")])])
      ts = Cytale.StrictClock.now_us()

      # One operation = ONE tombstone then its inserts, all at `ts + 1` — the
      # margin that makes one operation atomic.
      apply_op = fn values ->
        cut_side_rows(msg.id, ts)
        Enum.each(values, fn {idx, kind} -> insert_side_row(msg.id, idx, kind, ts + 1) end)
      end

      # The shape the controller's concurrent-click test produced: the newer
      # operation is SHORTER than the older one.
      apply_op.([{0, "a0"}, {1, "a1"}, {2, "a2"}])
      apply_op.([{0, "b0"}])

      survivors = component_values(msg.id) |> Enum.sort()

      # A MERGE, not an outcome: idx 0 resolves between the two (equal key, equal
      # stamp), while the older operation's idx 1 and 2 outlive the newer
      # operation's tombstone and stay. No single operation produced this list.
      assert length(survivors) == 3
      assert "a1" in survivors and "a2" in survivors
      assert Enum.any?(survivors, &(&1 in ["a0", "b0"]))

      # The control, same construction one microsecond later: distinct stamps
      # mean the newer operation buries the older one completely.
      cut_side_rows(msg.id, ts + 1)
      insert_side_row(msg.id, 0, "c0", ts + 2)
      cut_side_rows(msg.id, ts + 2)
      insert_side_row(msg.id, 0, "d0", ts + 3)

      assert component_values(msg.id) == ["d0"]
    end

    # The integration property the controller asserts under load, at the data
    # layer and on a loop: whichever operation wins, the survivors are exactly one
    # operation's list — never a merge. A barrier releases both writers together,
    # which is the widest window the (now distinct) stamps have to save.
    test "racing replaces never merge: the survivor set is always exactly one list" do
      msg = card!([row([button("keep")])])

      lists = for n <- 1..8, do: Enum.map(1..n, fn i -> row([button("r#{n}-#{i}")]) end)
      parent = self()

      for [a, b] <- Enum.chunk_every(lists, 2, 1, :discard) do
        tasks =
          for list <- [a, b] do
            Task.async(fn ->
              send(parent, {:ready, self()})

              receive do
                :go -> :ok
              end

              Messages.replace_components(msg.channel_id, msg.id, list)
            end)
          end

        for _ <- 1..2 do
          receive do
            {:ready, pid} -> send(pid, :go)
          after
            5_000 -> flunk("a writer never reached the barrier")
          end
        end

        Task.await_many(tasks, 30_000)

        survivors = Messages.get_message(msg.channel_id, msg.id).components

        assert survivors == a or survivors == b,
               "the two replaces merged: #{inspect(survivors)}"
      end
    end

    test "replace_embeds is the twin (embed side rows rewrite wholesale)" do
      msg = card!([row([button("approve")])])

      embeds = [%{"title" => "Audit trail", "description" => "approved by member"}]
      assert :ok = Messages.replace_embeds(msg.channel_id, msg.id, embeds)

      updated = Messages.get_message(msg.channel_id, msg.id)
      assert updated.embeds == embeds
      assert embed_rows(msg.id) |> length() == 1

      # Components are untouched by the embeds replace (independent twins).
      assert updated.components == [row([button("approve")])]
    end
  end

  # Raw CQL stamping: the only way left to produce two operations with the SAME
  # `USING TIMESTAMP`, which is the collision `Cytale.StrictClock` prevents.
  defp cut_side_rows(message_id, ts) do
    Cytale.Repo.execute!(
      "DELETE FROM #{Cytale.Repo.keyspace()}.message_components USING TIMESTAMP ? WHERE message_id = ?",
      [{"bigint", ts}, {"bigint", message_id}]
    )
  end

  defp insert_side_row(message_id, idx, value, ts) do
    Cytale.Repo.execute!(
      "INSERT INTO #{Cytale.Repo.keyspace()}.message_components (message_id, idx, component) VALUES (?, ?, ?) USING TIMESTAMP ?",
      [{"bigint", message_id}, {"int", idx}, {"text", Jason.encode!(%{"kind" => value})}, {"bigint", ts}]
    )
  end

  defp component_values(message_id) do
    component_rows(message_id)
    |> Enum.map(&Jason.decode!(&1["component"])["kind"])
  end

  # Raw side-table read — the cascade pin asserts table state, not projections.
  defp embed_rows(message_id) do
    Cytale.Repo.execute!(
      "SELECT message_id, idx, embed FROM #{Cytale.Repo.keyspace()}.message_embeds WHERE message_id = ?",
      [{"bigint", message_id}]
    )
    |> Enum.to_list()
  end

  # Raw side-table read — the cascade pin asserts table state, not projections.
  defp component_rows(message_id) do
    Cytale.Repo.execute!(
      "SELECT message_id, idx, component FROM #{Cytale.Repo.keyspace()}.message_components WHERE message_id = ?",
      [{"bigint", message_id}]
    )
    |> Enum.to_list()
  end

  # Raw side-table read — the cascade pin asserts table state, not projections.
  defp override_rows(message_id) do
    Cytale.Repo.execute!(
      "SELECT message_id, override_username, override_avatar_url FROM #{Cytale.Repo.keyspace()}.message_author_overrides WHERE message_id = ?",
      [{"bigint", message_id}]
    )
    |> Enum.to_list()
  end

  # -- hardening plan 5.6: one batch per write fan ------------------------------

  describe "message writes are one round trip per fan (plan 5.6)" do
    test "a create's round trips do not grow with its embeds/components" do
      channel = ch_id()
      author = Cytale.Snowflake.next()

      {bare_stmts, {:ok, _}} =
        capture_statements(fn ->
          Messages.create_message(%{channel_id: channel, author_id: author, content: "bare"})
        end)

      rich =
        for i <- 1..5 do
          %{"type" => 1, "components" => [%{"type" => 2, "style" => 1, "label" => "b#{i}", "custom_id" => "c#{i}"}]}
        end

      {one_stmts, {:ok, _}} =
        capture_statements(fn ->
          Messages.create_message(%{channel_id: channel, author_id: author, content: "one", components: [hd(rich)]})
        end)

      {rich_stmts, {:ok, _}} =
        capture_statements(fn ->
          Messages.create_message(%{
            channel_id: channel,
            author_id: author,
            content: "rich",
            embeds: [%{"title" => "embed"}],
            components: rich
          })
        end)

      # The gate, as an INVARIANCE: five components and an embed cost no more
      # statements than one component does. Before the batch this grew by one
      # per row per side table (2 + N + M round trips for one user action).
      # Side rows DO cost one extra batch over a bare message: they are stamped
      # from Cytale.StrictClock (the clock a replace uses — see create_message),
      # and a batch carries one timestamp.
      assert length(rich_stmts) == length(one_stmts),
             "the write fan scaled with rows: #{length(one_stmts)} → #{length(rich_stmts)}"

      assert length(rich_stmts) == length(bare_stmts) + 1

      # And the batch really carries the side rows, so the count is flat because
      # they travel TOGETHER rather than because they were dropped.
      batch = Enum.find(rich_stmts, &String.contains?(&1, "message_components"))
      assert batch, "no statement mentioned the component side rows"
      assert String.contains?(batch, "message_embeds")
    end

    test "the delete cascade is batched (one frame per CQL batch family), and removes every side row" do
      channel = ch_id()
      author = Cytale.Snowflake.next()

      {:ok, msg} =
        Messages.create_message(%{
          channel_id: channel,
          author_id: author,
          content: "cascade me",
          embeds: [%{"title" => "e"}],
          components: [%{"type" => 1, "components" => []}]
        })

      :ok = Cytale.Messages.Reactions.add(channel, msg.id, author, "👍")

      {stmts, :ok} = capture_statements(fn -> Messages.delete_message(channel, msg.id) end)

      # EXACTLY THREE delete frames for the whole cascade, not six statements —
      # a count that no longer depends on what the message carried. Each split
      # is forced, not a regression:
      #   * CQL refuses to mix counter and non-counter mutations in one batch
      #     ("Counter and non-counter mutations cannot exist in the same
      #     batch"), and `reaction_counts` became a real counter in hardening
      #     plan 4.3 — the suite caught exactly that when the tally changed;
      #   * the embed/component side rows are tombstoned on Cytale.StrictClock,
      #     the clock a replace writes them with, and a batch carries ONE
      #     timestamp (see delete_message).
      # The DM lookup beside the cascade is a read, so counting DELETE frames
      # is what pins the batching.
      deletes = Enum.filter(stmts, &String.contains?(&1, "DELETE"))

      assert length(deletes) == 3, "the cascade was not batched: #{inspect(deletes)}"

      counter_frame = Enum.find(deletes, &String.contains?(&1, "reaction_counts"))
      assert counter_frame, "reaction_counts is missing from the cascade"

      side_frame = Enum.find(deletes, &String.contains?(&1, "message_components"))
      assert side_frame && String.contains?(side_frame, "message_embeds")

      [main_frame] = Enum.reject(deletes, &(&1 in [counter_frame, side_frame]))

      for table <- ~w(messages message_author_overrides reactions_by_message) do
        assert String.contains?(main_frame, table), "#{table} is missing from the cascade batch"
      end

      for frame <- [main_frame, side_frame] do
        refute String.contains?(frame, "reaction_counts"),
               "the counter-table delete shares a batch with non-counter mutations — Scylla rejects the frame"
      end

      # The rows really are gone (a batch is a round-trip win, so this is the
      # correctness half).
      assert Messages.get_message(channel, msg.id) == nil
      assert component_rows(msg.id) == []
      assert embed_rows(msg.id) == []
      assert Cytale.Messages.Reactions.summary(channel, msg.id) == []
    end
  end

  # -- hardening plan 2.2: the history read is bounded per statement ------------

  # Direct row insert: the property under test is the READ, and hundreds of
  # `create_message` calls would spend the test in the publish/touch paths.
  defp seed_row(channel, thread_id) do
    id = Cytale.Snowflake.next()
    now = DateTime.utc_now() |> DateTime.truncate(:millisecond)
    bucket = Messages.bucket_for(Cytale.Snowflake.timestamp_ms(id))

    Cytale.Repo.execute!(
      "INSERT INTO #{Cytale.Repo.keyspace()}.messages " <>
        "(channel_id, bucket, message_id, author_id, content, thread_id, reply_to_id, created_at, edited_at, attachments) " <>
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [
        {"bigint", channel},
        {"int", bucket},
        {"bigint", id},
        {"bigint", 1},
        {"text", "row #{id}"},
        {"bigint", thread_id},
        {"bigint", nil},
        {"timestamp", now},
        {"timestamp", nil},
        {"list<map<text, text>>", []}
      ]
    )

    id
  end

  # Every statement the call issues, in order (the seam the calls-sweep test uses).
  defp capture_statements(fun) do
    parent = self()
    ref = make_ref()
    handler_id = "messages-history-stmts-#{System.unique_integer([:positive])}"

    :ok =
      :telemetry.attach(
        handler_id,
        [:xandra, :execute_query, :start],
        fn _event, _measurements, metadata, ^parent ->
          send(parent, {:stmt, ref, statement_text(metadata.query)})
        end,
        parent
      )

    result = fun.()
    Process.sleep(50)
    statements = drain_statements(ref)
    :ok = :telemetry.detach(handler_id)
    {statements, result}
  end

  # A batch has no `:statement` field, so the captured text is every statement it
  # carries, joined — which is what lets a test assert "this fan was ONE trip".
  defp statement_text(%Xandra.Batch{queries: queries}) do
    queries
    |> Enum.map(&Map.get(&1, :statement, ""))
    |> Enum.join("; ")
  end

  defp statement_text(query), do: Map.get(query, :statement)

  defp drain_statements(ref, acc \\ []) do
    receive do
      {:stmt, ^ref, statement} -> drain_statements(ref, [statement | acc])
    after
      0 -> Enum.reverse(acc)
    end
  end

  describe "history reads each bucket in bounded chunks (plan 2.2)" do
    test "a bucket is read with a LIMIT, and the page never skips past rejected rows" do
      channel = ch_id()
      thread = Cytale.Snowflake.next()

      # Plain channel messages FIRST, then 250 thread replies, so the replies are
      # the NEWEST rows and every plain message sits below them — the order that
      # makes one bounded read useless. (All rows land in one bucket: the window is
      # 7 days, and snowflakes order by creation, so seeding order IS id order.)
      plain_ids = for _ <- 1..3, do: seed_row(channel, nil)
      for _ <- 1..250, do: seed_row(channel, thread)

      {statements, page} = capture_statements(fn -> Messages.history(channel, limit: 2) end)

      # The CORRECTNESS half, and the reason a naive per-bucket `LIMIT limit` is
      # wrong: the timeline filter rejects thread replies, so the newest 200 rows
      # survive nothing. A single bounded read would return an EMPTY page, and no
      # later page's `before` cursor could reach these rows (they are newer than
      # the next bucket's). The chunked walk keeps reading the same bucket.
      assert Enum.map(page, & &1.id) == plain_ids |> Enum.reverse() |> Enum.take(2)

      selects = Enum.filter(statements, &Regex.match?(~r/FROM \S*\.messages\b/, &1))

      # The COST half: no statement may read the partition unbounded, which is how
      # a 50-row page used to decode Xandra's entire 10k-row first page — up to
      # three buckets of it.
      refute selects == []

      assert Enum.all?(selects, &String.contains?(&1, "LIMIT")),
             "an unbounded messages read: #{inspect(selects)}"

      # 250 rejected rows need two chunks (200 + the rest) before plain rows show.
      assert length(selects) <= 3, "history issued #{length(selects)} messages reads"
    end

    test "a 600-row bucket does not decode the partition to fill a 100-row page" do
      channel = ch_id()

      # 600 plain rows in one bucket. `history/2` caps its page at 100, so ONE
      # bounded chunk must satisfy it — the old read decoded all 600 (and would
      # have decoded 10k, content included, had the bucket held that many).
      ids = for _ <- 1..600, do: seed_row(channel, nil)

      {statements, page} = capture_statements(fn -> Messages.history(channel, limit: 100) end)

      assert length(page) == 100
      assert Enum.map(page, & &1.id) == ids |> Enum.reverse() |> Enum.take(100)

      selects = Enum.filter(statements, &Regex.match?(~r/FROM \S*\.messages\b/, &1))
      assert length(selects) == 1, "one bounded read should fill the page: #{inspect(selects)}"
      assert hd(selects) =~ "LIMIT", "the bucket read is unbounded: #{inspect(selects)}"
    end
  end
end

defmodule Cytale.Messages.MessageTest.BrokenPublisher do
  @behaviour Cytale.Publish

  @impl true
  def publish(_channel_id, _event), do: raise("simulated fan-out outage")

  @impl true
  def publish_user_update(_user_id, _event), do: raise("simulated fan-out outage")
end
