defmodule CytaleWeb.API.SelfUser do
  @moduledoc """
  The signed-in account's OWN profile, as `GET /users/@me` answers it — one
  shape for every response that hands a client "who you are".

  Boot used to be a serial chain: refresh → `/users/@me` → connect the
  gateway, and a password login paid the same extra round trip even though the
  login response already carried a `user`. That `user` was a reduced shape
  (no `is_operator`, no `display_name`/`avatar_url`, no `kind`), so a client
  could not adopt it and fetched `@me` anyway. Every token-pair response
  (login, register, refresh, passkey, SSO, the 2FA verify) now carries THIS
  shape, so the client adopts it and skips the read (lane D item #4).

  One builder on purpose: two spellings of "the current user" drift (the
  reduced payload reported the RAW verification bit while `@me` reported the
  EFFECTIVE one), and a client that trusts both reads different truths
  depending on which door it came in by.
  """

  # U4 (bots plan): @me carries `kind` always (plain "human" for the app
  # account) and `parent_user_id` (decimal string) only when the caller is a
  # sub-identity — machine credentials reading their own profile.
  # `is_operator` (#121): the client-side signal for operator-only UI (the
  # Server Settings entry under the Home gear). The ROUTES stay gated
  # server-side by RequireOperator — this flag only decides whether the
  # affordance renders; it vouches for nothing.
  @doc """
  The `@me` JSON for `user`. `claims` is the authenticated principal's
  claims map (`conn.assigns.current_user`); a token-pair response passes none,
  which reads as the human app account — every login door mints for one.
  """
  @spec json(map(), map()) :: map()
  def json(u, claims \\ %{}) do
    base = %{
      "id" => Integer.to_string(u.user_id),
      "username" => u.username,
      "email" => Map.get(u, :email),
      "email_verified" => Cytale.Config.effective_verified?(not is_nil(Map.get(u, :email_verified_at))),
      "is_operator" => u.user_id in CytaleWeb.Plugs.RequireOperator.operator_ids(),
      "display_name" => Map.get(u, :display_name),
      "avatar_url" => Map.get(u, :avatar_url),
      "created_at" => iso8601(Map.get(u, :created_at))
    }

    case {Map.get(claims, :kind), Map.get(claims, :parent_user_id)} do
      {kind, parent_id} when kind in [:bot, :agent, :webhook] and is_integer(parent_id) ->
        base
        |> Map.put("kind", Atom.to_string(kind))
        |> Map.put("parent_user_id", Integer.to_string(parent_id))

      {kind, _} when kind in [:bot, :agent, :webhook] ->
        Map.put(base, "kind", Atom.to_string(kind))

      _ ->
        Map.put(base, "kind", "human")
    end
  end

  defp iso8601(%DateTime{} = dt), do: DateTime.to_iso8601(dt)
  defp iso8601(_other), do: nil
end
