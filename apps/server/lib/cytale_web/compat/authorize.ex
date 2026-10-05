defmodule CytaleWeb.Compat.Authorize do
  @moduledoc """
  The compat channel gate (bots plan U6): ONE anti-enumeration seam shared
  by the compat channel/message controllers. `channel_gate/2` loads the
  channel, resolves the principal's effective bits through
  `Cytale.Permissions.Principal.resolve/3` (parent fallback + action mask +
  channel allowlist — restrictions apply, R1), and classifies EVERY miss as
  the same `{:error, :unknown_channel}`:

    * no channel row,
    * unknown workspace / non-member parent (no membership oracle),
    * out-of-profile restrictions (allowlist miss),
    * effective bits without VIEW_CHANNEL (it cannot see the channel, so it
      must not learn it exists).

  The caller renders the identical 10003 body for missing and forbidden —
  the anti-enumeration pin. Action bits beyond the view gate are checked by
  each route (`read_message_history`, `send_messages`) against the returned
  bitfield; a visible-but-not-permitted action is a real 403 50001.

  DM channels (bots plan B-1): an id with no workspace-channel row resolves
  through `dm_channels` instead, and PARTICIPATION IS AUTHORIZATION (Discord's
  DM rule — a recipient can send/read/react). A participant gates with the
  FULL bitfield; restrictions deliberately DO NOT apply (a channel-allowlist
  is a workspace-scoped concept and a DM has no workspace — a restricted
  agent can still DM its parent, Discord parity, documented in compat.md).
  A non-participant gets the identical `{:error, :unknown_channel}` (it must
  not learn the DM exists). The returned row for a DM carries
  `type: :dm` + `user_ids` — the codec renders Discord's DM channel object.
  """

  alias Cytale.Permissions.Principal
  alias Cytale.Permissions.Bitfield
  alias Cytale.Workspaces

  @type gate :: {:ok, map(), Bitfield.t()} | {:error, :unknown_channel}

  @doc """
  Gate `claims` on `channel_id`. Returns `{:ok, channel, bits}` (the channel
  row plus the principal's effective bits — the caller applies its action
  bit) or `{:error, :unknown_channel}` for every miss above.
  """
  @spec channel_gate(map(), integer()) :: gate()
  def channel_gate(claims, channel_id) when is_integer(channel_id) do
    case Workspaces.get_channel(channel_id) do
      nil ->
        dm_gate(claims, channel_id)

      %{workspace_id: workspace_id} = channel ->
        # The epoch-versioned memo (review #19) — humans hit it, machine
        # principals resolve fresh against their current access document.
        case Principal.resolve_cached(workspace_id, claims, channel_id) do
          {:ok, bits} ->
            if Bitfield.has?(bits, :view_channel),
              do: {:ok, channel, bits},
              else: {:error, :unknown_channel}

          {:error, _} ->
            {:error, :unknown_channel}
        end
    end
  end

  defp dm_gate(claims, channel_id) do
    case Workspaces.get_dm(channel_id) do
      nil ->
        {:error, :unknown_channel}

      dm ->
        # Participation is authorization for a person; a machine principal
        # additionally needs its access document's DM grant (`dm_bits/1`) —
        # without VIEW the DM does not exist for it.
        with true <- Workspaces.dm_participant?(dm, claims.user_id),
             bits = Principal.dm_bits(claims),
             true <- Bitfield.has?(bits, :view_channel) do
          {:ok, dm_channel_row(dm), bits}
        else
          _ -> {:error, :unknown_channel}
        end
    end
  end

  @doc """
  May `claims` ARCHIVE `thread`, holding the parent channel's effective `bits`
  (#109)? One definition because both surfaces serve the same mutation — the
  native `PATCH /threads/:id` and the compat `PATCH /channels/:id` Discord
  clients use.

  The thread's creator, or a moderator. Two bits qualify: `manage_messages`
  (the owner's decision for #109) and `manage_threads` (Discord's own bit for
  archiving a thread, and the one the compat thread-DELETE route already
  tests). Accepting only the first would let a moderator DELETE a thread they
  may not ARCHIVE — delete is the stronger act, so its permission set must be
  the subset. Neither bit is in the @everyone base, so the union cannot widen
  membership.
  """
  @spec may_archive_thread?(map(), map(), Bitfield.t()) :: boolean()
  def may_archive_thread?(claims, thread, bits) do
    thread.created_by == claims.user_id or
      Bitfield.has?(bits, :manage_messages) or
      Bitfield.has?(bits, :manage_threads)
  end

  @doc """
  Resolve an id that is EITHER a channel or a thread to its STORAGE scope
  (hardening plan 3.7).

  A channel id gates as itself; a non-channel id gets the thread fallback — the
  gate anchors on the PARENT, because thread visibility rides the parent's rights
  — so every miss still renders the identical refusal and a thread never leaks
  existence. `{:ok, scope, bits}` where `scope` is the parent's partition when the
  id was a thread, the channel id otherwise; `{:error, :unknown_channel}` when
  neither matched.

  `Compat.MessagesController.message_scope/2` and
  `Compat.ReactionsController.reaction_scope/2` were byte-identical copies of
  this; both now call it. The two resolvers that stay local are the ones with a
  DIFFERENT result shape, not a different rule: `MessagesController.write_scope/2`
  also returns the gate's channel row, and `ChannelsController.typing_scope/3`
  returns the thread id the typing event must carry.
  """
  @spec scope(map() | integer(), integer()) ::
          {:ok, integer(), non_neg_integer()} | {:error, :unknown_channel}
  def scope(claims, channel_id) when is_integer(channel_id) do
    case channel_gate(claims, channel_id) do
      {:ok, _channel, bits} ->
        {:ok, channel_id, bits}

      {:error, _} ->
        with %{} = thread <- Cytale.Threads.Thread.get(channel_id),
             {:ok, _parent, bits} <- channel_gate(claims, thread.channel_id) do
          {:ok, thread.channel_id, bits}
        else
          _ -> {:error, :unknown_channel}
        end
    end
  end

  @doc """
  The DM row shaped like a channel row (the codec's `channel/1` branches on
  `type: :dm` and renders the Discord DM channel object).

  Public because it is the ONE definition (hardening plan 3.12): the compat DM
  controller carried a byte-identical private copy as `dm_row/1`, so a change to
  the DM shape had two places to land and only one of them was on the resolve
  path the tests exercise.
  """
  @spec dm_channel_row(map()) :: map()
  def dm_channel_row(dm) do
    %{
      channel_id: dm.channel_id,
      workspace_id: nil,
      name: nil,
      type: :dm,
      user_ids: dm.user_ids,
      created_at: dm.created_at,
      last_message_id: dm.last_message_id
    }
  end
end
