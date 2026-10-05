defmodule Cytale.Search.QueryTest do
  @moduledoc """
  U13 slice 1 — search query parsing: `from:`, `in:`, date-range bounds
  (ISO + relative), plain full-text term, and permission-filtered query
  construction. Pure Elixir — no DB, no NIF.
  """

  use ExUnit.Case, async: true

  alias Cytale.Search.Query

  describe "plain full-text term" do
    test "a bare string becomes the term" do
      assert Query.parse("deploy finished") == %{
               term: "deploy finished",
               from: nil,
               in: nil,
               after: nil,
               before: nil
             }
    end

    test "empty / nil input yields the empty query" do
      assert Query.parse("") == Query.empty()
      assert Query.parse(nil) == Query.empty()
    end
  end

  describe "from: / in: filters" do
    test "from: and in: are extracted, the rest is the term" do
      q = Query.parse("deploy from:janet in:deploy")

      assert q.term == "deploy"
      assert q.from == "janet"
      assert q.in == "deploy"
    end

    test "an unknown key:value is treated as part of the term (lenient)" do
      q = Query.parse("hello from:world")
      assert q.term == "hello"
      assert q.from == "world"

      # unknown key stays in the term
      q2 = Query.parse("hello color:red")
      assert q2.term == "hello color:red"
      assert q2.from == nil
    end

    test "a bare 'from:' with no value is not a filter" do
      q = Query.parse("from:")
      assert q.from == nil
      assert q.term == "from:"
    end
  end

  describe "date-range bounds" do
    test "ISO date before: parses to a UTC midnight datetime" do
      q = Query.parse("deploy before:2026-08-20")
      assert q.before == DateTime.new!(~D[2026-08-20], ~T[00:00:00], "Etc/UTC")
      assert q.after == nil
    end

    test "ISO datetime after: parses" do
      q = Query.parse("deploy after:2026-08-20T12:00:00Z")
      assert {:ok, expected, _} = DateTime.from_iso8601("2026-08-20T12:00:00Z")
      assert q.after == expected
    end

    test "relative bounds (yesterday / last week / last month) resolve to a past datetime" do
      now = DateTime.utc_now() |> DateTime.truncate(:second)

      q = Query.parse("deploy before:last week")
      assert q.before != nil
      assert DateTime.compare(q.before, now) == :lt

      q2 = Query.parse("deploy after:yesterday")
      assert q2.after != nil
      assert DateTime.compare(q2.after, now) == :lt
    end

    test "malformed date leaves the bound nil (lenient, does not fail)" do
      q = Query.parse("deploy before:not-a-date")
      assert q.before == nil
      assert q.term == "deploy"
    end
  end

  describe "permission-filtered query construction" do
    test "no in: filter → unchanged (spans all visible channels)" do
      q = Query.parse("deploy")
      assert Query.restrict_to_channels(q, [1, 2, 3]) == q
    end

    test "in: names a visible channel id → kept" do
      q = Query.parse("deploy in:42")
      assert Query.restrict_to_channels(q, [42, 43]).in == "42"
    end

    test "in: names a channel NOT visible to the member → dropped (no leak)" do
      q = Query.parse("deploy in:99")
      assert Query.restrict_to_channels(q, [42, 43]).in == nil
    end

    test "in: names a visible channel by id string → kept" do
      q = Query.parse("deploy in:7")
      assert Query.restrict_to_channels(q, [7]).in == "7"
    end
  end
end
