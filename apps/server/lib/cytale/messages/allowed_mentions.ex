defmodule Cytale.Messages.AllowedMentions do
  @moduledoc """
  Discord's `allowed_mentions`: the SENDER's say over which of a message's
  mentions may notify. Every sender that supplies it gets the same semantics —
  a bot or a person on the native routes, a bot on the compat routes, a
  webhook execute — because it is parsed here and applied in ONE place,
  `Cytale.Messages.create_message/1`, where every producer converges.

  The text is never rewritten: a suppressed `<@id>` or `@everyone` still reads
  as a mention, it just notifies nobody (Discord's behaviour).

  ## The object

    * `parse` — the mention KINDS that notify from the content: any of
      `"users"`, `"roles"`, `"everyone"`. `[]` suppresses all of them.
    * `users` — up to 100 user ids that may be notified even though `"users"`
      is not in `parse`. A listed id must still appear in the content.
    * `roles` — up to 100 role ids, the same for roles. Cytale has no role
      mention syntax, so this is accepted, validated and has nothing to act on.
    * `replied_user` — whether a reply notifies the author of the message it
      replies to. Default `false` once `allowed_mentions` is sent at all.

  `parse` naming `"users"` together with a non-empty `users` list (or
  `"roles"` with `roles`) is contradictory and refused, as Discord refuses it.

  ## Absent means "everything"

  A send without `allowed_mentions` behaves exactly as sends always have:
  every `<@id>` notifies, `@everyone`/`@here` notify when the author holds
  `mention_everyone`, and a reply reaches the replied-to author. That is why
  `parse(nil)` is `{:ok, nil}` and every helper here treats `nil` as "no
  restriction".

  ## What it cannot widen

  `allowed_mentions` only ever NARROWS. `"everyone"` in `parse` does not grant
  a broadcast: the author must still hold `mention_everyone` in the channel
  (`Cytale.Notifications.BroadcastGate`), and a user id only notifies a member
  who can see the channel (`Cytale.Inbox`).
  """

  alias Cytale.Notifications.Mentions

  @kinds ~w(users roles everyone)
  @max_ids 100

  @typedoc "A validated `allowed_mentions` object; `nil` is the absent default."
  @type t :: %{parse: [String.t()], users: [integer()], roles: [integer()], replied_user: boolean()}

  @doc """
  Validate the raw body value. `{:ok, nil}` when absent (or JSON null);
  `{:error, :invalid_allowed_mentions}` for anything malformed — a send that
  tried to say "do not ping" and was misunderstood must not ping.
  """
  @spec parse(term()) :: {:ok, t() | nil} | {:error, :invalid_allowed_mentions}
  def parse(nil), do: {:ok, nil}

  def parse(%{} = raw) do
    with {:ok, parse} <- kinds(Map.get(raw, "parse", [])),
         {:ok, users} <- ids(Map.get(raw, "users", [])),
         {:ok, roles} <- ids(Map.get(raw, "roles", [])),
         {:ok, replied_user} <- replied_user(Map.get(raw, "replied_user", false)),
         false <- "users" in parse and users != [],
         false <- "roles" in parse and roles != [] do
      {:ok, %{parse: parse, users: users, roles: roles, replied_user: replied_user}}
    else
      _ -> {:error, :invalid_allowed_mentions}
    end
  end

  def parse(_), do: {:error, :invalid_allowed_mentions}

  @doc "May `@everyone`/`@here` notify, as far as the sender is concerned?"
  @spec everyone?(t() | nil) :: boolean()
  def everyone?(nil), do: true
  def everyone?(%{parse: parse}), do: "everyone" in parse

  @doc """
  The user ids this message may notify directly, or `nil` when the sender set
  no restriction (receivers then read the mentions from the content, as they
  always have).

  With a restriction: the content's `<@id>` mentions that `parse`/`users`
  allow, plus the replied-to author when `replied_user` is true. The list is
  what rides the create's wire as `mention_user_ids`, so every notification
  path (the inbox leg, the push policy) reads the same answer.
  """
  @spec user_ids(t() | nil, String.t() | nil, integer() | nil) :: [integer()] | nil
  def user_ids(nil, _content, _reply_author_id), do: nil

  def user_ids(%{} = allowed, content, reply_author_id) do
    in_content = Mentions.user_ids(content)

    from_content =
      if "users" in allowed.parse,
        do: in_content,
        else: Enum.filter(in_content, &(&1 in allowed.users))

    if allowed.replied_user and is_integer(reply_author_id),
      do: Enum.uniq(from_content ++ [reply_author_id]),
      else: from_content
  end

  @doc """
  Whether `user_id` may be notified by this message: `true` with no
  restriction (`nil`), else membership of the allowed list.
  """
  @spec notifies?([integer()] | nil, integer()) :: boolean()
  def notifies?(nil, _user_id), do: true
  def notifies?(allowed, user_id) when is_list(allowed), do: user_id in allowed

  # -- validation ------------------------------------------------------------------

  defp kinds(list) when is_list(list) do
    if Enum.all?(list, &(&1 in @kinds)), do: {:ok, Enum.uniq(list)}, else: :error
  end

  defp kinds(_), do: :error

  defp ids(list) when is_list(list) and length(list) <= @max_ids do
    Enum.reduce_while(list, {:ok, []}, fn raw, {:ok, acc} ->
      case id(raw) do
        {:ok, id} -> {:cont, {:ok, [id | acc]}}
        :error -> {:halt, :error}
      end
    end)
    |> case do
      {:ok, acc} -> {:ok, acc |> Enum.reverse() |> Enum.uniq()}
      :error -> :error
    end
  end

  defp ids(_), do: :error

  # Discord sends snowflakes as strings; a JSON number is accepted too, as the
  # nonce is.
  defp id(value) when is_integer(value) and value > 0, do: {:ok, value}

  defp id(value) when is_binary(value) do
    case Integer.parse(value) do
      {int, ""} when int > 0 -> {:ok, int}
      _ -> :error
    end
  end

  defp id(_), do: :error

  defp replied_user(value) when is_boolean(value), do: {:ok, value}
  defp replied_user(nil), do: {:ok, false}
  defp replied_user(_), do: :error
end
