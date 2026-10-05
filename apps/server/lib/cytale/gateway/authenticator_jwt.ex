defmodule Cytale.Gateway.Authenticator.JWT do
  @moduledoc """
  U9 — production gateway authenticator: verifies REST-issued access JWTs
  (same token family the Bearer header consumes) and binds the session to the
  claims' identity. View-only (unverified) accounts may CONNECT — the
  view-only gate is a content-mutation concern, not a connection concern
  (plan U8: "unverified-view-only is fine for connect").

  U2 (terminal plan, R13a): Identify is the second place the credential epoch is
  checked. A token whose epoch is behind the account's current one is refused
  here exactly as the REST auth plug refuses it, so a password reset or a
  revoke-all-sessions cannot be outlived by a socket that reconnects with a
  token minted before the reset. A token minted before the epoch claim existed
  (`epoch: nil`) is accepted — fail-open at authentication, fail-closed at mint
  (`Cytale.Accounts.Auth.epoch_current?/2`).

  Selected via `config :cytale, Cytale.Gateway.Authenticator, impl:
  Cytale.Gateway.Authenticator.JWT`. The U10-era Stub remains the default so
  gateway wire tests keep exercising the lifecycle without minting JWTs;
  integration tests select this module through the same config key.
  """

  @behaviour Cytale.Gateway.Authenticator

  alias Cytale.Accounts.Auth

  @impl true
  def verify_token(token) when is_binary(token) do
    case Auth.verify_access_token(token) do
      {:ok, %{user_id: user_id, username: username} = claims} ->
        if Auth.epoch_current?(user_id, Map.get(claims, :epoch)) and
             Auth.check_human_subject(claims) == :ok do
          {:ok, %{id: Integer.to_string(user_id), username: username}}
        else
          {:error, :invalid}
        end

      {:error, kind} ->
        {:error, kind}
    end
  end

  def verify_token(_), do: {:error, :malformed}
end
