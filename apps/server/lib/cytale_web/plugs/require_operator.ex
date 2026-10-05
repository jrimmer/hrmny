defmodule CytaleWeb.Plugs.RequireOperator do
  @moduledoc """
  The platform-operator gate (#33): the `/api/v1/admin/*` tier is an
  OPERATOR surface, not a permission-bit surface. The U7 stack is
  workspace-scoped end to end — there is no platform-level identity plane
  in the bitfield, and two of the admin routes carry no workspace_id to
  evaluate against — so the gate is an env allowlist, NOT a permission bit:

      CYTALE_ADMIN_USER_IDS=101,102   (comma-separated snowflakes, runtime.exs)

  **Fail-closed**: an unset/empty allowlist denies EVERY account (403),
  including owners and operators — a deploy must name its operators
  explicitly. Operators are TRUSTED: the check subsumes the verification
  gate on this surface (an allowlisted-but-unverified operator passes; U9's
  "verification first" ordering exists to keep unverified accounts from
  learning permission state, which an explicit operator allowlist already
  vouches for). Unauthenticated requests are the Auth plug's 401; this plug
  additionally fails closed on their absence (pipeline misconfig guard).

  Forward-compat (#20): the plug is the seam — a real operator identity
  (table/role + bootstrap) swaps the allowlist behind this module without
  touching routes or handlers.
  """

  @behaviour Plug

  import Plug.Conn

  @impl true
  def init(opts), do: opts

  @impl true
  def call(%{assigns: %{current_user: %{user_id: user_id}}} = conn, _opts) do
    if user_id in operator_ids(), do: conn, else: halt_forbidden(conn)
  end

  # No claims (Auth should have 401'd; guard against pipeline misconfig).
  def call(conn, _opts), do: halt_forbidden(conn)

  @doc """
  The configured operator snowflakes (empty → deny everyone): the config
  file's `operator_user_ids` PLUS the ones `CYTALE_ADMIN_USER_IDS` names (#170).

  The first boot writes the file from the environment and the file wins from
  then on, so on its own it froze the operator list as it stood before any
  account existed: a new install could never name its first operator through
  `.env`. The environment therefore always ADDS operators (kept apart from the
  file's list in `:env_operator_user_ids`, runtime.exs); it never removes one
  the file names.
  """
  @spec operator_ids() :: [integer()]
  def operator_ids do
    Enum.uniq(id_list(:operator_user_ids) ++ id_list(:env_operator_user_ids))
  end

  # Always a list: `@me` and every token-pair response ask `id in
  # operator_ids()`, so a key present-but-nil (the default only covers an
  # ABSENT key — a test restore wrote one back as nil, and a hand-edited
  # config could do the same) would 500 login, refresh and @me alike.
  defp id_list(key) do
    case Application.get_env(:cytale, key, []) do
      ids when is_list(ids) -> ids
      _ -> []
    end
  end

  defp halt_forbidden(conn) do
    conn
    |> put_resp_content_type("application/json")
    |> send_resp(403, Jason.encode!(error_envelope()))
    |> halt()
  end

  defp error_envelope do
    %{"error" => %{"key" => "forbidden", "code" => 40_003, "message" => "Request denied."}}
  end
end
