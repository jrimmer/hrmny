defmodule Cytale.Notifications.Preview do
  @moduledoc """
  What a notification SAYS (notifications plan, the display half).

  The first push a member received read `hey <@91238576276111360> offline push
  probe` — the wire form of a mention, rendered to a human. Every mechanism
  around it had been tested; nobody had asked what the result looked like. This
  module is that question, answered.

  ## Two rules, both learned the hard way

  **Never show a raw id.** A mention we cannot resolve becomes `@someone`
  rather than a snowflake, and a channel reference (`<#id>`) the recipient
  cannot see, or that no longer exists, becomes `#channel`. A digit string is worse than a generic word: it
  reads as corruption, and it puts an internal identifier somewhere a member
  will screenshot. The same applies to a title with an unknown sender.

  **A preview is one line.** Newlines and runs of whitespace collapse, because
  the OS renders a body in a small fixed region and a multi-line paste reads as
  broken layout. Markdown is stripped to its text — emphasis markers, code
  fences, heading hashes and link URLs are all presentation the app already
  does, and a preview showing `**bold**` or a bare URL is showing the source
  instead of the message. A Markdown image previews as its alt text, or
  `[image]` when it has none. A timestamp tag (`<t:1791328800:R>`) reads as
  the moment in UTC, `October 6, 2026 23:20 UTC`: the server does not know
  the recipient's zone, and a relative "in 5 minutes" would be stale by the
  time the notification is read. A backslash escape reads as its character
  (`2 \\* 3` previews as `2 * 3`), exactly as the timeline draws it.
  """

  @max_body_chars 200
  @mention_token ~r/<@!?(\d{1,19})>/
  @channel_token ~r/<#(\d{1,19})>/
  @fenced_code ~r/```.*?```/s
  @link ~r/\[([^\]]*)\]\([^)]*\)/
  # `![alt](url)` reads as its alt text, or `[image]` when it has none —
  # never the URL, never the `!`. Runs before the link rule, which would
  # otherwise take the `[alt](url)` half and leave the `!` behind.
  @image ~r/!\[([^\]\n]*)\]\([^)\s]*(?: "[^"\n]*")?\)/
  # Discord's timestamp tag, as the timeline parses it (`@cytale/markdown`).
  @timestamp ~r/<t:(-?\d{1,13})(?::([tTdDfFR]))?>/
  @inline_code ~r/`([^`]*)`/
  @bold_italic ~r/(\*\*|__|\*|_)(.+?)\1/
  @strike ~r/~~(.+?)~~/
  @heading ~r/^\#{1,6}\s+/m
  # A backslash before ASCII punctuation is that character, literally
  # (CommonMark's rule, and the timeline's): `2 \* 3` reads `2 * 3`.
  @escape ~r/\\([!-\/:-@\[-`{-~])/
  # Stand-ins for text that must survive the markup rules untouched (escaped
  # characters, code span contents): one private-use codepoint each.
  @slot_base 0xF0000
  @slot ~r/[\x{F0000}-\x{FFFFD}]/u

  @doc """
  The message body as a member should read it.

  `:names` maps user id (integer or the string the token carries) to a display
  name; ids absent from it resolve to `@someone`. `:channel_names` does the
  same for `<#id>` channel references; absent ids resolve to `#channel`. The
  caller decides which channels the RECIPIENT may see named.
  """
  @spec body(String.t() | nil, keyword()) :: String.t()
  def body(content, opts \\ [])

  def body(nil, _opts), do: "New message"
  def body("", _opts), do: "New message"

  def body(content, opts) when is_binary(content) do
    names = Keyword.get(opts, :names, %{})
    channel_names = Keyword.get(opts, :channel_names, %{})

    rendered =
      content
      |> strip_markdown()
      |> resolve_mentions(names)
      |> resolve_channels(channel_names)
      |> collapse_whitespace()
      |> truncate()

    # A message made ENTIRELY of markup strips to nothing; saying nothing is
    # not an option for a notification that already fired.
    if rendered == "", do: "New message", else: rendered
  end

  @doc """
  The notification title.

  A channel message is titled by its CHANNEL and a direct message by its
  SENDER. Deliberately not the product name: the member already knows which app
  the notification came from — the OS shows the icon — so an app name in the
  title spends the most legible line on the one fact the member does not need,
  and leaves the message itself anonymous. Slack and Discord both title by
  conversation for the same reason.
  """
  @spec title(keyword()) :: String.t()
  def title(opts \\ []) do
    channel_name = Keyword.get(opts, :channel_name)
    author_name = Keyword.get(opts, :author_name)
    is_dm = Keyword.get(opts, :is_dm, false)

    cond do
      is_dm and present?(author_name) -> author_name
      present?(channel_name) -> "#" <> channel_name
      present?(author_name) -> author_name
      true -> "New message"
    end
  end

  # -- internals -----------------------------------------------------------------

  # Order matters: fenced blocks collapse BEFORE inline rules, or the fences
  # are eaten by the emphasis rule and the code text is mangled. Code span
  # contents and backslash-escaped characters are set aside first, so no
  # rule can read them as markup (`\*not italic\*`, `\# not a heading`, a
  # `*` inside code), and come back as the literal text they are — an
  # escape without its backslash, as the timeline draws it.
  defp strip_markdown(content) do
    {content, slots} =
      content
      |> String.replace(@fenced_code, fn block ->
        block |> String.replace(~r/^```.*$/m, "") |> String.trim()
      end)
      |> set_aside(@inline_code, [])

    {content, slots} = set_aside(content, @escape, slots)

    content
    |> String.replace(@timestamp, &timestamp_text/1)
    |> String.replace(@image, fn image ->
      case Regex.run(@image, image, capture: :all_but_first) do
        [alt] when alt != "" -> alt
        _ -> "[image]"
      end
    end)
    |> String.replace(@link, "\\1")
    |> String.replace(@heading, "")
    |> strip_emphasis(4)
    |> restore(slots)
  end

  # A tag whose instant a date cannot hold is not a tag: it stays as typed.
  defp timestamp_text(tag) do
    [unix | style] = Regex.run(@timestamp, tag, capture: :all_but_first)

    case DateTime.from_unix(String.to_integer(unix)) do
      {:ok, at} -> Calendar.strftime(at, timestamp_format(List.first(style, "")))
      {:error, _} -> tag
    end
  end

  defp timestamp_format("t"), do: "%H:%M UTC"
  defp timestamp_format("T"), do: "%H:%M:%S UTC"
  defp timestamp_format("d"), do: "%Y-%m-%d"
  defp timestamp_format("D"), do: "%B %-d, %Y"
  defp timestamp_format("F"), do: "%A, %B %-d, %Y %H:%M UTC"
  # `f`, the default, and `R`: a countdown reads as the moment it counts to.
  defp timestamp_format(_f_or_r), do: "%B %-d, %Y %H:%M UTC"

  # Emphasis nests (`~~**x**~~`, `***x***`): strip a layer at a time.
  defp strip_emphasis(content, 0), do: content

  defp strip_emphasis(content, layers) do
    stripped =
      content
      |> String.replace(@strike, "\\1")
      |> String.replace(@bold_italic, "\\2")

    if stripped == content, do: content, else: strip_emphasis(stripped, layers - 1)
  end

  # Replace each match's first capture with a stand-in codepoint; the slot
  # list (newest first) maps them back.
  defp set_aside(content, regex, slots) do
    Regex.split(regex, content, include_captures: true)
    |> Enum.reduce({[], slots}, fn piece, {acc, slots} ->
      case Regex.run(regex, piece) do
        [^piece, kept] ->
          slot = @slot_base + length(slots)
          {[<<slot::utf8>> | acc], [kept | slots]}

        _ ->
          {[piece | acc], slots}
      end
    end)
    |> then(fn {acc, slots} -> {acc |> Enum.reverse() |> IO.iodata_to_binary(), slots} end)
  end

  defp restore(content, []), do: content

  defp restore(content, slots) do
    table = slots |> Enum.reverse() |> List.to_tuple()

    String.replace(content, @slot, fn <<cp::utf8>> ->
      index = cp - @slot_base
      if index < tuple_size(table), do: elem(table, index), else: <<cp::utf8>>
    end)
  end

  defp resolve_mentions(content, names) do
    String.replace(content, @mention_token, fn token ->
      id = token |> String.replace(~r/[^\d]/, "") |> String.to_integer()

      case Map.get(names, id) || Map.get(names, to_string(id)) do
        nil -> "@someone"
        name -> "@" <> name
      end
    end)
  end

  @doc "The channel ids a body references with `<#id>` tokens, in order, deduplicated."
  @spec channel_ids(String.t() | nil) :: [integer()]
  def channel_ids(content) when is_binary(content) do
    @channel_token
    |> Regex.scan(content, capture: :all_but_first)
    |> Enum.map(fn [id] -> String.to_integer(id) end)
    |> Enum.uniq()
  end

  def channel_ids(_content), do: []

  defp resolve_channels(content, channel_names) do
    String.replace(content, @channel_token, fn token ->
      id = token |> String.replace(~r/[^\d]/, "") |> String.to_integer()

      case Map.get(channel_names, id) || Map.get(channel_names, to_string(id)) do
        nil -> "#channel"
        name -> "#" <> name
      end
    end)
  end

  defp collapse_whitespace(content) do
    content
    |> String.replace(~r/\s+/, " ")
    |> String.trim()
  end

  defp truncate(content) when byte_size(content) <= @max_body_chars, do: content
  defp truncate(content), do: String.slice(content, 0, @max_body_chars) <> "…"

  defp present?(value), do: is_binary(value) and String.trim(value) != ""
end
