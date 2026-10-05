defmodule CytaleWeb.Plugs.Auth do
  @moduledoc """
  U9 — Bearer-token authentication plug.

  U2 (bots plan): besides `Authorization: Bearer <JWT>`, the plug accepts
  static machine credentials via `Cytale.Accounts.Principals.get_by_token/1`
  (SHA-256 hash lookup; revocation is row delete) under BOTH schemes:

    * `Authorization: Bearer cytbot_…`
    * `Authorization: Bot cytbot_…`

  The `Bot` scheme accepts `cytbot_` tokens only — `Bot <JWT>` (or anything
  else) is a 401, never a silent fallback to the human path.

  `conn.assigns.current_user` shapes:

    * human — the verified JWT claims `%{user_id, username, verified}`
      byte-identical (R2: existing keys/values never change), grown with
      `kind: :human`, `parent_user_id: nil`, `restrictions: nil`,
      `access: nil` (only machine principals carry an access document);
    * machine — `%{user_id, username: label (kind-name fallback), verified:
      true, kind, parent_user_id, restrictions, access}` — `verified: true` because
      machine principals have no email to verify (RequireVerified's
      `%{verified: true}` shape-match passes).

  Failures are a uniform 401 with the `unauthorized` error envelope; the
  response never distinguishes a missing header from a bad/expired/revoked
  token (no oracle for token states).

  U2 (terminal plan, R13a): a human token also carries the account's
  **credential epoch**, and this plug refuses a token whose epoch is behind the
  account's current one — that is what makes a password reset or a
  revoke-all-sessions take effect on a live access token rather than at its
  expiry. A token with NO epoch claim (minted before the claim existed) is
  accepted on purpose: fail-open at authentication, fail-closed at mint (see
  `Cytale.Accounts.Auth.epoch_current?/2`).

  Cost, stated plainly: honouring the epoch adds ONE `users` row read per
  authenticated request that carries an epoch claim. This plug performed no
  user-row read before; the read buys a revocation path that reaches a live
  session within one request instead of one token lifetime. Claim-less tokens
  read nothing. Machine credentials (`cytbot_`) do not carry an epoch and are
  unaffected — their revocation is a row delete that already takes effect on
  the next use.
  """

  @behaviour Plug

  import Plug.Conn

  alias Cytale.Accounts.{Auth, Principals}

  @bot_token_prefix "cytbot_"

  @impl true
  def init(opts), do: opts

  @impl true
  def call(conn, _opts) do
    case resolve(conn) do
      {:ok, claims} ->
        assign(conn, :current_user, claims)

      :error ->
        conn
        |> put_resp_content_type("application/json")
        |> send_resp(401, Jason.encode!(error_envelope()))
        |> halt()
    end
  end

  @doc """
  Resolve the request's credential to claims WITHOUT responding.

  `{:ok, claims}` for a valid human JWT or machine credential; `:error` for a
  missing, malformed, expired or revoked one — with no oracle about which, the
  same uniform answer `call/2` renders as a 401.

  `call/2` is the GATE built on this (identity required); `#88`'s
  `CytaleWeb.Plugs.OptionalAuth` is the OBSERVER built on it (identity
  welcome, absence tolerated). One resolution rule, two postures — so a change
  to what counts as a valid credential cannot drift between them.
  """
  @spec resolve(Plug.Conn.t()) :: {:ok, map()} | :error
  def resolve(conn) do
    with [header] <- get_req_header(conn, "authorization") |> Enum.take(1),
         {:ok, claims} <- authorize(header) do
      {:ok, claims}
    else
      _ -> :error
    end
  end

  defp authorize("Bearer " <> token) do
    if String.starts_with?(token, @bot_token_prefix),
      do: machine_claims(token),
      else: human_claims(token)
  end

  # Bot scheme is machine-credential-only: a JWT (or any non-cytbot_ value)
  # inside it is a 401 — never a fallback to the human path.
  defp authorize("Bot " <> token) do
    if String.starts_with?(token, @bot_token_prefix),
      do: machine_claims(token),
      else: {:error, :unauthorized}
  end

  defp authorize(_), do: {:error, :unauthorized}

  defp human_claims(token) do
    with {:ok, claims} <- Auth.verify_access_token(token),
         :ok <- Auth.check_epoch(claims),
         # A JWT is a HUMAN credential; one naming a machine principal is a 401.
         :ok <- Auth.check_human_subject(claims) do
      # Existing keys win the merge — the growth is additive only.
      {:ok, Map.merge(%{kind: :human, parent_user_id: nil, restrictions: nil, access: nil}, claims)}
    end
  end

  defp machine_claims(token) do
    case Principals.get_by_token(token) do
      nil -> {:error, :unauthorized}
      # ONE machine-claims shape (R2): the same map BotAuth and the
      # interactions callback path assign.
      principal -> {:ok, Principals.claims(principal)}
    end
  end

  defp error_envelope do
    %{
      "error" => %{
        "key" => "unauthorized",
        "code" => 40_001,
        "message" => "Missing, malformed, or expired credentials."
      }
    }
  end
end
