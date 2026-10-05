defmodule Cytale.Notifications.Mentions do
  @moduledoc """
  The server-side mention signal (plan U3, R2).

  Before this module the only server-side mention parsing lived in a private
  function inside the Discord-compat codec, and the member-facing message shape
  carried none at all — so the notification policy could not answer "did this
  reach the member", and the two surfaces that did parse had already drifted
  apart on which token forms counted (the client regex missed `<@!id>`).

  One tokenizer serves every caller. That is the point: a mismatch between the
  codec's projection and the policy's decision is the class of bug where a
  member is visibly mentioned and is never told.

  ## The grammar

  A user mention is `<@id>` or `<@!id>` where `id` is a Snowflake: digits
  only, and no longer than a Snowflake can be. A **bare `@name` is not a
  mention** — the id token is the signal, because name matching false-fires on
  ordinary prose (a message containing the word "max" is not addressed to Max)
  while an id token cannot.

  `@everyone` and `@here` are separate tokens with their own predicate, and
  they must be bounded so `@heretical` is not a broadcast. A mention's storage
  form is deliberately raw — `<@id>` stays in the content — so this parses
  rather than reading a projection that may not have been written.
  """

  @token ~r/<@!?(\d{1,19})>/
  @snowflake_max 9_223_372_036_854_775_807
  @everyone "@everyone"
  @here "@here"

  @doc """
  Every user id mentioned in the content, in first-appearance order and
  de-duplicated.

  Returns `[]` for absent or empty content rather than raising: a message with
  no body (an attachment-only post) is not an error case.
  """
  @spec user_ids(String.t() | nil) :: [integer()]
  def user_ids(nil), do: []

  def user_ids(content) when is_binary(content) do
    @token
    |> Regex.scan(content, capture: :all_but_first)
    |> Enum.flat_map(fn [id] ->
      case Integer.parse(id) do
        {int, ""} when int <= @snowflake_max -> [int]
        _ -> []
      end
    end)
    |> Enum.uniq()
  end

  @doc "Whether the content mentions this user id, in either token form."
  @spec mentions_user?(String.t() | nil, integer()) :: boolean()
  def mentions_user?(content, user_id) when is_integer(user_id) do
    user_id in user_ids(content)
  end

  def mentions_user?(_content, _user_id), do: false

  @doc """
  Whether the content addresses everyone.

  The token must be bounded on the right, so `@everyoneelse` is ordinary text
  rather than a broadcast that notifies a whole workspace.
  """
  @spec everyone?(String.t() | nil) :: boolean()
  def everyone?(content), do: broadcast?(content, @everyone)

  @doc "Whether the content addresses the members currently active. Bounded like `everyone?/1`."
  @spec here?(String.t() | nil) :: boolean()
  def here?(content), do: broadcast?(content, @here)

  @doc """
  Whether the content carries any broadcast token. The policy treats these as
  their own event class rather than as a direct mention, because a member's
  willingness to receive them is a separate setting.
  """
  @spec broadcast?(String.t() | nil) :: boolean()
  def broadcast?(nil), do: false

  def broadcast?(content) when is_binary(content) do
    everyone?(content) or here?(content)
  end

  # -- internals -----------------------------------------------------------------

  defp broadcast?(nil, _token), do: false

  defp broadcast?(content, token) when is_binary(content) do
    case :binary.match(content, token) do
      :nomatch ->
        false

      {pos, len} ->
        after_token = pos + len

        # End of string, or a character that cannot continue a word.
        after_token == byte_size(content) or
          not word_byte?(:binary.at(content, after_token))
    end
  end

  defp broadcast?(_content, _token), do: false

  defp word_byte?(byte) do
    (byte >= ?a and byte <= ?z) or (byte >= ?A and byte <= ?Z) or
      (byte >= ?0 and byte <= ?9) or byte == ?_
  end
end
