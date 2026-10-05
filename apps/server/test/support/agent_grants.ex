defmodule Cytale.Test.AgentGrants do
  @moduledoc """
  Minting helpers for machine principals in tests (agent access model).

  A machine principal now starts with **no access**: its bits come from its
  access document, intersected with its owner's own reach. Suites whose subject
  is not permissions still need "an agent that can do normal things", so
  `mint_all/3,4` mints AND grants the whole workspace tree at `:read_write` —
  i.e. the agent may do what its owner can, everywhere — which keeps those
  tests about the thing they actually test.

  Tests that ARE about permissions should mint (`Principals.mint/4`) and then
  call `grant/2` with the exact document they mean, so the grant under test is
  visible in the test itself.
  """

  alias Cytale.Access
  alias Cytale.Accounts.Principals

  @doc """
  Mint a machine principal that may do everything its owner can, in every
  workspace (the "legacy ceiling" the old inherited-rights model implied).
  Returns the same `{:ok, principal}` shape as `Principals.mint/4`, so it is a
  drop-in at existing call sites.

  The `kind` argument is UNIFIED for agent-shaped credentials: `:agent` and
  `:bot` are one internal kind (`:bot` — the internal term; the UI's word is
  Agent), so normalizing here means every suite exercises the kind production
  actually mints. Any OTHER kind passes through untouched: a `:webhook` is a
  different thing entirely (a channel-scoped capability URL), and its identity
  is load-bearing (the codec stamps `webhook_id` off it).
  """
  @spec mint_all(integer(), atom(), String.t()) :: {:ok, map()} | {:error, term()}
  def mint_all(parent_user_id, kind, label) do
    with {:ok, principal} <- Principals.mint(parent_user_id, machine_kind(kind), label) do
      {:ok, grant_all(principal)}
    end
  end

  # `:agent` and `:bot` are one kind in production; a webhook is not.
  defp machine_kind(:agent), do: :bot
  defp machine_kind(other), do: other

  def mint_all(parent_user_id, kind, label, nil), do: mint_all(parent_user_id, kind, label)

  # COMPAT SHIM for the bulk test migration: suites written against the OLD
  # restriction policy (`%{actions: [...], channels: [...]}`) keep expressing
  # their intent, translated into the access model:
  #
  #   * actions ["post"]      → `:read_write`   (read+post was the write level)
  #   * actions ["read"]      → `:read`
  #   * actions [] / absent   → `:none`
  #   * channels []/nil       → the level applies to EVERY workspace (All)
  #   * channels [x, y]       → Custom: those channels at the level, every
  #                             other channel `:none` — the allowlist's deny
  #                             behaviour, now expressed per channel.
  #
  # Tests whose SUBJECT is permissions should mint + `grant/2` explicitly
  # instead, so the grant under test is visible in the test.
  def mint_all(parent_user_id, kind, label, %{} = policy) do
    with {:ok, principal} <- Principals.mint(parent_user_id, kind, label) do
      {:ok, grant_policy(principal, policy)}
    end
  end

  # A mint's return value carries the document as it was AT MINT TIME (the
  # all-none default), so a caller that grants afterwards must re-read the row —
  # otherwise its claims describe the pre-grant principal. Production re-reads on
  # the next authenticate; a test's helper has to do the same explicitly.
  defp reload(%{user_id: user_id, token: token}) do
    # The TAG lives on the credential's users row (the principal row carries
    # the label), and tests assert against it — carry it like the token.
    username =
      case Cytale.Accounts.User.get(user_id) do
        %{username: u} -> u
        _ -> nil
      end

    user_id |> Principals.get() |> Map.put(:token, token) |> Map.put(:username, username)
  end

  defp grant_policy(principal, policy) do
    level =
      case Map.get(policy, :actions) || Map.get(policy, "actions") do
        actions when is_list(actions) ->
          cond do
            "post" in actions -> :read_write
            "read" in actions -> :read
            true -> :none
          end

        _ ->
          :none
      end

    channel_ids =
      (Map.get(policy, :channels) || Map.get(policy, "channels") || [])
      |> Enum.map(&to_channel_id/1)
      |> Enum.reject(&is_nil/1)

    document =
      case channel_ids do
        [] ->
          %{
            version: 1,
            dms: :none,
            workspaces: %{mode: :all, level: level, grants: %{}}
          }

        ids ->
          workspace_ids = ids |> Enum.map(&workspace_of_channel/1) |> Enum.uniq() |> Enum.reject(&is_nil/1)

          grants =
            Map.new(workspace_ids, fn ws_id ->
              {ws_id, %{level: :none, channels: Map.new(ids, &{&1, level})}}
            end)

          %{
            version: 1,
            dms: :none,
            workspaces: %{mode: :custom, level: nil, grants: grants}
          }
      end

    grant(principal, document)
  end

  defp to_channel_id(id) when is_integer(id), do: id

  defp to_channel_id(id) when is_binary(id) do
    case Integer.parse(id) do
      {int, ""} -> int
      _ -> nil
    end
  end

  defp to_channel_id(_), do: nil

  defp workspace_of_channel(channel_id) do
    case Cytale.Workspaces.get_channel(channel_id) do
      %{workspace_id: ws_id} -> ws_id
      _ -> nil
    end
  end

  @doc """
  Grant every workspace at `:read_write` (dormant grants cleared). Returns the
  principal as the row NOW is — a grant is a write, so the freshly-granted
  document must be what the caller's claims describe.
  """
  @spec grant_all(map()) :: map()
  def grant_all(principal), do: grant(principal, all_access())

  @doc "The all-workspaces read_write document."
  @spec all_access() :: map()
  def all_access do
    %{
      version: 1,
      dms: :read_write,
      dm_support: :humans,
      workspaces: %{mode: :all, level: :read_write, grants: %{}}
    }
  end

  @doc "Grant a specific document (a map with the `Cytale.Access` shape), returning the reloaded principal."
  @spec grant(map(), map()) :: map()
  def grant(%{user_id: principal_id} = principal, document) do
    :ok = Principals.update_access(principal_id, document)
    reload(principal)
  end

  @doc """
  Grant per-workspace levels explicitly (Custom mode) — the shape a
  permissions test usually means. `levels` is `%{workspace_id => level}`, and
  `channels` optionally narrows individual channels.
  """
  @spec grant_workspaces(map(), %{optional(integer()) => Access.level()}, map()) :: map()
  def grant_workspaces(principal, levels, channels \\ %{}) do
    grants =
      Map.new(levels, fn {ws_id, level} ->
        {ws_id, %{level: level, channels: Map.get(channels, ws_id, %{})}}
      end)

    grant(principal, %{
      version: 1,
      dms: :none,
      workspaces: %{mode: :custom, level: nil, grants: grants}
    })
  end
end
