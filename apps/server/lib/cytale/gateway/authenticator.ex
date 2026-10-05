defmodule Cytale.Gateway.Authenticator do
  @moduledoc """
  Seam between the gateway (U10) and the auth machinery (U8).

  Identify passes the client's raw token through `verify_token/1`; whichever
  implementation is configured decides whether it admits the connection.

  U8 supplied the production human path (JWT validation against the accounts
  store); the U10-era Stub accepts a well-formed non-empty token string and
  maps it deterministically to a synthetic identity so the whole gateway
  lifecycle is exercisable end-to-end. Since U2 (bots plan) the configured
  impl is the `Principal` composite: `cytbot_` machine credentials resolve
  through the principals store, everything else routes to the human impl
  (`:human_impl` app-env key — JWT in prod/dev, Stub in test).
  """

  @typedoc """
  Authenticated identity bound to a session.

  U2 (bots plan): machine principals additionally carry `:kind`, `:parent_id`
  and `:restrictions` (parent of a machine principal is always a human;
  `restrictions: nil` = unrestricted). The keys are OPTIONAL — human-path
  implementations (including the test Stub) keep returning the bare
  `%{id, username}` map, so consumers must read them with `Map.get/2`.
  """
  @type identity :: %{
          required(:id) => String.t(),
          required(:username) => String.t(),
          optional(:kind) => :human | :bot | :agent | :webhook,
          optional(:parent_id) => integer() | nil,
          optional(:restrictions) => map() | nil
        }

  @doc """
  Verify an Identify token. Returns the bound identity on success.

  Errors are collapsed to `{:error, kind}` where kind ∈:

    * `:malformed` — not a plausible token string (never hits storage)
    * `:invalid`   — well-formed but unknown/expired/revoked
  """
  @callback verify_token(String.t()) :: {:ok, identity()} | {:error, :malformed | :invalid}

  @doc "Configured implementation module."
  @spec impl() :: module()
  def impl do
    Application.get_env(:cytale, __MODULE__, Cytale.Gateway.Authenticator.Stub)
  end

  @doc "Delegate verification to the configured implementation."
  @spec verify_token(String.t()) :: {:ok, identity()} | {:error, :malformed | :invalid}
  def verify_token(token), do: impl().verify_token(token)
end

defmodule Cytale.Gateway.Authenticator.Stub do
  @moduledoc """
  Pre-U8 stand-in: any token that merely looks like one (`cytale_` prefix,
  total length >= 16) binds to a deterministic synthetic identity. Deliberately
  strict about shape so malformed tokens still take the reject path in tests;
  swapped for real JWT verification by U8 without touching the gateway.
  """

  @behaviour Cytale.Gateway.Authenticator
  @min_length 16
  @prefix "cytale_"

  @impl true
  def verify_token(token) when is_binary(token) do
    cond do
      not String.valid?(token) ->
        {:error, :malformed}

      String.length(token) < @min_length ->
        {:error, :malformed}

      not String.starts_with?(token, @prefix) ->
        {:error, :invalid}

      true ->
        user_num = :erlang.phash2(token, 900_000) + 100_000
        {:ok, %{id: "#{user_num}", username: "user#{user_num}"}}
    end
  end

  def verify_token(_), do: {:error, :malformed}
end
