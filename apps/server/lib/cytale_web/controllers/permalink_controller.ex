defmodule CytaleWeb.PermalinkController do
  @moduledoc """
  The two ends of an opaque permalink (#118, option B):

    * `POST /api/v1/permalinks` `{channel_id, message_id}` → `{token, url}` —
      "Copy Link" calls this and puts `url` on the clipboard;
    * `GET /api/v1/permalinks/{token}` → `{channel_id, message_id}` — the SPA
      calls this when a visitor opens `/m/{token}`.

  Both ends are API calls because the token is keyed server-side: a client
  cannot decode one, and that is the point (see `Cytale.Permalinks` — the same
  module documents the encoding, the key, and why rotation is break-glass).

  ## The gate is the CHANNEL's, and it is the one every read uses

  `CytaleWeb.Compat.Authorize.channel_gate/2` — view rights through the
  resolver + restrictions for a workspace channel, participation for a DM,
  the parent channel for a thread reply. Both actions run it, so neither can be
  turned into a way to discover that a channel exists: a stranger minting
  against somebody else's channel and a stranger resolving a token for it get
  the same answer as a channel that was never created.

  ## Every miss on the resolve route is ONE body

  Unknown token, malformed token, a token whose tag does not match (tampered),
  a channel that does not exist, and a channel the caller may not see all
  render `permalink_not_found` byte-for-byte. That mirrors the #114 resolver
  (`MessageController.show/2`), and it is the property that keeps this route
  from being an existence oracle: a body (or a status) that distinguished them
  would tell a stranger which guesses were closer. The equality, not the status
  code, is what the suite asserts.

  Opacity is NOT authorization — a token is unguessable, but whoever you forward
  it to is checked against the channel exactly as if they had typed the id.

  ## Why mint does not check that the message exists

  The gate is the channel, and the message id is not verified against it. The
  only caller is Copy Link, on a message the user is looking at; a minted token
  for a message that is gone or never existed simply fails closed at resolve
  (the same 404 as everything else). Adding the read would buy nothing and
  would make this route an oracle for message ids inside a channel the caller
  can already read.

  ## No table, no expiry, no revocation

  Deliberate: decoded straight from the key, with nothing stored. Revocation,
  expiry, click counting and truly random codes are **#119**, which exists for
  exactly what this design cannot do. Do not add a token table here.
  """

  use CytaleWeb, :controller

  alias Cytale.Permalinks
  alias CytaleWeb.Compat.Authorize
  alias CytaleWeb.ExternalUrl
  import CytaleWeb.API.Params, only: [snowflake: 1]
  import CytaleWeb.API.Error, only: [error: 4]

  @doc """
  `POST /api/v1/permalinks` — mint the opaque link for a message.

  Member-gated on the channel BEFORE anything is minted, so the route cannot be
  used to probe for channels; the ids are validated first (a malformed body is
  a 400 for anyone, which discloses nothing).
  """
  def create(conn, params) do
    with {:ok, channel_id} <- snowflake(params["channel_id"]),
         {:ok, message_id} <- snowflake(params["message_id"]),
         {:ok, _channel, _bits} <- Authorize.channel_gate(conn.assigns.current_user, channel_id),
         {:ok, token} <- Permalinks.mint(channel_id, message_id) do
      # `url` is built from the deployment's public origin (`external_base_url`
      # when configured, the request otherwise) so a non-browser consumer — the
      # mobile client, a bot — gets a link it did not have to assemble. The web
      # client builds its own from `permalinkOrigin()` (it is the one surface
      # that knows about the packaged shell's `tauri://localhost`), and both
      # spellings are the same URL.
      json(conn, %{"token" => token, "url" => ExternalUrl.build(conn, "/m/" <> token)})
    else
      :error -> error(conn, 400, "validation_failed", "channel_id and message_id must be ids")
      _ -> error(conn, 404, "channel_not_found", "No channel with that id")
    end
  end

  @doc """
  `GET /api/v1/permalinks/{token}` — read a token back to `(channel_id,
  message_id)`, gated on the channel it names.

  The SPA turns the pair into the ordinary `#/…message/…` route and reuses
  #114's landing from there — one decode at the edge, everything downstream
  unchanged.
  """
  def show(conn, %{"token" => token}) do
    with {:ok, {channel_id, message_id}} <- Permalinks.resolve(token),
         {:ok, _channel, _bits} <- Authorize.channel_gate(conn.assigns.current_user, channel_id) do
      json(conn, %{
        "channel_id" => Integer.to_string(channel_id),
        "message_id" => Integer.to_string(message_id)
      })
    else
      _ -> error(conn, 404, "permalink_not_found", "No such permalink")
    end
  end

  # -- helpers -------------------------------------------------------------------

  # Positive decimal snowflake → integer (the shape every controller validates;
  # the grammar itself lives in Cytale.Snowflake, this is the boundary read).
end
