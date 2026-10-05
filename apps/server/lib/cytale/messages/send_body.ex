defmodule Cytale.Messages.SendBody do
  @moduledoc """
  The COMPOSED half of a send, parsed once for every route: the text, the
  embeds and the action rows. The native routes, the compat routes and the
  webhook execute all read a request body through `parse/2`, so a bot posting
  the same body on any of them gets the same message or the same refusal —
  only the error's dialect differs, and that is the route's to render.

  ## The rules

    * **`content`** — 1–4000 bytes, required unless `embeds` ride the message
      (Discord's embed-only shape; the stored content is then `""`).
    * **`embeds`** — accepted from machine authors (bots, agents, webhooks),
      validated against the shared caps (`Cytale.Messages.validate_embeds/1`:
      a list of objects, at most 10, each at most 8 KB) and stored verbatim.
      A PERSON's embeds are refused with `:embeds_not_allowed` — see below.
    * **`components`** — accepted from machine authors under the R1 caps
      (`Cytale.Messages.validate_components/1`); a person's are ignored, as
      they always were (R1: "components ⇒ machine author" holds by
      construction, so a clickable row always has a bot to answer it).
    * **`allowed_mentions`** — Discord's object, from ANY sender: which of the
      message's mentions may notify (`Cytale.Messages.AllowedMentions`). It
      only narrows; applied where every producer converges,
      `Cytale.Messages.create_message/1`.

  ## Why a person's embeds are refused

  An embed is a card the SENDER composes: a title, a description, a link,
  colours and images, all as the sender says. On a bot's message that is its
  presentation — the message is marked as a bot's, and its author is
  accountable for the card. A person's messages get cards the other way: from
  the link itself, fetched and rendered by the server (the link-preview model,
  not built in v1), because a card a client composed could claim to be any
  page — a login screen, a news story, a document — while linking somewhere
  else. So people and bots share the same message and the same embed
  rendering, but a person's card may only ever come from what the link
  actually is. Refused loudly, not dropped: a client that sends embeds is told
  so instead of watching them vanish.
  """

  alias Cytale.Messages
  alias Cytale.Messages.AllowedMentions
  alias Cytale.Permissions.Principal

  @max_content_bytes 4_000

  @type parsed :: %{
          content: String.t(),
          embeds: [map()],
          components: [map()],
          allowed_mentions: AllowedMentions.t() | nil
        }

  @type reason ::
          :invalid_content
          | :invalid_embeds
          | :embeds_not_allowed
          | :invalid_components
          | :invalid_allowed_mentions

  @doc """
  Parse `body` (string-keyed, as decoded) for an author whose claims carry
  `kind` (`:human`, or a machine kind). Returns the attrs the send pipeline
  takes, or the first refusal.
  """
  @spec parse(map(), %{optional(:kind) => atom()}) :: {:ok, parsed()} | {:error, reason()}
  def parse(body, author) when is_map(body) do
    machine? = Principal.machine_kind?(Map.get(author, :kind))

    with {:ok, embeds} <- embeds(body["embeds"], machine?),
         {:ok, components} <- components(body["components"], machine?),
         {:ok, content} <- content(body["content"], embeds),
         {:ok, allowed_mentions} <- AllowedMentions.parse(body["allowed_mentions"]) do
      {:ok, %{content: content, embeds: embeds, components: components, allowed_mentions: allowed_mentions}}
    end
  end

  @doc """
  The content rule: 1–4000 bytes, or `""` when `embeds` is non-empty and the
  body sent none. Public for the edit path, which applies the same rule with
  no embeds.
  """
  @spec content(term(), [map()]) :: {:ok, String.t()} | {:error, :invalid_content}
  def content(content, _embeds)
      when is_binary(content) and byte_size(content) > 0 and byte_size(content) <= @max_content_bytes,
      do: {:ok, content}

  def content(content, embeds) when embeds != [] and (is_nil(content) or content == ""),
    do: {:ok, content || ""}

  def content(_, _), do: {:error, :invalid_content}

  defp embeds(nil, _machine?), do: {:ok, []}
  defp embeds([], _machine?), do: {:ok, []}
  defp embeds(_embeds, false), do: {:error, :embeds_not_allowed}

  defp embeds(list, true) do
    case Messages.validate_embeds(list) do
      :ok -> {:ok, list}
      {:error, :invalid_embeds} = err -> err
    end
  end

  # A person's components are ignored (R1's native-ignore, unchanged).
  defp components(_components, false), do: {:ok, []}
  defp components(nil, true), do: {:ok, []}

  defp components(list, true) do
    case Messages.validate_components(list) do
      :ok -> {:ok, list}
      {:error, :invalid_components} = err -> err
    end
  end
end
