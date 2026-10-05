defmodule Cytale.Search.Query do
  @moduledoc """
  Search query parsing (U13, R12) — the pure-Elixir half of the search seam.

  Parses a user-entered search string into a structured query map:

      "deploy finished from:janet in:deploy before:last week"
      #=> %{term: "deploy finished", from: "janet", in: "deploy",
      #    after: nil, before: ~U[2026-08-23 00:00:00Z]}

  Supported filters (Discord-shaped):

    * `from:<username>` — restrict to messages authored by that user.
    * `in:<channel>` — restrict to a channel (by name or id).
    * `before:<date>` / `after:<date>` — date-range bounds. Accepts an ISO
      date (`2026-08-20`), an ISO datetime (`2026-08-20T12:00:00Z`), or a
      relative phrase (`last week`, `yesterday`, `last month`).

  A plain full-text term is everything that is not a recognized filter. The
  parser is lenient: an unknown `key:value` token is treated as part of the
  full-text term (so a literal "from:" in prose still searches), and a
  malformed date leaves that bound `nil` rather than failing the whole query.

  `restrict_to_channels/2` builds the permission-filtered query: given the
  member's visible channel ids (from the U7 permission engine), it narrows
  the `in` filter to only those channels — query-time, always current (AE4).
  """

  @typedoc "A parsed search query."
  @type t :: %{
          required(:term) => String.t(),
          required(:from) => String.t() | nil,
          required(:in) => String.t() | nil,
          required(:after) => DateTime.t() | nil,
          required(:before) => DateTime.t() | nil
        }

  @typedoc "A channel id (integer-native snowflake)."
  @type channel_id :: integer()

  @doc "Parse a search string into a structured query."
  @spec parse(String.t()) :: t()
  def parse(""), do: empty()
  def parse(nil), do: empty()

  def parse(raw) when is_binary(raw) do
    raw
    |> normalize_relative_phrases()
    |> String.split(~r/\s+/)
    |> Enum.reject(&(&1 == ""))
    |> Enum.reduce(empty(), &consume/2)
  end

  # Multi-word relative phrases ("last week", "last month") would be split by
  # the whitespace tokenizer; collapse them to a single token before splitting
  # so `before:last week` parses as one bound. The underscore form is decoded
  # back in parse_date.
  defp normalize_relative_phrases(raw) do
    raw
    |> String.replace("last week", "last_week")
    |> String.replace("last month", "last_month")
  end

  @doc "The empty query (no term, no filters)."
  @spec empty() :: t()
  def empty, do: %{term: "", from: nil, in: nil, after: nil, before: nil}

  # -- token consumption --------------------------------------------------------

  defp consume(token, acc) do
    case parse_filter(token) do
      {:ok, key, value} -> put_filter(acc, key, value)
      :not_a_filter -> %{acc | term: join_term(acc.term, token)}
    end
  end

  defp parse_filter(token) do
    case String.split(token, ":", parts: 2) do
      [key, value] when key in ["from", "in", "before", "after"] and value != "" ->
        {:ok, key, value}

      _ ->
        :not_a_filter
    end
  end

  defp put_filter(acc, "from", value), do: %{acc | from: value}
  defp put_filter(acc, "in", value), do: %{acc | in: value}
  defp put_filter(acc, "after", value), do: %{acc | after: parse_date(value)}
  defp put_filter(acc, "before", value), do: %{acc | before: parse_date(value)}

  defp join_term("", token), do: token
  defp join_term(term, token), do: term <> " " <> token

  # -- date parsing -------------------------------------------------------------

  @doc """
  Parse a date bound. Accepts ISO dates (`2026-08-20`), ISO datetimes
  (`2026-08-20T12:00:00Z`), or relative phrases (`yesterday`, `last week`,
  `last month`). Returns `nil` for anything unparseable (lenient).
  """
  @spec parse_date(String.t()) :: DateTime.t() | nil
  def parse_date(value) when is_binary(value) do
    cond do
      iso_datetime?(value) -> parse_iso_datetime(value)
      iso_date?(value) -> parse_iso_date(value)
      relative?(value) -> parse_relative(value)
      true -> nil
    end
  end

  def parse_date(_), do: nil

  # PERF-11: compiled ONCE at module compile time, not per parse — these two
  # sniffers run on every `after:`/`before:` bound of every search parse.
  @iso_datetime_re ~r/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(Z|[+-]\d{2}:\d{2})$/
  @iso_date_re ~r/^\d{4}-\d{2}-\d{2}$/

  defp iso_datetime?(v), do: Regex.match?(@iso_datetime_re, v)

  defp iso_date?(v), do: Regex.match?(@iso_date_re, v)

  defp parse_iso_datetime(v) do
    case DateTime.from_iso8601(v) do
      {:ok, dt, _offset} -> dt
      _ -> nil
    end
  end

  defp parse_iso_date(v) do
    case Date.from_iso8601(v) do
      {:ok, date} -> DateTime.new!(date, ~T[00:00:00], "Etc/UTC")
      _ -> nil
    end
  end

  defp relative?(v), do: v in ["yesterday", "last_week", "last_month"]

  defp parse_relative("yesterday"), do: shift_days(-1)
  defp parse_relative("last_week"), do: shift_days(-7)
  defp parse_relative("last_month"), do: shift_days(-30)

  defp shift_days(days) do
    DateTime.utc_now()
    |> DateTime.add(days * 86_400, :second)
    |> DateTime.truncate(:second)
  end

  # -- permission filtering -----------------------------------------------------

  @doc """
  Restrict a parsed query to the member's visible channels (U7 permission
  engine). If the query already has an `in:` filter, it is kept only when it
  names one of the visible channels (by id or name); otherwise the `in` is
  dropped so the search spans all visible channels. Returns the narrowed query.
  """
  @spec restrict_to_channels(t(), [channel_id()]) :: t()
  def restrict_to_channels(%{in: nil} = q, _visible), do: q

  def restrict_to_channels(%{in: in_filter} = q, visible) when is_list(visible) do
    visible_ids = Enum.map(visible, &Integer.to_string/1)

    if in_filter in visible_ids do
      q
    else
      # The named channel is not visible to this member — drop the `in` so the
      # search falls back to all visible channels (never leaks a hidden one).
      %{q | in: nil}
    end
  end

  def restrict_to_channels(q, _visible), do: q
end
