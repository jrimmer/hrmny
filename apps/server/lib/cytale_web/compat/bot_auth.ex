defmodule CytaleWeb.Compat.BotAuth do
  @moduledoc """
  The compat auth scope (bots plan U6, R7): `Authorization: Bot cytbot_…`
  ONLY. Bearer credentials (JWT or `Bearer cytbot_`) and `Bot <JWT>` are a
  uniform Discord-shaped 401 — the compat prefix never serves the human
  Bearer path, and no failure distinguishes a missing header from a bad,
  expired, or revoked token (no token-state oracle; revocation is row
  delete, so the next REST call simply stops resolving).

  Machine claims byte-match the native auth plug's shape (U2, R2) — both
  assign `Principals.claims/1`, so every downstream consumer (the U3
  resolver, rosters, read-state) sees ONE claims shape across surfaces.
  """

  @behaviour Plug

  import Plug.Conn

  alias Cytale.Accounts.Principals
  alias CytaleWeb.Compat.Errors

  @bot_token_prefix "cytbot_"

  @impl true
  def init(opts), do: opts

  @impl true
  def call(conn, _opts) do
    with [header] <- get_req_header(conn, "authorization") |> Enum.take(1),
         "Bot " <> token <- header,
         true <- String.starts_with?(token, @bot_token_prefix),
         principal when principal != nil <- Principals.get_by_token(token) do
      assign(conn, :current_user, Principals.claims(principal))
    else
      _ ->
        conn |> Errors.unauthorized() |> halt()
    end
  end
end
