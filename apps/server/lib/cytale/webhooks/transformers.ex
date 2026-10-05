defmodule Cytale.Webhooks.Transformers do
  @moduledoc """
  Payload transformers for the `/slack` and `/github` execute routes (bots
  plan U11, R12): foreign body shapes → the ONE webhook-execute payload shape
  (`%{content, username, avatar_url, embeds}` — what `Cytale.Webhooks.execute/3`
  consumes). Pure functions over decoded JSON; every output is sized to pass
  the native validation (content ≤ 4000 bytes, embeds within the U10 caps).

  Divergence note (documented in docs/protocol/compat.md): the Slack route
  accepts a JSON body `{"text": ...}` — Slack's own form-encoded
  `payload=<json>` envelope is not parsed (the endpoint's parser set is
  JSON-only by design).
  """

  @max_content_bytes 4_000

  # Conservative embed truncation budget (each embed must stay ≤ 8 KB
  # serialized — U10 caps; these bounds keep a hostile event far below).
  @max_title 250
  @max_description 4_000
  @max_field_value 500

  # ---------------------------------------------------------------------------
  # Slack
  # ---------------------------------------------------------------------------

  @doc """
  Slack-compat body → execute payload. `{"text": ...}` is the content
  (required); an optional `username` rides as the per-message override —
  Discord parity: this route's wait defaults TRUE upstream (controller).
  """
  @spec slack(map()) ::
          {:ok, %{content: String.t(), username: term(), avatar_url: nil, embeds: []}}
          | {:error, :invalid_body}
  def slack(%{"text" => text} = body) when is_binary(text) and text != "" do
    {:ok,
     %{
       content: truncate_bytes(text, @max_content_bytes),
       username: text_username(body["username"]),
       avatar_url: nil,
       embeds: []
     }}
  end

  def slack(_), do: {:error, :invalid_body}

  # ---------------------------------------------------------------------------
  # GitHub
  # ---------------------------------------------------------------------------

  @doc """
  GitHub event JSON (`X-GitHub-Event` header value + decoded body) → execute
  payload: a readable content line plus an embed card (U10 embeds) for the
  covered events — `push`, `pull_request`, `issues`. Every other event renders
  a generic "event received" content (no card). Missing/odd fields degrade to
  placeholders, never errors — GitHub's payload zoo must not 400 the hook.

  TOTAL guards (B6e): HOSTILE JSON must never raise either — every field
  the builders touch coerces through `bin/2` (non-binary → placeholder),
  `truncate/2` is total, and a non-binary `url` degrades to nil. The
  property test feeds random shapes at every builder.
  """
  @spec github(map(), String.t() | nil) ::
          {:ok, %{content: String.t(), username: nil, avatar_url: nil, embeds: [map()]}}
  def github(body, event) when is_map(body) do
    case event do
      "push" -> push_event(body)
      "pull_request" -> pull_request_event(body)
      "issues" -> issues_event(body)
      _ -> {:ok, generic_event(body, event)}
    end
  end

  defp push_event(body) do
    repo = repo_name(body)
    pusher = bin(get_in(body, ["pusher", "name"]), "someone")
    branch = short_ref(body["ref"])
    commits = commits_of(body)
    n = length(commits)

    summary =
      "[#{repo}] #{pusher} pushed #{n} #{count_word(n, "commit")} to #{branch}: " <>
        commit_headline(commits)

    embed = %{
      "title" => truncate("[#{repo}] #{n} new #{count_word(n, "commit")} to #{branch}", @max_title),
      "description" => commit_lines(commits),
      "url" => url_or_nil(body["compare"]),
      "fields" => [
        %{"name" => "Pusher", "value" => truncate(pusher, @max_field_value)}
      ]
    }

    {:ok, %{content: truncate_bytes(summary, @max_content_bytes), username: nil, avatar_url: nil, embeds: [embed]}}
  end

  # pull_request/issues render the SAME card shape — one numbered_event
  # builder (object key, content label, embed-title label are the only
  # deltas); outputs are byte-identical to the former pair.
  defp pull_request_event(body),
    do: numbered_event(body, "pull_request", "pull request", "PR")

  defp issues_event(body),
    do: numbered_event(body, "issue", "issue", "Issue")

  defp numbered_event(body, object_key, content_label, title_label) do
    action = bin(body["action"], "updated")
    repo = repo_name(body)
    object = body[object_key] || %{}
    number = bin(object["number"], "?")
    title = bin(object["title"], "untitled")
    login = bin(get_in(object, ["user", "login"]), "unknown")
    url = url_or_nil(object["html_url"])

    content = "[#{repo}] #{content_label} ##{number} #{action}: #{title} (by #{login})"

    embed = %{
      "title" => truncate("#{title_label} ##{number} #{action}: #{title}", @max_title),
      "url" => url,
      "description" => truncate(bin(object["body"], ""), @max_description),
      "fields" => [
        %{"name" => "Author", "value" => truncate(login, @max_field_value)},
        %{"name" => "Repository", "value" => truncate(repo, @max_field_value)}
      ]
    }

    {:ok, %{content: truncate_bytes(content, @max_content_bytes), username: nil, avatar_url: nil, embeds: [embed]}}
  end

  defp generic_event(_body, event) do
    label = if is_binary(event) and event != "", do: event, else: "unlabeled"
    %{content: "GitHub #{label} event received", username: nil, avatar_url: nil, embeds: []}
  end

  # -- GitHub field helpers ------------------------------------------------------

  # Total guards (B6e): hostile JSON never raises — non-scalar fields
  # degrade to placeholders; numbers coerce (GitHub carries ids/numbers as
  # JSON numbers); a non-binary url degrades to nil (Discord's embed url is
  # a string or absent, never an object/array).
  defp bin(value, _placeholder) when is_binary(value) and value != "", do: value
  defp bin(value, _placeholder) when is_integer(value) or is_float(value), do: to_string(value)
  defp bin(_value, placeholder) when is_binary(placeholder), do: placeholder

  defp url_or_nil(url) when is_binary(url) and url != "", do: url
  defp url_or_nil(_), do: nil

  defp repo_name(body) do
    case body do
      %{"repository" => %{"full_name" => full_name}} when is_binary(full_name) -> full_name
      _ -> "unknown repository"
    end
  end

  defp short_ref("refs/heads/" <> branch), do: branch
  defp short_ref("refs/tags/" <> tag), do: tag
  defp short_ref(other) when is_binary(other), do: other
  defp short_ref(_), do: "unknown ref"

  defp commits_of(body) do
    case body do
      %{"commits" => list} when is_list(list) -> Enum.filter(list, &is_map/1)
      _ -> []
    end
  end

  defp commit_headline([]), do: "no commit details"
  defp commit_headline([first | _]), do: commit_summary(first)

  defp commit_lines([]), do: "(no commit details in payload)"

  defp commit_lines(commits) do
    commits
    |> Enum.take(10)
    |> Enum.map(fn commit -> "- #{commit_summary(commit)}" end)
    |> Enum.join("\n")
    |> truncate(@max_description)
  end

  defp commit_summary(commit) do
    sha = bin(commit["id"] || commit["sha"], "0000000")
    message = first_line(bin(commit["message"], ""))
    "#{String.slice(sha, 0, 7)}: #{message}"
  end

  defp first_line(message), do: message |> String.split("\n") |> hd() |> String.trim()

  defp count_word(1, word), do: word
  defp count_word(_n, word), do: word <> "s"

  # -- truncation ------------------------------------------------------------------

  defp truncate(text, max) when is_binary(text) do
    if String.length(text) <= max, do: text, else: String.slice(text, 0, max - 1) <> "…"
  end

  # Total (B6e): any non-binary value (hostile JSON) renders as the empty
  # placeholder rather than FunctionClauseError-ing.
  defp truncate(_other, _max), do: ""

  # Byte-budget slice for content (the 1–4000 byte cap is byte-native).
  defp truncate_bytes(text, max_bytes) when is_binary(text) do
    if byte_size(text) <= max_bytes, do: text, else: byte_slice(text, max_bytes)
  end

  # Cut on a codepoint boundary at or below the budget (a naive binary_part
  # can split a multi-byte UTF-8 codepoint and produce an invalid string).
  defp byte_slice(text, max_bytes) do
    drop_invalid(min(byte_size(text), max_bytes), text)
  end

  defp drop_invalid(0, _text), do: ""

  defp drop_invalid(n, text) do
    slice = binary_part(text, 0, n)
    if String.valid?(slice), do: slice, else: drop_invalid(n - 1, text)
  end

  # Slack's optional username override: pass through only a usable binary.
  defp text_username(username) when is_binary(username) and username != "", do: username
  defp text_username(_), do: nil
end
