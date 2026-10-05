defmodule Cytale.Gateway.Authenticator.Principal do
  @moduledoc """
  U2 (bots plan) — the composite gateway authenticator (KTD2): credentials
  route by prefix through ONE implementation.

    * `cytbot_` — static machine credentials (R2): SHA-256 hash lookup via
      `Cytale.Accounts.Principals.get_by_token/1`; revocation is row delete.
    * everything else — the configured HUMAN implementation, byte-unmodified:
      `Application.get_env(:cytale, :human_impl, Cytale.Gateway.Authenticator.JWT)`
      (test.exs points it at the Stub so the whole gateway_case corpus keeps
      its deterministic synthetic identities).

  Configured as the top-level impl everywhere:

      config :cytale, Cytale.Gateway.Authenticator, Cytale.Gateway.Authenticator.Principal

  Machine identities grow `{kind, parent_id, restrictions}` (R1); human-path
  identities pass through EXACTLY as the human impl produced them (the test
  Stub stays byte-identical — the composite never decorates).

  Error contract (shared with the Stub): `:malformed` for implausible token
  shapes — rejected BEFORE any storage access; `:invalid` for well-formed but
  unknown/revoked credentials.
  """

  @behaviour Cytale.Gateway.Authenticator

  alias Cytale.Accounts.Principals

  @bot_prefix "cytbot_"
  # Plausibility floor shared with the Stub: below this a string is not a
  # token at all, whatever its prefix — no storage access for garbage.
  @min_length 16
  # Minted secrets carry 32 bytes of entropy (43+ base64url chars); a
  # `cytbot_` token whose secret is shorter than this is garbage shape.
  @bot_secret_min 32

  # Prod/dev default for :human_impl (test.exs overrides to the Stub).
  @human_impl_default Cytale.Gateway.Authenticator.JWT

  @doc "Configured human-path implementation (everything non-cytbot_)."
  @spec human_impl() :: module()
  def human_impl, do: Application.get_env(:cytale, :human_impl, @human_impl_default)

  @impl true
  def verify_token(token) when is_binary(token) do
    cond do
      not String.valid?(token) ->
        {:error, :malformed}

      # Same floor the Stub applies on the human path: short strings are
      # malformed for both families, so delegation stays byte-identical.
      String.length(token) < @min_length ->
        {:error, :malformed}

      String.starts_with?(token, @bot_prefix) ->
        verify_bot(token)

      true ->
        human_impl().verify_token(token)
    end
  end

  def verify_token(_), do: {:error, :malformed}

  defp verify_bot(token) do
    secret_len = String.length(token) - String.length(@bot_prefix)

    if secret_len < @bot_secret_min,
      do: {:error, :malformed},
      else: lookup_bot(token)
  end

  defp lookup_bot(token) do
    case Principals.get_by_token(token) do
      nil -> {:error, :invalid}
      principal -> {:ok, identity(principal)}
    end
  end

  # Machine identity (KTD2): id is the STRING user id (gateway identities are
  # string-keyed), username is Principals' shared label-fallback so
  # Session.new's Map.fetch!(:username) always holds.
  defp identity(principal) do
    %{
      id: Integer.to_string(principal.user_id),
      username: Principals.machine_handle(principal),
      kind: principal.kind,
      parent_id: principal.parent_user_id,
      restrictions: principal.restrictions,
      # The resolver reads THIS for a machine session's bits (principal.ex).
      access: principal.access
    }
  end
end
