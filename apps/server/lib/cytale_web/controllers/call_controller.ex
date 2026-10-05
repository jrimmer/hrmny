defmodule CytaleWeb.CallController do
  @moduledoc """
  Calls plan U4 — the durable call surface (GET /channels/:id/call, the
  U1-documented REST shape): the standing call-log thread anchor, the live
  call + roster (if any), and a bounded list of recently ended calls. The
  live call comes from the room registry (never Scylla, KTD4); the ended
  list from the `calls` rows.

  Gated on the uniform channel gate (the resolver's VIEW_CHANNEL, DM
  participation) with the identical 404 anti-enumeration shape the other
  channel-scoped routes render — never a 403 oracle. START_CALL is NOT
  required to read.

  PATCH /channels/:id/call-notification-mute — the ring notification-mute
  set/clear (AM6's durable per-user-per-channel setting; the CALL_RING
  delivery excludes muted members).

  GET /calls/ice (voice plan U12) — the ICE-config delivery path: the
  minted TURN entry (eturnal REST-auth ephemeral credentials, valid ~1h)
  when the deploy configures TURN, else `[]` (host candidates — the
  no-TURN degradation). Principal-scoped (any authenticated caller); the
  static shared secret NEVER appears in the response — only minted pairs.
  """

  use CytaleWeb, :controller

  alias Cytale.Calls
  alias Cytale.Config
  alias Cytale.Workspaces
  alias Cytale.Workspaces.MediaSettings
  alias CytaleWeb.Compat.Authorize
  import CytaleWeb.API.Params, only: [snowflake: 1]
  import CytaleWeb.API.Error, only: [error: 4]

  @recently_ended_limit 20

  @doc "GET /channels/:channel_id/call — standing thread + live call + recently ended."
  def show(conn, %{"channel_id" => cid}) do
    with {:ok, channel_id} <- snowflake(cid),
         {:ok, channel, _bits} <- Authorize.channel_gate(conn.assigns.current_user, channel_id) do
      live = Calls.live_call(channel_id)

      # The standing-thread anchor comes from the DURABLE call_threads
      # mapping, not the live room: the documented shape (rest.md / U1)
      # returns the standing call-log thread whether or not a call is live
      # ("created on the channel's first call, reused thereafter") — U9's
      # idle-channel log surfaces hydrate from exactly this. The mapping is
      # nil for DM channels (no rows — R11) and for channels that never had
      # a call (lazily created on first start), matching the contract.
      thread_id = Calls.Log.thread_id(channel_id)

      # Calls V2 plan U8 (R17): the REQUESTER's effective media
      # capabilities for this channel — channel-override-then-master (the
      # resolver the U3 op gates consult; DM channels resolve all-true
      # because DM calls skip capability checks).
      capabilities = MediaSettings.effective_capabilities(channel.workspace_id, channel_id)

      # START_CALL resolved server-side for the REQUESTER (default-on,
      # channel-overridable): the phone affordance's canStartCall prop has
      # no client-side role data to derive from (the V1-W1 walkthrough
      # finding — the shell never passed it, so the start button was
      # invisible in the real app since V1). DMs: participation IS
      # authorization.
      dm? = Workspaces.get_dm(channel_id) != nil

      can_start =
        dm? or
          (channel.workspace_id != nil and
             Cytale.Calls.can_start_call?(channel_id, conn.assigns.current_user.user_id))

      json(conn, %{
        "thread_id" => thread_id && Integer.to_string(thread_id),
        "live" => live && live_json(live),
        "recently_ended" =>
          Calls.recently_ended_calls(channel_id, @recently_ended_limit)
          |> Enum.map(&ended_json/1),
        "capabilities" => %{
          "calls" => capabilities.calls,
          "video" => capabilities.video,
          "screenshare" => capabilities.screenshare,
          "start" => can_start and capabilities.calls
        }
      })
    else
      _ -> error(conn, 404, "channel_not_found", "No channel with that id")
    end
  end

  def show(conn, _params), do: error(conn, 400, "validation_failed", "channel_id is required")

  @doc """
  GET /calls/ice — the caller's ICE configuration for call media (U12).
  Mint-on-read: every response carries a freshly derived credential pair
  (username = unix expiry ~1h out, credential = HMAC-SHA1 of the shared
  secret) so clients fetch at call-join time, never cache across sessions.

  MEDIA MASTER SWITCH (ticket #124): with `media.enabled` off the mint
  refuses with the specific `media_disabled` envelope (403 — the
  registration_closed precedent — NOT a generic forbidden) so no client can
  obtain relay credentials on a media-off instance. TURN configured + media
  disabled is a valid state: the mint refuses regardless. The gate sits at
  this DELIVERY path, deliberately NOT inside `Cytale.Config.calls_ice_servers/0`
  — the server-side PeerConnections of calls already in progress read that
  same config for their own ICE, and the standing-call edge (a disable never
  tears down live calls) needs them to keep working until the calls run out.
  """
  def ice(conn, _params) do
    if Cytale.Config.media_enabled?() do
      json(conn, %{"ice_servers" => Config.calls_ice_servers()})
    else
      error(conn, 403, "media_disabled", "Media (calls, video, and screen share) is disabled on this server.")
    end
  end

  @doc """
  PATCH /channels/:channel_id/call-notification-mute — set (`{"muted": true}`)
  or clear (`{"muted": false}`) the caller's ring mute for the channel (AM6,
  durable across restarts). Gated on the same channel gate (view access;
  DM participation) — membership is the requirement per the plan.
  """
  def set_notification_mute(conn, %{"channel_id" => cid} = params) do
    %{user_id: user_id} = conn.assigns.current_user

    with {:ok, channel_id} <- snowflake(cid),
         {:ok, _channel, _bits} <- Authorize.channel_gate(conn.assigns.current_user, channel_id) do
      case params["muted"] do
        muted? when is_boolean(muted?) ->
          :ok = Calls.set_notification_mute(user_id, channel_id, muted?)
          json(conn, %{"muted" => muted?})

        # A non-boolean `muted` is a validation failure, not a 404 — the
        # channel gate already ran, so no enumeration surface opens.
        _ ->
          error(conn, 400, "validation_failed", "muted must be a boolean")
      end
    else
      _ -> error(conn, 404, "channel_not_found", "No channel with that id")
    end
  end

  def set_notification_mute(conn, _params), do: error(conn, 400, "validation_failed", "muted is required")

  # -- shapes ------------------------------------------------------------------

  defp live_json(snapshot) do
    %{
      "call_id" => Integer.to_string(snapshot.call_id),
      "started_by" => Integer.to_string(snapshot.started_by),
      "started_at" => DateTime.to_iso8601(snapshot.started_at),
      # The SHARED roster builder, not a hand-rolled three-field map
      # (hardening plan 6.5): the REST read used to drop `sources`, the V2
      # published-source list the CALL_SYNC dispatch carries, so a REST consumer
      # could not tell that a participant was on camera or sharing their screen.
      "participants" => Enum.map(snapshot.participants, &Cytale.Calls.Events.roster_entry/1)
    }
  end

  defp ended_json(call) do
    %{
      "call_id" => Integer.to_string(call.call_id),
      "started_by" => Integer.to_string(call.started_by),
      "started_at" => DateTime.to_iso8601(call.started_at),
      "ended_at" => DateTime.to_iso8601(call.ended_at),
      "reason" => call.ended_reason
    }
  end
end
