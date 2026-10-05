defmodule Cytale.Notifications.PreviewTest do
  @moduledoc """
  What a notification actually SAYS — the part I never checked.

  The first push a member received read `hey <@91238576276111360> offline push
  probe`, with the wire form of a mention exposed to a human. Every mechanism
  around it was verified: encryption, subscription lifecycle, the audience, the
  gates. Nobody asked what it looked like.
  """

  use ExUnit.Case, async: true

  alias Cytale.Notifications.Preview

  describe "channel references (<#id>)" do
    test "a channel the caller named becomes #name" do
      assert Preview.body("see <#77> now", channel_names: %{77 => "general"}) == "see #general now"
    end

    test "an unnamed channel degrades to #channel, never to a raw id" do
      body = Preview.body("see <#77> now", channel_names: %{})
      refute body =~ "<#"
      refute body =~ "77"
      assert body == "see #channel now"
    end

    test "mentions and channels resolve together" do
      assert Preview.body("<@1> in <#77>", names: %{1 => "mia"}, channel_names: %{"77" => "dev"}) ==
               "@mia in #dev"
    end

    test "channel_ids lists each referenced channel once, in order" do
      assert Preview.channel_ids("<#2> <#1> <#2> <@3>") == [2, 1]
      assert Preview.channel_ids(nil) == []
    end
  end

  describe "mention resolution" do
    test "a plain token becomes the member's display name" do
      assert Preview.body("hey <@42> look", names: %{42 => "mia"}) == "hey @mia look"
    end

    test "the nickname form resolves the same way" do
      assert Preview.body("hey <@!42> look", names: %{42 => "mia"}) == "hey @mia look"
    end

    # A name we cannot resolve must not fall back to a snowflake: an anonymous
    # digit string is worse than a generic word, and it leaks the raw id into
    # a place a human reads.
    test "an unresolvable mention degrades to a word, never to a raw id" do
      body = Preview.body("hey <@42> look", names: %{})

      refute body =~ "<@"
      refute body =~ "42"
      assert body =~ "@someone"
    end

    test "@everyone and @here survive as themselves" do
      assert Preview.body("@everyone standup", names: %{}) == "@everyone standup"
      assert Preview.body("@here quick q", names: %{}) == "@here quick q"
    end
  end

  describe "markdown" do
    test "emphasis markers are stripped, their text kept" do
      assert Preview.body("**bold** and _italic_ and *also*", names: %{}) ==
               "bold and italic and also"
    end

    test "inline code keeps its content without the backticks" do
      assert Preview.body("use `mix test` here", names: %{}) == "use mix test here"
    end

    test "an image previews as its alt text, or [image] — never its URL or the `!`" do
      assert Preview.body("look ![a whiteboard](https://img.example/wb.png) here") == "look a whiteboard here"
      assert Preview.body("![](https://img.example/wb.png)") == "[image]"
      assert Preview.body("![chart](https://img.example/c.png \"Q3\") and [docs](https://x.dev)") == "chart and docs"
    end

    test "a link keeps its label, not its URL" do
      assert Preview.body("see [the docs](https://example.com/x)", names: %{}) == "see the docs"
    end

    test "fenced code blocks collapse rather than carrying their fences" do
      body = Preview.body("before\n```\ncode here\n```\nafter", names: %{})
      refute body =~ "```"
      assert body =~ "code here"
    end

    test "a heading marker is not read as emphasis" do
      assert Preview.body("# Standup notes", names: %{}) == "Standup notes"
    end

    test "a backslash escape previews as its character" do
      assert Preview.body("2 \\* 3 \\* 4", names: %{}) == "2 * 3 * 4"
      assert Preview.body("\\*not italic\\*", names: %{}) == "*not italic*"
      assert Preview.body("\\*\\*not bold\\*\\*", names: %{}) == "**not bold**"
    end

    test "an escaped line-start marker is text, not structure" do
      assert Preview.body("\\# not a heading", names: %{}) == "# not a heading"
      assert Preview.body("1\\. not a list", names: %{}) == "1. not a list"
      assert Preview.body("\\> not a quote", names: %{}) == "> not a quote"
    end

    test "a backslash before anything else is kept" do
      assert Preview.body("C:\\Users\\me", names: %{}) == "C:\\Users\\me"
      assert Preview.body("a \\\\ b", names: %{}) == "a \\ b"
    end

    test "an escape inside inline code stays as written" do
      assert Preview.body("run `a\\*b`", names: %{}) == "run a\\*b"
    end

    test "escapes and real emphasis in one message" do
      assert Preview.body("**2 \\* 3** is _six_", names: %{}) == "2 * 3 is six"
    end

    test "nested emphasis and strikethrough are stripped to their text" do
      assert Preview.body("~~**gone bold**~~ and ***both***", names: %{}) == "gone bold and both"
    end

    test "a mention next to an escape still resolves" do
      assert Preview.body("\\*<@42>\\*", names: %{42 => "mia"}) == "*@mia*"
    end
  end

  describe "shape" do
    test "newlines collapse to spaces — a notification body is one line" do
      assert Preview.body("one\ntwo\n\nthree", names: %{}) == "one two three"
    end

    test "runs of whitespace collapse" do
      assert Preview.body("a    b", names: %{}) == "a b"
    end

    test "a long message is truncated with an ellipsis" do
      body = Preview.body(String.duplicate("x", 500), names: %{})

      assert String.ends_with?(body, "…")
      assert String.length(body) <= 201
    end

    test "a message that is only markup yields a fallback rather than nothing" do
      assert Preview.body("```\n```", names: %{}) != ""
    end

    test "absent content yields a fallback" do
      assert Preview.body(nil, names: %{}) == "New message"
      assert Preview.body("", names: %{}) == "New message"
    end
  end

  describe "title" do
    test "a channel message is titled by its channel — the app name says nothing" do
      assert Preview.title(channel_name: "general", author_name: "mia", is_dm: false) == "#general"
    end

    test "a direct message is titled by its sender" do
      assert Preview.title(channel_name: nil, author_name: "mia", is_dm: true) == "mia"
    end

    test "an unknown sender degrades to a word, never to an id" do
      title = Preview.title(channel_name: nil, author_name: nil, is_dm: true)
      refute title =~ ~r/\d{5,}/
      assert title != ""
    end
  end
end
