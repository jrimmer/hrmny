defmodule Cytale.Calls do
  @moduledoc """
  The calls context (voice plan U3) — the public surface for live-call
  lifecycle, history queries, the boot sweep, ring notification-mutes, and
  the permission gates U4's op handlers consult.

  Everything live goes through the room process (`Cytale.Calls.Room`,
  registry-enforced one-live-per-channel): the context starts/joins/leaves
  by delegating to it, and `live_call/1` reads the registry, never Scylla
  (KTD4 — live call state is ephemeral; Scylla holds only durable
  boundaries). AM16: a start that loses the one-live race resolves as a
  JOIN of the live call.

  Permission seam (KTD7/AM2): `can_start_call?/2` gates START_CALL
  (default-on via the resolve-time @everyone base);
  `can_join_call?/2` live-checks VIEW_CHANNEL. DMs are
  participation-is-authorization (the compat DM rule) — a participant can
  always start/join.

  ABOVE the permission seam sits the instance-level media master switch
  (ticket #124, `media.enabled`, default true): with it off, start/join
  refuse with `{:error, :media_disabled}` before any permission consult —
  the switch is not a per-role decision. In-progress calls run out
  naturally (never torn down by the flip); only NEW starts/joins refuse.
  """

  alias Cytale.Calls.Room
  alias Cytale.Permissions.Bitfield
  alias Cytale.Permissions.Principal
  alias Cytale.Repo
  alias Cytale.Workspaces

  @typedoc "A recently-ended `calls` row (the REST boundary-marker source)."
  @type ended_call :: %{
          call_id: integer(),
          started_by: integer(),
          started_at: DateTime.t(),
          ended_at: DateTime.t(),
          ended_reason: String.t()
        }

  # -- Live-call lifecycle -----------------------------------------------------------

  @doc """
  Start a call in `channel_id` (or JOIN the live one when it exists — AM16:
  the loser of the one-live race auto-joins, no error surface).

  `session_pid` is the caller's current gateway session process — the room
  monitors it (AM4). `opts` reach the room (`ring:` survives as the call's
  ring request for U4's once-per-call ring).

  MEDIA MASTER SWITCH (ticket #124): with `media.enabled` off this refuses
  BEFORE anything else — `{:error, :media_disabled}` — regardless of
  permissions (the switch is the instance-level gate ABOVE the
  start_call/send_video/share_screen bits). The check reads the config per
  request, so an operator's flip applies live.

  Returns `{:ok, %{action: :started | :joined, room: pid(), call_id:,
  thread_id:, leg_id:}}` — `thread_id` is nil on DM calls (R11).
  """
  @spec start_call(integer(), integer(), pid(), keyword()) ::
          {:ok,
           %{
             action: :started | :joined,
             room: pid(),
             call_id: integer(),
             thread_id: integer() | nil,
             leg_id: String.t()
           }}
          | {:error, :media_disabled | term()}
  def start_call(channel_id, user_id, session_pid, opts \\ [])
      when is_integer(channel_id) and is_integer(user_id) and is_pid(session_pid) do
    if media_disabled?() do
      {:error, :media_disabled}
    else
      case room_pid(channel_id) do
        nil ->
          case Cytale.Calls.RoomSupervisor.start_room(channel_id, user_id, opts) do
            {:ok, pid} ->
              join_result(pid, user_id, session_pid, :started)

            {:error, reason} ->
              {:error, reason}
          end

        pid ->
          join_result(pid, user_id, session_pid, :joined)
      end
    end
  end

  @doc """
  Join the channel's live call (or re-bind a session after Resume, AM4).

  MEDIA MASTER SWITCH (ticket #124): with `media.enabled` off, NEW joins
  refuse with `{:error, :media_disabled}` — but a caller who ALREADY holds a
  leg in the live call may still re-bind (the standing-call edge, the
  ticket's stated choice: a disable never tears down in-progress calls, so
  an existing participant's Resume re-bind must keep their leg alive; the
  call runs out naturally as participants leave). Gate sits here so the
  gateway ops and any direct API caller meet the same refusal.
  """
  @spec join_call(integer(), integer(), pid()) ::
          {:ok, %{room: pid(), call_id: integer(), thread_id: integer() | nil, leg_id: String.t()}}
          | {:error, :no_live_call | :cannot_view | :media_disabled}
  def join_call(channel_id, user_id, session_pid)
      when is_integer(channel_id) and is_integer(user_id) and is_pid(session_pid) do
    case room_pid(channel_id) do
      nil ->
        {:error, :no_live_call}

      pid ->
        cond do
          # A disable refuses NEW joins only — see the @doc standing-call edge.
          media_disabled?() and not Room.participant?(pid, user_id) ->
            {:error, :media_disabled}

          true ->
            join_result(pid, user_id, session_pid, nil)
        end
    end
  end

  # The per-request read of the media master switch (`Cytale.Config` digs the
  # runtime-scoped `media.enabled`; default TRUE — absent/unconfigured reads
  # as today's behavior, never as off).
  defp media_disabled?, do: not Cytale.Config.media_enabled?()

  @doc "Leave the channel's live call (no-op without a live call or membership)."
  @spec leave_call(integer(), integer()) :: :ok
  def leave_call(channel_id, user_id) when is_integer(channel_id) and is_integer(user_id) do
    case room_pid(channel_id) do
      nil -> :ok
      pid -> Room.leave(pid, user_id)
    end
  end

  @doc """
  Update the caller's voice state (`mute`/`deafen`) in the channel's live
  call; deafen implies self-mute (AM12). `{:error, :no_live_call}` without
  a live call, `{:error, :not_participant}` when the caller never joined.
  """
  @spec update_participant(integer(), integer(), map()) ::
          {:ok, map()} | {:error, :no_live_call | :not_participant}
  def update_participant(channel_id, user_id, changes) when is_map(changes) do
    case room_pid(channel_id) do
      nil ->
        {:error, :no_live_call}

      pid ->
        case Room.update_state(pid, user_id, changes) do
          {:ok, participant} -> {:ok, participant}
          {:error, :not_participant} = err -> err
        end
    end
  end

  # -- Queries ------------------------------------------------------------------------

  @doc "The channel's live call snapshot (from the registry — never Scylla), or nil."
  @spec live_call(integer()) :: Room.snapshot() | nil
  def live_call(channel_id) when is_integer(channel_id) do
    case room_pid(channel_id) do
      nil ->
        nil

      pid ->
        # The registry entry can outlive the process (an empty sweep landing
        # between the lookup and the call), so a room that dies mid-request
        # reads as no live call rather than exiting the caller.
        try do
          Room.state(pid)
        catch
          :exit, _reason -> nil
        end
    end
  end

  @doc """
  Every live room's `{channel_id, room_pid, snapshot}` (the registry walk —
  U4's CALL_SYNC backfill, Resume re-bind, and caps checks all enumerate
  live rooms this way; at single-node launch scale this is a handful of
  registry entries). Rooms that die mid-walk are skipped.
  """
  @spec live_rooms() :: [{integer(), pid(), Room.snapshot()}]
  def live_rooms do
    Cytale.Calls.RoomRegistry
    |> Registry.select([{{:"$1", :_, :_}, [], [:"$1"]}])
    |> Enum.flat_map(fn channel_id ->
      case room_pid(channel_id) do
        nil ->
          []

        pid ->
          try do
            [{channel_id, pid, Room.state(pid)}]
          catch
            :exit, _reason -> []
          end
      end
    end)
  end

  @doc """
  True when `user_id` holds a leg in the channel's live call (op 23's
  participant check — silent-drop gate, never an oracle).
  """
  @spec call_participant?(integer(), integer()) :: boolean()
  def call_participant?(channel_id, user_id)
      when is_integer(channel_id) and is_integer(user_id) do
    case room_pid(channel_id) do
      nil -> false
      pid -> Room.participant?(pid, user_id)
    end
  end

  @doc """
  U4's AM-side caps for `user_id` joining/starting a call on `channel_id`:
  the per-user concurrent voice-leg limit (2 by default — legs held in
  OTHER live calls) and the per-workspace aggregate live-PC ceiling (the
  media UDP port-range size by default). `{:error, …}` names the broken
  ceiling. Re-joining a room the user is already in displaces their own leg
  (AM8) and never trips a cap; DM calls have no workspace bucket.
  """
  @spec within_caps?(integer(), integer()) :: {:ok, :ok} | {:error, :caps_exceeded_user | :caps_exceeded_workspace}
  def within_caps?(channel_id, user_id)
      when is_integer(channel_id) and is_integer(user_id) do
    rooms = live_rooms()

    # A re-join of a room the user already legs in displaces their OWN leg
    # (AM8) — never a new leg, never a cap.
    already_here? =
      Enum.any?(rooms, fn {cid, _pid, snapshot} ->
        cid == channel_id and Enum.any?(snapshot.participants, &(&1.user_id == user_id))
      end)

    if already_here? do
      {:ok, :ok}
    else
      caps_check(rooms, channel_id, user_id)
    end
  end

  defp caps_check(rooms, channel_id, user_id) do
    other_legs =
      Enum.count(rooms, fn {cid, _pid, snapshot} ->
        cid != channel_id and Enum.any?(snapshot.participants, &(&1.user_id == user_id))
      end)

    cond do
      other_legs >= Cytale.Config.calls_per_user_leg_limit() ->
        {:error, :caps_exceeded_user}

      true ->
        # Workspace aggregate: every leg in the channel's workspace's live
        # rooms, INCLUDING this channel's current room (a fresh start counts
        # its zero current legs plus the incoming one). DMs: no bucket.
        workspace_id =
          case Workspaces.get_channel(channel_id) do
            %{workspace_id: ws_id} -> ws_id
            _ -> nil
          end

        if is_nil(workspace_id) do
          {:ok, :ok}
        else
          same_ws_legs =
            Enum.sum(
              for {_cid, _pid, snapshot} <- rooms,
                  snapshot.workspace_id == workspace_id,
                  do: length(snapshot.participants)
            )

          if same_ws_legs + 1 > Cytale.Config.calls_workspace_pc_ceiling() do
            {:error, :caps_exceeded_workspace}
          else
            {:ok, :ok}
          end
        end
    end
  end

  @doc """
  The channel's recently-ENDED calls, newest-first (bounded `limit`): the
  `GET /channels/:id/call` boundary-marker source (AM11) — the live call
  comes from `live_call/1`, the standing thread from `Cytale.Calls.Log`.
  """
  @spec recently_ended_calls(integer(), pos_integer()) :: [ended_call()]
  def recently_ended_calls(channel_id, limit \\ 20)
      when is_integer(channel_id) and is_integer(limit) and limit > 0 do
    Repo.execute!(
      "SELECT call_id, started_by, started_at, ended_at, ended_reason FROM {{K}}.calls WHERE channel_id = ? LIMIT ?",
      [{"bigint", channel_id}, {"int", limit}]
    )
    |> Enum.to_list()
    |> Enum.filter(& &1["ended_at"])
    |> Enum.map(fn r ->
      %{
        call_id: r["call_id"],
        started_by: r["started_by"],
        started_at: r["started_at"],
        ended_at: r["ended_at"],
        ended_reason: r["ended_reason"]
      }
    end)
  end

  # -- Boot / crash-recovery sweep (R8) --------------------------------------------------

  @doc """
  Close every OPEN `calls` row whose channel has no live room — the boot
  sweep (an app restart must not orphan open rows) and the crash-recovery
  backstop. Rows close with reason `swept`. DM calls never write rows, so
  there is nothing DM-shaped to sweep. Returns the number of rows closed.

  The sweep walks the `open_calls` index rather than scanning `calls`
  (hardening plan 4.13). It used to `SELECT` the whole `calls` table, which is
  partitioned by channel and never pruned, so every boot paid for the instance's
  entire call history — under a 30s timeout, at the one moment (boot) when the
  node can least afford it. Cost is now O(concurrent live calls).

  A row in the index is a CANDIDATE, not proof: it may name a call whose `calls`
  row was never written (a crash between the index write and the `calls` write),
  or one that has since ended (a crash between `end_call`'s UPDATE and its index
  delete). Both are released without touching the `calls` row — closing on the
  index alone would rewrite a genuine `last_left` as `swept`.
  """
  @spec sweep_stale() :: non_neg_integer()
  def sweep_stale do
    Repo.stream_rows!(
      "SELECT channel_id, call_id FROM {{K}}.open_calls",
      [],
      # Page-safe by construction; a sweep can lag a slow page.
      timeout: 30_000
    )
    |> Stream.reject(&room_pid(&1["channel_id"]))
    |> Enum.map(&sweep_candidate/1)
    |> Enum.count(&(&1 == :closed))
  end

  defp sweep_candidate(row) do
    channel_id = row["channel_id"]
    call_id = row["call_id"]

    # One point read per candidate. Candidates are live calls (plus the rare
    # orphaned index row), so this stays small for the same reason the index
    # does.
    case Repo.execute!(
           "SELECT ended_at FROM {{K}}.calls WHERE channel_id = ? AND call_id = ?",
           [{"bigint", channel_id}, {"bigint", call_id}]
         )
         |> Enum.to_list() do
      [%{"ended_at" => nil}] ->
        close_call(channel_id, call_id, "swept")
        mark_closed(channel_id, call_id)
        :closed

      _ ->
        # Nothing to close: no `calls` row, or one that already ended.
        mark_closed(channel_id, call_id)
        :already_closed
    end
  end

  @doc """
  Release one call's live-index row, but only if the row still names it.

  The sweep is the one caller that cannot assume ownership of the channel's index
  row: it runs at boot (`application.ex`) AFTER the endpoint starts serving, so a
  call can start on the same channel between the sweep's read and its release. An
  unconditional `DELETE ... WHERE channel_id = ?` (one row per channel) would then
  take out the NEW call's row, leaving a live call the next sweep cannot see —
  i.e. the orphaned open row this whole index exists to prevent. The LWT makes the
  release a no-op in that window; one conditional delete per swept call is the
  whole cost, on a path that runs at boot.
  """
  @spec mark_closed(integer(), integer()) :: :ok
  def mark_closed(channel_id, call_id) do
    Repo.execute!(
      "DELETE FROM {{K}}.open_calls WHERE channel_id = ? IF call_id = ?",
      [{"bigint", channel_id}, {"bigint", call_id}]
    )

    :ok
  end

  @doc """
  Record a call as LIVE in the `open_calls` index (hardening plan 4.13).

  Index FIRST, then the `calls` row: a crash between the two leaves an index row
  with no `calls` row, which the sweep releases without side effects. The reverse
  order would leave an OPEN `calls` row absent from the index — invisible to the
  sweep, i.e. the orphaned open row the sweep exists to prevent.
  """
  @spec mark_open(integer(), integer()) :: :ok
  def mark_open(channel_id, call_id) do
    Repo.execute!(
      "INSERT INTO {{K}}.open_calls (channel_id, call_id) VALUES (?, ?)",
      [{"bigint", channel_id}, {"bigint", call_id}]
    )

    :ok
  end

  @doc """
  Release a call's live-index row (idempotent).

  Unconditional by design, for the caller that OWNS the channel's call: the room
  releasing its own row at `end_call`, or a failed create giving its own back. A
  new call cannot have started while the room still holds the channel's registry
  name, so there is nothing to race — see `mark_closed/2` for the one
  caller that cannot make that assumption.
  """
  @spec mark_closed(integer()) :: :ok
  def mark_closed(channel_id) do
    Repo.execute!(
      "DELETE FROM {{K}}.open_calls WHERE channel_id = ?",
      [{"bigint", channel_id}]
    )

    :ok
  end

  defp close_call(channel_id, call_id, reason) do
    now = DateTime.utc_now() |> DateTime.truncate(:millisecond)

    Repo.execute!(
      "UPDATE {{K}}.calls SET ended_at = ?, ended_reason = ? WHERE channel_id = ? AND call_id = ?",
      [
        {"timestamp", now},
        {"text", reason},
        {"bigint", channel_id},
        {"bigint", call_id}
      ]
    )

    :ok
  end

  # -- Ring notification-mutes (AM6) ------------------------------------------------------

  @doc "True when the user muted rings for the channel (durable across restarts)."
  @spec notification_muted?(integer(), integer()) :: boolean()
  def notification_muted?(user_id, channel_id)
      when is_integer(user_id) and is_integer(channel_id) do
    rows =
      Repo.execute!(
        "SELECT channel_id FROM {{K}}.notification_mutes WHERE user_id = ? AND channel_id = ?",
        [{"bigint", user_id}, {"bigint", channel_id}]
      )
      |> Enum.to_list()

    rows != []
  end

  @doc "Set (`muted? true`, row presence) or clear the user's ring mute for the channel."
  @spec set_notification_mute(integer(), integer(), boolean()) :: :ok
  def set_notification_mute(user_id, channel_id, muted?)
      when is_integer(user_id) and is_integer(channel_id) and is_boolean(muted?) do
    if muted? do
      now = DateTime.utc_now() |> DateTime.truncate(:millisecond)

      Repo.execute!(
        "INSERT INTO {{K}}.notification_mutes (user_id, channel_id, created_at) VALUES (?, ?, ?)",
        [{"bigint", user_id}, {"bigint", channel_id}, {"timestamp", now}]
      )
    else
      Repo.execute!(
        "DELETE FROM {{K}}.notification_mutes WHERE user_id = ? AND channel_id = ?",
        [{"bigint", user_id}, {"bigint", channel_id}]
      )
    end

    :ok
  end

  # -- Permission gates (KTD7/AM2 — the seam U4's op handlers call) ------------------------

  @doc """
  May `user_id` START (and ring) a call in `channel_id`? START_CALL is
  default-on through the resolve-time @everyone base; a channel overwrite
  can deny it per-channel. DMs: participation IS authorization.
  """
  @spec can_start_call?(integer(), integer()) :: boolean()
  def can_start_call?(channel_id, user_id) do
    dm_authorized?(channel_id, user_id) or
      channel_permits?(channel_id, user_id, :start_call)
  end

  @doc """
  May `user_id` JOIN (and talk in) a call in `channel_id`? Live-checked
  VIEW_CHANNEL (AM2: join/talk ride VIEW_CHANNEL, never a snapshot). DMs:
  participation IS authorization.
  """
  @spec can_join_call?(integer(), integer()) :: boolean()
  def can_join_call?(channel_id, user_id) do
    dm_authorized?(channel_id, user_id) or
      channel_permits?(channel_id, user_id, :view_channel)
  end

  @doc """
  V2 (R13/KTD3): may `user_id` publish `source` in `channel_id`? The
  gateway consults this BEFORE the room (the twin-check doctrine);
  the room re-checks under its own serialization. SEND_VIDEO for camera,
  SHARE_SCREEN for screen and screen_audio (share-audio rides the screen
  bit — at least as sensitive, never ungated). DMs: participation IS
  authorization (no bits in DM rooms — V1 posture).
  """
  @spec can_publish_source?(integer(), integer(), :camera | :screen | :screen_audio) :: boolean()
  def can_publish_source?(channel_id, user_id, source)
      when source in [:camera, :screen, :screen_audio] do
    dm_authorized?(channel_id, user_id) or
      channel_permits?(channel_id, user_id, source_bit(source))
  end

  defp source_bit(:camera), do: :send_video
  defp source_bit(_screen_or_share_audio), do: :share_screen

  defp dm_authorized?(channel_id, user_id) do
    case Workspaces.get_dm(channel_id) do
      nil -> false
      dm -> Workspaces.dm_participant?(dm, user_id)
    end
  end

  defp channel_permits?(channel_id, user_id, permission) do
    with %{workspace_id: ws_id} <- Workspaces.get_channel(channel_id),
         {:ok, bits} <- Principal.resolve(ws_id, %{user_id: user_id}, channel_id) do
      Bitfield.has?(bits, permission)
    else
      # Unknown channel, non-member, or any resolution failure: fail closed.
      _ -> false
    end
  end

  # -- Internals ---------------------------------------------------------------------------

  @doc "The live room process for a channel (the one-live registry lookup), or nil."
  @spec room_pid(integer()) :: pid() | nil
  def room_pid(channel_id) when is_integer(channel_id) do
    case Registry.whereis_name({Cytale.Calls.RoomRegistry, channel_id}) do
      :undefined -> nil
      pid -> pid
    end
  end

  defp join_result(pid, user_id, session_pid, action) do
    case Room.join(pid, user_id, session_pid) do
      {:ok, %{call_id: call_id, thread_id: thread_id, leg_id: leg_id}} ->
        result = %{room: pid, call_id: call_id, thread_id: thread_id, leg_id: leg_id}
        {:ok, if(action, do: Map.put(result, :action, action), else: result)}

      {:error, :cannot_view} = error ->
        # The room's AM2 live re-check lost a race with a rights change (the
        # gateway checked first); surface it — never raise in the caller.
        error
    end
  end
end
