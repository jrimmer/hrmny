defmodule Cytale.Messages.ReactionsTest do
  @moduledoc """
  The reactions data layer: existence-row semantics (idempotent add, no-op
  remove), the application-managed count mirror (0→1 insert, 1→0 row delete
  — absent IS zero), the 20-distinct-emoji cap, emoji validation, user
  listing cursors, summary/me_flags/render projections, and the
  message-delete cascade into both reaction tables.
  """

  use Cytale.ScyllaCase, async: false

  alias Cytale.Messages
  alias Cytale.Messages.Reactions

  defp ch_id, do: Cytale.Snowflake.next()
  defp user_id, do: Cytale.Snowflake.next()

  defp seed_message do
    channel = ch_id()

    {:ok, msg} =
      Messages.create_message(%{channel_id: channel, author_id: user_id(), content: "react to me"})

    {channel, msg}
  end

  # Raw table reads — the pins assert table state, not projections.
  defp reaction_rows(channel_id, message_id) do
    bucket = Messages.bucket_for(Cytale.Snowflake.timestamp_ms(message_id))

    Cytale.Repo.execute!(
      "SELECT emoji, user_id FROM #{Cytale.Repo.keyspace()}.reactions_by_message WHERE channel_id = ? AND bucket = ? AND message_id = ?",
      [{"bigint", channel_id}, {"int", bucket}, {"bigint", message_id}]
    )
    |> Enum.to_list()
  end

  defp zero_tally(channel_id, message_id, emoji) do
    bucket = Messages.bucket_for(Cytale.Snowflake.timestamp_ms(message_id))

    Cytale.Repo.execute!(
      "UPDATE #{Cytale.Repo.keyspace()}.reaction_counts SET count = count + ? WHERE channel_id = ? AND bucket = ? AND message_id = ? AND emoji = ?",
      [{"bigint", -2}, {"bigint", channel_id}, {"int", bucket}, {"bigint", message_id}, {"text", emoji}]
    )
  end

  defp count_rows(channel_id, message_id) do
    bucket = Messages.bucket_for(Cytale.Snowflake.timestamp_ms(message_id))

    Cytale.Repo.execute!(
      "SELECT emoji, count FROM #{Cytale.Repo.keyspace()}.reaction_counts WHERE channel_id = ? AND bucket = ? AND message_id = ?",
      [{"bigint", channel_id}, {"int", bucket}, {"bigint", message_id}]
    )
    |> Enum.to_list()
  end

  describe "validate_emoji/1" do
    test "accepts Unicode emoji of 1-14 bytes and rejects everything else" do
      assert :ok = Reactions.validate_emoji("👍")
      assert :ok = Reactions.validate_emoji("❤️")
      assert :ok = Reactions.validate_emoji("🙂")
      # 14 bytes exactly (three 4-byte emoji + one 2-byte char).
      assert :ok = Reactions.validate_emoji(String.duplicate("🙂", 3) <> "ß")

      assert {:error, :invalid_emoji} = Reactions.validate_emoji("")
      assert {:error, :invalid_emoji} = Reactions.validate_emoji(":custom:")
      assert {:error, :invalid_emoji} = Reactions.validate_emoji("name:in")
      assert {:error, :invalid_emoji} = Reactions.validate_emoji(String.duplicate("🙂", 4))
      assert {:error, :invalid_emoji} = Reactions.validate_emoji(42)
      assert {:error, :invalid_emoji} = Reactions.validate_emoji(nil)
    end
  end

  describe "add/4 + remove/4" do
    test "first add inserts the existence row and seeds the count at 1", %{test: _} do
      {channel, msg} = seed_message()
      u1 = user_id()

      assert :ok = Reactions.add(channel, msg.id, u1, "👍")

      assert [%{"emoji" => "👍", "user_id" => ^u1}] = reaction_rows(channel, msg.id)
      assert [%{"emoji" => "👍", "count" => 1}] = count_rows(channel, msg.id)
    end

    test "idempotent re-add is :noop — no second row, no count move", %{test: _} do
      {channel, msg} = seed_message()
      u1 = user_id()

      assert :ok = Reactions.add(channel, msg.id, u1, "👍")
      assert :noop = Reactions.add(channel, msg.id, u1, "👍")

      assert length(reaction_rows(channel, msg.id)) == 1
      assert [%{"emoji" => "👍", "count" => 1}] = count_rows(channel, msg.id)
    end

    test "second user on the same emoji bumps the count to 2", %{test: _} do
      {channel, msg} = seed_message()
      u1 = user_id()
      u2 = user_id()

      assert :ok = Reactions.add(channel, msg.id, u1, "👍")
      assert :ok = Reactions.add(channel, msg.id, u2, "👍")

      assert [%{"count" => 2}] = count_rows(channel, msg.id)

      rows = reaction_rows(channel, msg.id) |> Enum.sort_by(& &1["user_id"])
      assert [%{"user_id" => ^u1}, %{"user_id" => ^u2}] = rows
    end

    test "remove decrements; the LAST remove zeroes the tally (0 = no reactions)", %{test: _} do
      {channel, msg} = seed_message()
      u1 = user_id()
      u2 = user_id()

      :ok = Reactions.add(channel, msg.id, u1, "👍")
      :ok = Reactions.add(channel, msg.id, u2, "👍")

      assert :ok = Reactions.remove(channel, msg.id, u1, "👍")
      assert [%{"count" => 1}] = count_rows(channel, msg.id)

      assert :ok = Reactions.remove(channel, msg.id, u2, "👍")

      # The tally is a COUNTER (hardening plan 4.3): the last removal writes it
      # down to 0 rather than deleting the row. A row delete here would race a
      # concurrent `+1` — the delete lands last and the whole tally is gone while
      # the existence rows remain — so zero is a VALUE, and every read treats it
      # as absence (`count > 0`).
      assert [%{"count" => 0}] = count_rows(channel, msg.id)
      assert reaction_rows(channel, msg.id) == []
      assert Reactions.summary(channel, msg.id) == []

      # …and it is a real zero, not a stuck one: a fresh add reads 1 again.
      assert :ok = Reactions.add(channel, msg.id, u1, "👍")
      assert [%{emoji: "👍", count: 1}] = Reactions.summary(channel, msg.id)
    end

    test "remove of an absent row is :noop (no tombstone writes, no event signal)", %{test: _} do
      {channel, msg} = seed_message()

      assert :noop = Reactions.remove(channel, msg.id, user_id(), "👍")
      assert :noop = Reactions.remove_user_reaction(channel, msg.id, user_id(), "👍")
    end

    test "invalid emoji never writes", %{test: _} do
      {channel, msg} = seed_message()

      assert {:error, :invalid_emoji} = Reactions.add(channel, msg.id, user_id(), ":blob:")
      assert {:error, :invalid_emoji} = Reactions.add(channel, msg.id, user_id(), "")
      assert reaction_rows(channel, msg.id) == []
      assert count_rows(channel, msg.id) == []
    end
  end

  # -- hardening plan 4.3: the tally is a counter, not a read-modify-write -------

  describe "concurrent adds (plan 4.3)" do
    test "N parallel adds of one emoji by DIFFERENT users yield exactly N", %{test: _} do
      # The gate the plan names. Before the fix `add/4` read the count and wrote
      # `n + 1`, so simultaneous adds all wrote the same `n + 1` and the tally was
      # permanently low (and never self-healed). A counter applies the delta
      # server-side, so every add lands.
      {channel, msg} = seed_message()
      users = for _ <- 1..8, do: user_id()

      results =
        users
        |> Task.async_stream(fn u -> Reactions.add(channel, msg.id, u, "👍") end,
          max_concurrency: 8,
          timeout: 60_000
        )
        |> Enum.map(fn {:ok, result} -> result end)

      assert Enum.all?(results, &(&1 == :ok))
      assert [%{emoji: "👍", count: 8}] = Reactions.summary(channel, msg.id)
      assert length(reaction_rows(channel, msg.id)) == 8
    end

    test "N parallel adds of one emoji by the SAME user land exactly once", %{test: _} do
      # The other half of the same hazard, and the reason the existence row's
      # write is `IF NOT EXISTS`: the old read-then-insert probe let one user's
      # simultaneous double-click see `:absent` twice and move the tally twice.
      {channel, msg} = seed_message()
      user = user_id()

      results =
        1..8
        |> Task.async_stream(fn _ -> Reactions.add(channel, msg.id, user, "👍") end,
          max_concurrency: 8,
          timeout: 60_000
        )
        |> Enum.map(fn {:ok, result} -> result end)

      assert Enum.count(results, &(&1 == :ok)) == 1
      assert Enum.count(results, &(&1 == :noop)) == 7
      assert [%{emoji: "👍", count: 1}] = Reactions.summary(channel, msg.id)
    end

    test "N parallel removes of one user's reaction decrement exactly once", %{test: _} do
      {channel, msg} = seed_message()
      user = user_id()
      :ok = Reactions.add(channel, msg.id, user, "👍")
      :ok = Reactions.add(channel, msg.id, user_id(), "👍")

      results =
        1..6
        |> Task.async_stream(fn _ -> Reactions.remove(channel, msg.id, user, "👍") end,
          max_concurrency: 6,
          timeout: 60_000
        )
        |> Enum.map(fn {:ok, result} -> result end)

      assert Enum.count(results, &(&1 == :ok)) == 1
      assert Enum.count(results, &(&1 == :noop)) == 5
      assert [%{emoji: "👍", count: 1}] = Reactions.summary(channel, msg.id)
    end
  end

  describe "the 20-distinct-emoji cap" do
    test "the 21st DISTINCT emoji errors; a 21st reaction on a KNOWN emoji is fine", %{test: _} do
      {channel, msg} = seed_message()

      emojis = Enum.map(0..19, &"🙂#{&1}")

      Enum.each(emojis, fn emoji ->
        assert :ok = Reactions.add(channel, msg.id, user_id(), emoji)
      end)

      assert length(count_rows(channel, msg.id)) == 20

      # 21st distinct → error.
      assert {:error, :too_many_emojis} = Reactions.add(channel, msg.id, user_id(), "🎉")
      assert {:error, :too_many_emojis} = Reactions.add(channel, msg.id, user_id(), "🎉")

      # A second user on an EXISTING emoji is not a distinct add.
      known = Enum.at(emojis, 0)
      assert :ok = Reactions.add(channel, msg.id, user_id(), known)
      assert [%{"emoji" => ^known, "count" => 2}] = count_rows(channel, msg.id) |> Enum.filter(&(&1["emoji"] == known))
    end
  end

  describe "remove_others/4 + remove_all/2" do
    test "clear one emoji for everyone: rows die, tally zeroes, removed users reported", %{test: _} do
      {channel, msg} = seed_message()
      u1 = user_id()
      u2 = user_id()
      u3 = user_id()

      :ok = Reactions.add(channel, msg.id, u1, "👍")
      :ok = Reactions.add(channel, msg.id, u2, "👍")
      :ok = Reactions.add(channel, msg.id, u3, "👀")

      assert {:ok, removed} = Reactions.remove_others(channel, msg.id, "👍", nil)

      assert Enum.sort(removed) == Enum.sort([u1, u2])
      assert reaction_rows(channel, msg.id) == [%{"emoji" => "👀", "user_id" => u3}]
      # The cleared emoji's tally is written down to zero (a lingering counter
      # row, filtered by every read); the OTHER emoji survives untouched.
      assert Enum.sort_by(count_rows(channel, msg.id), & &1["emoji"]) == [
               %{"emoji" => "👀", "count" => 1},
               %{"emoji" => "👍", "count" => 0}
             ]

      assert Reactions.summary(channel, msg.id) == [%{emoji: "👀", count: 1}]
    end

    test "remove_others spares the except_user_id", %{test: _} do
      {channel, msg} = seed_message()
      u1 = user_id()
      u2 = user_id()

      :ok = Reactions.add(channel, msg.id, u1, "👍")
      :ok = Reactions.add(channel, msg.id, u2, "👍")

      assert {:ok, [^u2]} = Reactions.remove_others(channel, msg.id, "👍", u1)
      assert [%{"user_id" => ^u1, "emoji" => "👍"}] = reaction_rows(channel, msg.id)
    end

    test "a sweep never drives the tally below zero (drifted or missing tally row)", %{test: _} do
      # The sweep subtracts ONE delta for the whole emoji (not one conditional
      # delete per reactor — that would be a serialized LWT round per reactor in
      # one partition). The clamp is what makes the cheap version safe: a tally
      # that is already missing or low must not be pushed NEGATIVE, because a
      # negative tally is invisible to every read while the existence rows remain.
      {channel, msg} = seed_message()
      u1 = user_id()
      u2 = user_id()
      :ok = Reactions.add(channel, msg.id, u1, "👍")
      :ok = Reactions.add(channel, msg.id, u2, "👍")

      # Drift: existence rows with a zero tally — what a crash between the
      # existence write and the tally move leaves behind. (It is produced with a
      # DELTA, never a DELETE: a counter row delete would swallow every later
      # increment, which is the hazard `remove_all/2` is shaped around.)
      zero_tally(channel, msg.id, "👍")

      assert Reactions.summary(channel, msg.id) == []
      assert {:ok, removed} = Reactions.remove_others(channel, msg.id, "👍", nil)
      assert Enum.sort(removed) == Enum.sort([u1, u2])

      refute Enum.any?(count_rows(channel, msg.id), &(&1["count"] < 0)),
             "the sweep drove the tally negative"

      # And the emoji is usable again afterwards.
      assert :ok = Reactions.add(channel, msg.id, u1, "👍")
      assert [%{emoji: "👍", count: 1}] = Reactions.summary(channel, msg.id)
    end

    test "clearing an emoji nobody used is an empty sweep", %{test: _} do
      {channel, msg} = seed_message()

      assert {:ok, []} = Reactions.remove_others(channel, msg.id, "👍", nil)
    end

    test "remove_all clears the message and stays USABLE afterwards", %{test: _} do
      {channel, msg} = seed_message()
      u = user_id()

      :ok = Reactions.add(channel, msg.id, u, "👍")
      :ok = Reactions.add(channel, msg.id, user_id(), "👀")

      assert :ok = Reactions.remove_all(channel, msg.id)

      assert reaction_rows(channel, msg.id) == []
      assert Reactions.summary(channel, msg.id) == []

      # The tallies are ZEROED, not deleted: a CQL counter DELETE leaves a
      # tombstone that discards later increments (probed against ScyllaDB
      # 2026.2), so a deleted partition would leave every reaction added after a
      # clear invisible — the existence row written, the count unreadable.
      assert Enum.all?(count_rows(channel, msg.id), &(&1["count"] == 0))

      assert :ok = Reactions.add(channel, msg.id, u, "👍")
      assert [%{emoji: "👍", count: 1}] = Reactions.summary(channel, msg.id)
    end
  end

  describe "list_users/4" do
    test "pages ascending by user_id with the after cursor; limit honored", %{test: _} do
      {channel, msg} = seed_message()
      users = Enum.map(1..7, fn _ -> user_id() end) |> Enum.sort()
      Enum.each(users, &Reactions.add(channel, msg.id, &1, "👍"))
      # A different emoji's users never leak in.
      other = user_id()
      :ok = Reactions.add(channel, msg.id, other, "👀")

      {page1, next} = Reactions.list_users(channel, msg.id, "👍", limit: 3)
      assert page1 == Enum.take(users, 3)
      assert next == Enum.at(users, 2)

      {page2, next2} = Reactions.list_users(channel, msg.id, "👍", limit: 3, after: next)
      assert page2 == Enum.slice(users, 3, 3)
      assert next2 == Enum.at(users, 5)

      {page3, next3} = Reactions.list_users(channel, msg.id, "👍", limit: 3, after: next2)
      assert page3 == [List.last(users)]
      assert next3 == nil
      refute other in page1 or other in page2 or other in page3
    end

    test "empty result for an unknown emoji", %{test: _} do
      {channel, msg} = seed_message()

      assert {[], nil} = Reactions.list_users(channel, msg.id, "👍", [])
    end
  end

  describe "summary/3, me_flags/3, render/3" do
    test "summary lists every emoji count; me_flags the viewer's emojis", %{test: _} do
      {channel, msg} = seed_message()
      u1 = user_id()
      u2 = user_id()

      :ok = Reactions.add(channel, msg.id, u1, "👍")
      :ok = Reactions.add(channel, msg.id, u2, "👍")
      :ok = Reactions.add(channel, msg.id, u1, "👀")

      summary = Reactions.summary(channel, msg.id)
      assert Enum.find(summary, &(&1.emoji == "👍")).count == 2
      assert Enum.find(summary, &(&1.emoji == "👀")).count == 1

      assert Reactions.me_flags(channel, msg.id, u1) == MapSet.new(["👍", "👀"])
      assert Reactions.me_flags(channel, msg.id, u2) == MapSet.new(["👍"])
    end

    test "render is nil when none; else per-viewer me flags", %{test: _} do
      {channel, msg} = seed_message()
      u1 = user_id()
      u2 = user_id()

      assert nil == Reactions.render(channel, msg.id, u1)

      :ok = Reactions.add(channel, msg.id, u1, "👍")
      :ok = Reactions.add(channel, msg.id, u2, "👍")

      assert [
               %{"emoji" => "👍", "count" => 2, "me" => true}
             ] = Reactions.render(channel, msg.id, u1)

      assert [
               %{"emoji" => "👍", "count" => 2, "me" => false}
             ] = Reactions.render(channel, msg.id, user_id())

      # nil viewer (the fan-out projection): me is false, key data intact.
      assert [%{"emoji" => "👍", "count" => 2, "me" => false}] = Reactions.render(channel, msg.id, nil)
    end
  end

  describe "batched page render (hardening plan 2.1)" do
    # The plan's gate: the page render's read count is BOUNDED — it must not scale
    # with the page's row count. `render/3` per message was 2 point reads each (200
    # for a 100-message page); `render_many/3` groups the ids by bucket and issues
    # one `message_id IN ?` read per group, plus one for the viewer flags.
    test "the read count does not scale with the number of page rows" do
      channel = ch_id()
      viewer = user_id()

      # Seed N messages with a reaction each, then render a small and a large page.
      seed = fn count ->
        for i <- 1..count do
          {:ok, msg} =
            Messages.create_message(%{
              channel_id: channel,
              author_id: user_id(),
              content: "page row #{i}"
            })

          :ok = Reactions.add(channel, msg.id, viewer, "👍")
          Map.take(msg, [:id, :bucket])
        end
      end

      small = seed.(5)
      large = seed.(100)

      {small_stmts, small_rendered} =
        capture_statements(fn -> Reactions.render_many(channel, small, viewer) end)

      {large_stmts, large_rendered} =
        capture_statements(fn -> Reactions.render_many(channel, large, viewer) end)

      # Every rendered message carries its entry, with the viewer's `me` flag.
      assert map_size(small_rendered) == 5
      assert map_size(large_rendered) == 100

      assert [%{"emoji" => "👍", "count" => 1, "me" => true}] = small_rendered[hd(small).id]

      # BOUNDED: the same number of statements for 5 rows and for 100 — the ids
      # travel in ONE `IN ?` list per bucket, not one statement per row.
      assert length(small_stmts) == length(large_stmts),
             "render_many scaled with rows: #{length(small_stmts)} vs #{length(large_stmts)}"

      # Two reads: the counts batch and the viewer-flags batch.
      assert length(large_stmts) == 2

      assert Enum.all?(large_stmts, &String.contains?(&1, "IN ?")),
             "a per-message read slipped back in: #{inspect(large_stmts)}"
    end

    test "render_many returns the same shapes as the single-message render" do
      {channel, msg} = seed_message()
      viewer = user_id()
      other = user_id()

      :ok = Reactions.add(channel, msg.id, viewer, "👍")
      :ok = Reactions.add(channel, msg.id, other, "👀")

      rows = [Map.take(msg, [:id, :bucket])]

      # The batch and the point read agree for both viewer shapes, including the
      # ABSENT case (no entry in the map ⇔ `render/3`'s nil ⇔ no wire key).
      assert Reactions.render_many(channel, rows, viewer) == %{msg.id => Reactions.render(channel, msg.id, viewer)}
      assert Reactions.render_many(channel, rows, other) == %{msg.id => Reactions.render(channel, msg.id, other)}
      assert Reactions.render_many(channel, rows, nil) == %{msg.id => Reactions.render(channel, msg.id, nil)}

      {:ok, quiet} =
        Messages.create_message(%{channel_id: channel, author_id: user_id(), content: "no reactions"})

      assert Reactions.render_many(channel, [Map.take(quiet, [:id, :bucket])], viewer) == %{}
      assert Reactions.render(channel, quiet.id, viewer) == nil

      # An empty page issues no read at all.
      assert Reactions.render_many(channel, [], viewer) == %{}
    end
  end

  # Statement capture over Xandra's query telemetry (the seam the sweep and
  # history tests use).
  defp capture_statements(fun) do
    parent = self()
    ref = make_ref()
    handler_id = "reactions-page-stmts-#{System.unique_integer([:positive])}"

    :ok =
      :telemetry.attach(
        handler_id,
        [:xandra, :execute_query, :start],
        fn _event, _measurements, metadata, ^parent ->
          send(parent, {:stmt, ref, metadata.query.statement})
        end,
        parent
      )

    result = fun.()
    Process.sleep(50)
    statements = drain_statements(ref)
    :ok = :telemetry.detach(handler_id)
    {statements, result}
  end

  defp drain_statements(ref, acc \\ []) do
    receive do
      {:stmt, ^ref, statement} -> drain_statements(ref, [statement | acc])
    after
      0 -> Enum.reverse(acc)
    end
  end

  describe "message-delete cascade" do
    test "delete_message empties both reaction tables for the message", %{test: _} do
      {channel, msg} = seed_message()

      :ok = Reactions.add(channel, msg.id, user_id(), "👍")
      :ok = Reactions.add(channel, msg.id, user_id(), "👀")

      :ok = Messages.delete_message(channel, msg.id)

      assert reaction_rows(channel, msg.id) == []
      assert count_rows(channel, msg.id) == []
      assert Reactions.summary(channel, msg.id) == []
    end
  end

  describe "recount (review #24)" do
    test "a drifted tally is moved back to the existence rows" do
      {channel, msg} = seed_message()
      :ok = Reactions.add(channel, msg.id, user_id(), "👍")
      :ok = Reactions.add(channel, msg.id, user_id(), "👍")
      :ok = Reactions.add(channel, msg.id, user_id(), "🎉")

      # The drift a failed bump leaves: the rows say 2 and 1.
      bucket = Messages.bucket_for(Cytale.Snowflake.timestamp_ms(msg.id))

      for {emoji, delta} <- [{"👍", 3}, {"🎉", -1}] do
        Cytale.Repo.execute!(
          "UPDATE #{Cytale.Repo.keyspace()}.reaction_counts SET count = count + ? WHERE channel_id = ? AND bucket = ? AND message_id = ? AND emoji = ?",
          [{"bigint", delta}, {"bigint", channel}, {"int", bucket}, {"bigint", msg.id}, {"text", emoji}]
        )
      end

      assert :ok = Reactions.recount(channel, msg.id)

      assert Reactions.summary(channel, msg.id) |> Map.new(&{&1.emoji, &1.count}) == %{"👍" => 2, "🎉" => 1}

      # A clean tally is left alone.
      assert :ok = Reactions.recount(channel, msg.id)
      assert Reactions.summary(channel, msg.id) |> Map.new(&{&1.emoji, &1.count}) == %{"👍" => 2, "🎉" => 1}
    end
  end
end
