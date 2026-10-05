defmodule Cytale.Calls.Media do
  @moduledoc """
  The SFU media plane (voice plan U5, KTD1; V2 U3 adds per-source video):
  one server-side `ExWebRTC.PeerConnection` per participant, owned and
  driven entirely by the room process — this module is a pure state machine
  over the room's mailbox, never a process of its own. PCs link to the
  room (a room crash takes its PCs down; a PC crash reaches the room as a
  trapped EXIT), and every ex_webrtc notification arrives in the room's
  mailbox as `{:ex_webrtc, pc, msg}`.

  Sole-offerer negotiation (the Nexus `peer.ex` pattern the plan cites): on
  join and on every roster/source change, each affected participant's PC
  gains/loses `sendonly` transceivers — one per OTHER participant per
  ACTIVE source (`mic` always; `camera`/`screen`/`screen_audio` while
  published) — and a fresh SDP offer is pushed through the CALL_SIGNAL
  seam; the client applies offers and returns the answer via op 23. While
  a participant's offer is un-answered, further changes for them are
  deferred (queued, applied on the answer — glare safety).

  **V2 offers are wire-munged envelope-v2 bodies (the spike's GO
  constraints, research doc §"V2 spike" arm a):** the UNMUNGED offer is
  applied locally (`check_altered` refuses anything else); the copy on the
  wire splices `a=rid:f/h/q recv` + `a=simulcast:recv q;h;f` into every
  video INGEST m-line (a real browser answerer auto-populates three rid
  encodings from those attrs) and is wrapped as
  `{"v":2,"type":"offer","sdp":...,"tracks":[{mid,user_id,source,rids?}]}`
  — the track-attribution manifest (KTD1). Answers stay v1-shaped.

  Forwarding with layer selection (KTD2): RTP on P's ingest track rides
  per-source egress transceivers on every other participant. Audio-kind
  sources (mic, screen_audio) forward unconditionally (minus the deafened
  — R15: deafen stops AUDIO forwarding only; video keeps flowing). Video
  sources forward per the room-computed forward plan: the stage source
  (most-recent screen, VM3) at the `f` layer, tile cameras at `q`, within
  the viewer's `video_want.tiles` budget. **Layer switches restamp
  seq/ts per egress target** (0.17's RTPSender re-stamps only pt/ssrc and
  its Munger is dead code — the spike's constraint 2): each egress entry
  carries its own outgoing seq/ts clock so a viewer never sees a
  discontinuity when its layer changes.

  Failure: a PC reporting connection `:failed` gets ONE ICE restart; a
  second `:failed` — or a dead PC process — removes the participant with
  voice-unavailable semantics.

  Signal bodies are opaque on the wire: SDP answers/ICE as their
  `to_json/1` maps encoded; server offers as the envelope-v2 JSON above.
  """

  alias Cytale.Calls.Events
  alias ExWebRTC.{ICECandidate, MediaStreamTrack, PeerConnection, SessionDescription}

  @typedoc "A published source kind (manifest space; `mic` is never publish-typed)."
  @type source_kind :: :mic | :camera | :screen | :screen_audio

  @typedoc """
  One egress target on a viewer's leg: the outbound track carrying one
  (owner, source) stream, plus its outgoing seq/ts clock (the restamp
  state — every forwarded packet gets `next_seq`/`last_ts_out`, so layer
  switches never hand the viewer discontinuous RTP).
  """
  @type egress_entry :: %{
          track_id: integer(),
          transceiver_id: integer(),
          source: source_kind(),
          owner: integer(),
          next_seq: non_neg_integer(),
          last_ts_out: non_neg_integer(),
          ts_offset: integer()
        }

  @typedoc """
  One participant's server PC and its negotiation bookkeeping.

    * `egress` — outbound sendonly transceivers keyed `{owner, source}`
      (one per other participant per active source).
    * `ingest_mids` — ingest transceivers keyed by expected source
      (`%{source => transceiver_id}`; mids resolve at offer time).
    * `ingress` — received track ids → `{owner, source}` (ex_webrtc fires
      `{:track, t}` when the answerer attaches; attribution comes from
      the transceiver the track landed on, never m-line order).
    * `ingress_rids` — video ingest tracks that carry rids (the rid field
      arrives per-packet on `{:rtp, id, rid, pkt}`).
  """
  @type leg :: %{
          pc: pid(),
          owner: integer(),
          egress: %{{integer(), source_kind()} => egress_entry()},
          ingest_mids: %{source_kind() => integer()},
          ingress: %{integer() => {integer(), source_kind()}},
          offer_outstanding: boolean(),
          offered_at: integer() | nil,
          pending_roster: boolean(),
          ice_restarted: boolean(),
          # P1: a :failed arrived while an offer was outstanding — the
          # one-restart policy is spent but the restart offer itself is
          # deferred to the answer's glare-window close.
          restart_pending: boolean(),
          # P2: a mic-reoffer queued behind an un-answered offer — the
          # answer's flush pushes it even when the reconcile finds no
          # transceiver diff (the client needs the fresh negotiation).
          reoffer_pending: boolean()
        }

  @typedoc """
  The media plane state (owned by the room process). `sources` mirrors the
  room's published-source roster (`user => %{source => %{since}}`) so the
  manifest and egress diffs derive from the plane's own truth; `wants` is
  each viewer's latest `video_want` (`%{tiles => integer}`); `plan` is the
  cached forward plan (stage owner + camera/screen rankings) — recomputed
  at every roster/source mutation, read per packet on the forwarding hot
  path (wants never touch it: the tile budget applies at deliver time).
  """
  @type plan :: %{stage: integer() | nil, cameras: [integer()], screens: [integer()]}

  @type t :: %__MODULE__{
          legs: %{integer() => leg()},
          by_pc: %{pid() => integer()},
          sources: %{integer() => %{source_kind() => %{since: DateTime.t()}}},
          wants: %{integer() => %{tiles: non_neg_integer()}},
          plan: plan()
        }

  defstruct legs: %{}, by_pc: %{}, sources: %{}, wants: %{}, plan: %{stage: nil, cameras: [], screens: []}

  @simulcast_rids ["f", "h", "q"]

  # -- Lifecycle (room hooks) ----------------------------------------------------------

  @doc "A fresh, empty media plane."
  @spec new() :: t()
  def new, do: %__MODULE__{}

  @doc "How many server PCs are live (introspection; tests assert teardowns)."
  @spec pc_count(t()) :: non_neg_integer()
  def pc_count(%__MODULE__{legs: legs}), do: map_size(legs)

  @doc "The live published-source roster (the room's source-state truth)."
  @spec sources(t()) :: %{integer() => %{source_kind() => %{since: DateTime.t()}}}
  def sources(%__MODULE__{sources: sources}), do: sources

  @doc """
  Reconcile the PC fleet against `user_ids` — the room runs this after
  EVERY roster mutation (join, displacement, leave, grace expiry, forced
  eviction). Departed users' PCs are torn down; every remaining
  participant's egress set is diffed against the roster × sources (one
  outbound transceiver per other participant per active source), and any
  leg whose diff changed gets a fresh offer pushed — unless its previous
  offer is still un-answered (queued, applied on the answer).
  """
  @spec roster_changed(t(), integer(), [integer()]) :: t()
  def roster_changed(%__MODULE__{} = media, channel_id, user_ids) do
    media = %{media | sources: drop_departed_sources(media.sources, user_ids)}
    # The plan cache rides every sources mutation (P3 hot path: forward
    # must not re-rank per packet).
    media = %{media | plan: recompute_plan(media)}
    roster = MapSet.new(user_ids)

    media =
      Enum.reduce(media.legs, media, fn {user_id, _leg}, acc ->
        if MapSet.member?(roster, user_id), do: acc, else: teardown_leg(acc, user_id)
      end)

    Enum.reduce(user_ids, media, fn user_id, acc ->
      reconcile_leg(acc, channel_id, user_id, user_ids)
    end)
  end

  @doc """
  Publish/unpublish a source (the room's op-22 publish actions): updates
  the plane's source roster and reconciles every OTHER participant's
  egress (the publisher's own INGEST transceiver changes, everyone else's
  egress changes). Returns the updated plane; the ROOM owns the wire
  events (source-state CALL_UPDATEs) and calls this for the media effect.
  """
  @spec set_source(t(), integer(), integer(), source_kind(), boolean(), [integer()]) :: t()
  def set_source(media, user_id, channel_id, source, active?, roster)
      when source in [:camera, :screen, :screen_audio] do
    user_sources = media.sources[user_id] || %{}

    user_sources =
      if active? do
        Map.put(user_sources, source, %{since: DateTime.utc_now()})
      else
        Map.delete(user_sources, source)
      end

    sources =
      if user_sources == %{} and not Map.has_key?(media.sources, user_id) do
        media.sources
      else
        Map.put(media.sources, user_id, user_sources)
      end

    media = %{media | sources: sources}
    media = %{media | plan: recompute_plan(media)}

    # The publisher's ingest transceiver set changes -> their PC re-offers;
    # every other leg's egress set changes -> each re-offers.
    media
    |> reconcile_leg(channel_id, user_id, roster)
    |> then(fn m ->
      Enum.reduce(roster, m, fn other, acc ->
        if other == user_id, do: acc, else: reconcile_leg(acc, channel_id, other, roster)
      end)
    end)
  end

  @doc "A viewer's latest video_want (KTD7; the room passes it from op 22)."
  @spec set_want(t(), integer(), non_neg_integer()) :: t()
  def set_want(%__MODULE__{} = media, user_id, tiles) when is_integer(tiles) do
    %{media | wants: Map.put(media.wants, user_id, %{tiles: max(tiles, 0)})}
  end

  @doc """
  V2 listen-only upgrade (P2): the client just bound its mic locally and
  said so via op-22 `state` (`mic_granted: true`). The server is the SOLE
  offerer — without a fresh offer the answerer never re-attaches the mic
  to the standing ingest m-line and the upgrade stays silent. If an offer
  is outstanding the re-offer queues behind it (`reoffer_pending`: the
  answer's flush pushes it even without a transceiver diff); otherwise a
  no-diff re-offer is pushed unconditionally — safe, the glare guard
  governs. No-op for a user without a leg.
  """
  @spec reoffer_leg(t(), integer(), integer()) :: t()
  def reoffer_leg(%__MODULE__{} = media, channel_id, user_id) do
    case media.legs do
      %{^user_id => leg} ->
        if leg.offer_outstanding do
          put_leg(media, user_id, %{leg | pending_roster: true, reoffer_pending: true})
        else
          put_leg(media, user_id, push_offer(channel_id, user_id, leg, media))
        end

      _ ->
        media
    end
  end

  @doc """
  Drop `user_id`'s PC outright — the AM8 displacement path (a second
  device's join replaces the leg; the roster sync that follows builds a
  brand-new PC for the fresh negotiation). The user's published sources
  go with it: the old leg's tracks are dead and the fresh device
  re-publishes from scratch — a surviving `sources[user_id]` would leak
  the old screen/camera into every later offer manifest and egress diff
  (teardown_leg/forget_leg keep sources: the answer-deadline rebuild
  must retain a still-participant's live sources).
  """
  @spec drop_leg(t(), integer()) :: t()
  def drop_leg(media, user_id) do
    media
    |> teardown_leg(user_id)
    |> then(&%{&1 | sources: Map.delete(&1.sources, user_id)})
  end

  @doc "Tear down every PC (room end — no orphan processes)."
  @spec teardown_all(t()) :: t()
  def teardown_all(%__MODULE__{} = media) do
    Enum.reduce(Map.keys(media.legs), media, &teardown_leg(&2, &1))
  end

  # -- Inbound signaling (the room's op-23 mailbox) ------------------------------------

  @doc """
  Apply one op-23 body from `user_id`: an SDP answer (their response to
  our offer — closes the glare window and flushes any queued roster
  change) or an ICE candidate (trickled toward the server). Bodies are
  best-effort — anything malformed, early, or from a legless user is
  dropped silently (the gateway already participant-checked, size-capped,
  and throttled; the room never crashes on signaling).
  """
  @spec handle_signal(t(), integer(), integer(), String.t(), String.t(), [integer()]) :: t()
  def handle_signal(%__MODULE__{} = media, _channel_id, user_id, _kind, _body, _roster)
      when not is_map_key(media.legs, user_id),
      do: media

  def handle_signal(%__MODULE__{} = media, channel_id, user_id, "sdp", body, roster) do
    leg = media.legs[user_id]

    with {:ok, json} <- Jason.decode(body),
         %{"type" => "answer", "sdp" => _sdp} <- json,
         description <- SessionDescription.from_json(json),
         :ok <- pc_call(fn -> PeerConnection.set_remote_description(leg.pc, description) end) do
      # Attribute the ingest tracks that landed (answer-time {:track, t}
      # notifications fire on the room mailbox; mid→source comes from our
      # own ingest transceiver records — never m-line order).
      had_pending = leg.pending_roster
      restart_pending = leg.restart_pending
      reoffer_pending = leg.reoffer_pending

      leg = %{leg | offer_outstanding: false, offered_at: nil, restart_pending: false, reoffer_pending: false}

      # P1 deferred ICE restart: when the restart fires, a queued roster
      # reconcile stays queued (pending_roster rides the RESTART answer's
      # own close — the restart offer IS this window's follow-up offer).
      leg = if restart_pending, do: leg, else: %{leg | pending_roster: false}
      media = put_leg(media, user_id, leg)

      if restart_pending do
        leg = push_offer(channel_id, user_id, leg, media, ice_restart: true)
        put_leg(media, user_id, leg)
      else
        media = if had_pending, do: reconcile_leg(media, channel_id, user_id, roster), else: media

        # P2: a mic-reoffer queued behind the just-closed offer pushes even
        # when the reconcile found no diff — the client's locally-bound mic
        # needs the fresh negotiation to attach. (If the reconcile itself
        # pushed an offer, that one carries the upgrade.)
        if reoffer_pending do
          leg = media.legs[user_id]

          if leg.offer_outstanding,
            do: media,
            else: put_leg(media, user_id, push_offer(channel_id, user_id, leg, media))
        else
          media
        end
      end
    else
      # An answer that fails decode/apply leaves the offer outstanding
      # until its deadline rebuild — never fatal, never crashes the room.
      _ -> media
    end
  end

  def handle_signal(%__MODULE__{} = media, _channel_id, user_id, "ice", body, _roster) do
    leg = media.legs[user_id]

    with {:ok, json} <- Jason.decode(body),
         %{"candidate" => _, "sdpMid" => _, "sdpMLineIndex" => _} <- json,
         candidate <- ICECandidate.from_json(json),
         :ok <- pc_call(fn -> PeerConnection.add_ice_candidate(leg.pc, candidate) end) do
      media
    else
      # Candidates racing the answer (ex_webrtc rejects them without a
      # remote description) or malformed bodies: dropped, never fatal.
      _ -> media
    end
  end

  def handle_signal(%__MODULE__{} = media, _channel_id, _user_id, _kind, _body, _roster),
    do: media

  # -- ex_webrtc notifications (the room's {:ex_webrtc, pc, msg} mailbox) ---------------

  @doc """
  Handle one ex_webrtc notification from a server PC. `deafened` is the
  live deafen set (R15's AUDIO-only forwarding exclusion). Returns
  `{:ok, media}` or `{:remove, user_id, media}` — the latter when the PC
  is unrecoverable, handing the voice-unavailable removal to the room.
  """
  @spec handle_ex_webrtc(t(), integer(), {:ex_webrtc, pid(), term()}, MapSet.t()) ::
          {:ok, t()} | {:remove, integer(), t()}
  def handle_ex_webrtc(%__MODULE__{} = media, channel_id, {:ex_webrtc, pc, msg}, deafened) do
    case media.by_pc do
      %{^pc => user_id} -> dispatch(media, channel_id, user_id, msg, deafened)
      # A late message from a PC we already tore down (or never owned).
      _ -> {:ok, media}
    end
  end

  defp dispatch(media, _channel_id, user_id, {:rtp, track_id, rid, packet}, deafened) do
    case media.legs[user_id] do
      %{ingress: %{^track_id => attribution}} ->
        # forward returns the updated media — the restamp clocks (per
        # egress seq/ts state) MUST persist packet to packet or receivers
        # drop every packet after the first as a stale duplicate.
        {:ok, forward(media, user_id, attribution, rid, packet, deafened)}

      # RTP for an unknown track (pre-negotiation stragglers): dropped.
      _ ->
        {:ok, media}
    end
  end

  defp dispatch(media, _channel_id, user_id, {:track, track}, _deafened) do
    # The answerer attached a track to one of our ingest transceivers.
    # Attribution: the track resolves to its transceiver, the transceiver
    # to our ingest record for that source — never m-line order.
    leg = media.legs[user_id]
    ingress = attribute_ingest(leg, user_id, track)
    {:ok, put_leg(media, user_id, %{leg | ingress: ingress})}
  end

  defp dispatch(media, channel_id, user_id, {:ice_candidate, candidate}, _deafened) do
    emit_signal(channel_id, user_id, "ice", Jason.encode!(ICECandidate.to_json(candidate)))
    {:ok, media}
  end

  defp dispatch(media, channel_id, user_id, {:connection_state_change, :failed}, _deafened) do
    leg = media.legs[user_id]

    cond do
      leg.ice_restarted ->
        {:remove, user_id, teardown_leg(media, user_id)}

      signaling_stable?(leg) ->
        leg = push_offer(channel_id, user_id, leg, media, ice_restart: true)
        {:ok, put_leg(media, user_id, %{leg | ice_restarted: true})}

      # An offer is still un-answered: ex_webrtc 0.17 cannot stack offers.
      # The one-restart policy is spent NOW (a second :failed still means
      # removal) and the restart itself is DEFERRED to the answer's
      # glare-window close (restart_pending) — a plain later offer would
      # never re-gather ICE and the leg would wedge.
      true ->
        {:ok, put_leg(media, user_id, %{leg | ice_restarted: true, restart_pending: true})}
    end
  end

  defp dispatch(media, _channel_id, _user_id, _other, _deafened) do
    {:ok, media}
  end

  @doc """
  A PC process exited (the room traps exits; PCs link to it). Our own
  teardowns see the leg already forgotten — a crash (any exit for a PC we
  still track) is voice-unavailable: the participant goes, the room
  survives.
  """
  @spec pc_exit(t(), pid(), term()) :: {:ok, t()} | {:remove, integer(), t()}
  def pc_exit(%__MODULE__{} = media, pid, _reason) do
    case media.by_pc do
      %{^pid => user_id} -> {:remove, user_id, forget_leg(media, user_id)}
      _ -> {:ok, media}
    end
  end

  # -- Forwarding (KTD2's policy) -------------------------------------------------------

  # The fan-out hot path (KTD2/R15): one inbound packet on
  # (from_user, source) with its rid for simulcast video layers.
  #
  #   * AUDIO-kind sources (mic, screen_audio): forward to every OTHER
  #     participant EXCEPT the deafened (R15: deafen stops audio only).
  #   * VIDEO sources with a rid (the simulcast GO branch): the stage
  #     source (most-recent screen, VM3) forwards at the `f` layer to
  #     everyone (budget-exempt via the deliver? arm below); camera
  #     sources forward at `q` to viewers within whose tile budget they
  #     rank — the stage owner's camera included (only the stage SCREEN
  #     is exempt).
  #   * VIDEO without a rid (fallback branch / non-simulcast publisher):
  #     forward within the same budget at the single layer.
  #
  # Every forwarded packet is restamped on that egress's own seq/ts clock.
  defp forward(media, from_user, {from_user, source}, rid, packet, deafened) do
    # P3 hot path: the stage owner + camera ranking come from the cached
    # plan (recomputed at roster/source mutations) — never re-ranked per
    # packet.
    %{stage: stage, cameras: cameras, screens: screens} = media.plan
    rank = %{camera: cameras, screen: screens}

    for {other, leg} <- media.legs, other != from_user do
      delivered = deliver?(media, other, from_user, source, rid, deafened, stage, rank)

      result =
        if delivered do
          case leg.egress[{from_user, source}] do
            %{track_id: track_id} = entry ->
              {packet_out, entry} = restamp(entry, packet)
              PeerConnection.send_rtp(leg.pc, track_id, packet_out)

              {other, %{leg | egress: Map.put(leg.egress, {from_user, source}, entry)}, packet_out.sequence_number,
               packet_out.timestamp}

            nil ->
              nil
          end
        else
          nil
        end

      # U7-grade forward telemetry (also the unit-test seam for the
      # layer-selection policy AND the restamp clocks: seq_out/ts_out pin
      # the outgoing monotonicity; real-transport assertions belong to
      # U7's browser legs; the DECISIONS are what these events pin).
      measurements =
        case result do
          {_, _, seq_out, ts_out} -> %{forwarded: true, seq_out: seq_out, ts_out: ts_out}
          nil -> %{forwarded: false}
        end

      :telemetry.execute(
        [:cytale, :calls, :forward],
        measurements,
        %{viewer: other, source: source, rid: rid, from: from_user}
      )

      case result do
        {other, leg, _seq, _ts} -> {other, leg}
        nil -> nil
      end
    end
    |> Enum.reject(&is_nil/1)
    |> Enum.reduce(media, fn {other, leg}, acc -> put_leg(acc, other, leg) end)
  end

  defp deliver?(_media, other, _from, source_kind, _rid, deafened, _stage, _rank)
       when source_kind in [:mic, :screen_audio] do
    not MapSet.member?(deafened, other)
  end

  # The stage screen: f-layer to everyone with video flowing (deafen keeps
  # video — R15).
  defp deliver?(media, other, from_user, :screen, rid, _deafened, stage, _rank)
       when stage != nil and from_user == stage do
    rid in ["f", nil] and video_flow_ok?(media, other, from_user, :screen, stage)
  end

  # A non-stage screen (multiple simultaneous shares, VM4): it rides tile
  # budgets like a camera at q.
  defp deliver?(media, other, from_user, :screen, rid, _deafened, stage, rank) do
    rid in ["q", nil] and within_tile_budget?(media, other, from_user, :screen, stage, rank)
  end

  defp deliver?(media, other, from_user, :camera, rid, _deafened, stage, rank) do
    rid in ["q", nil] and within_tile_budget?(media, other, from_user, :camera, stage, rank)
  end

  defp deliver?(_media, _other, _from, _source, _rid, _deafened, _stage, _rank), do: false

  # Stage delivery always flows (R7: the stage never drops while any tile
  # survives) — subject only to the viewer having an egress for it.
  defp video_flow_ok?(_media, _other, _from, _source, _stage), do: true

  defp within_tile_budget?(media, other, from_user, source, _stage, rank) do
    budget = tile_budget(media, other)
    idx = Enum.find_index(rank[source], &(&1 == from_user))
    idx != nil and idx < budget
  end

  # Camera sources ranked most-recent-first by publish `since` (the
  # activity proxy: recency of publish + the room's ordering; under node
  # overload the budget itself shrinks — KTD2's server-side guardrail).
  # The stage owner's CAMERA ranks like anyone else's (removing it here
  # left the sharer's face unforwarded — the stage SCREEN is the exempt
  # one, and its f-layer exemption lives in deliver?'s own arm, not in
  # this ranking).
  defp camera_ranking(media, stage) do
    cameras =
      media.sources
      |> Enum.filter(fn {_u, ss} -> Map.has_key?(ss, :camera) end)
      |> Enum.sort_by(fn {_u, ss} -> ss[:camera].since end, {:desc, DateTime})
      |> Enum.map(fn {u, _ss} -> u end)

    non_stage_screens =
      media.sources
      |> Enum.filter(fn {u, ss} -> Map.has_key?(ss, :screen) and u != stage end)
      |> Enum.sort_by(fn {_u, ss} -> ss[:screen].since end, {:desc, DateTime})
      |> Enum.map(fn {u, _ss} -> u end)

    %{camera: cameras, screen: non_stage_screens}
  end

  defp stage_owner(media, :screen) do
    media.sources
    |> Enum.filter(fn {_u, ss} -> Map.has_key?(ss, :screen) end)
    |> Enum.max_by(fn {_u, ss} -> ss[:screen].since end, fn -> nil end)
    |> case do
      {u, _ss} -> u
      nil -> nil
    end
  end

  # The cached plan's recompute (P3 hot path): called ONLY from the three
  # sources-mutation sites (new/roster_changed/set_source) — forward reads
  # the cache. stage_owner/camera_ranking stay as this computation.
  defp recompute_plan(%__MODULE__{} = media) do
    stage = stage_owner(media, :screen)
    rank = camera_ranking(media, stage)
    %{stage: stage, cameras: rank.camera, screens: rank.screen}
  end

  defp tile_budget(media, viewer) do
    case media.wants[viewer] do
      %{tiles: t} -> max(t, 0)
      nil -> 9
    end
  end

  # Restamp one packet on an egress's outgoing clock: seq always +1; the
  # ts offset is captured from the first forwarded packet and BUMPED when
  # the raw continuation would regress (independent-clock publishers hand
  # the ingest timestamps that move backward on layer switches — the
  # outgoing clock must stay monotonic or receivers drop everything after
  # the jump as stale duplicates; the bump is minimal distortion:
  # last_ts_out + 1). First packet: last_ts_out starts 0 → no bump. (The
  # spike's constraint 2: 0.17 will not do this — its RTPSender re-stamps
  # only pt/ssrc.) ExRTP.Packet carries seq/ts as top-level struct fields
  # (no nested header).
  defp restamp(entry, packet) do
    ts_raw = packet.timestamp + entry.ts_offset

    {ts_offset, ts_out} =
      if entry.last_ts_out > 0 and ts_raw <= entry.last_ts_out do
        ts_offset = entry.ts_offset + (entry.last_ts_out + 1 - ts_raw)
        {ts_offset, entry.last_ts_out + 1}
      else
        {entry.ts_offset, ts_raw}
      end

    seq_out = rem(entry.next_seq, 65_536)
    packet_out = %{packet | sequence_number: seq_out, timestamp: ts_out}
    entry = %{entry | next_seq: entry.next_seq + 1, last_ts_out: ts_out, ts_offset: ts_offset}
    {packet_out, entry}
  end

  # -- Leg reconciliation ----------------------------------------------------------------

  # Bring one participant's leg in line with roster × sources: create the
  # PC (with the mic ingest transceiver) when missing, diff the egress set
  # (one sendonly transceiver per other participant per ACTIVE source),
  # and push an offer when anything changed — unless an offer is
  # outstanding (queue: apply on the answer).
  defp reconcile_leg(media, channel_id, user_id, roster)
       when not is_map_key(media.legs, user_id) do
    case create_leg() do
      {:ok, pc} ->
        leg = %{
          pc: pc,
          owner: user_id,
          egress: %{},
          ingest_mids: %{mic: mic_ingest_tid(pc)},
          ingress: %{},
          offer_outstanding: false,
          offered_at: nil,
          pending_roster: false,
          ice_restarted: false,
          restart_pending: false,
          reoffer_pending: false
        }

        {leg, _changed} = apply_egress_diff(leg, user_id, roster, media.sources)
        {leg, _ingest_changed} = apply_ingest_diff(leg, media.sources[user_id] || %{})

        # A fresh PC always carries the ingest transceiver: the initial
        # offer goes out unconditionally (even alone in the call).
        leg = push_offer(channel_id, user_id, leg, media)

        media
        |> put_leg(user_id, leg)
        |> then(&%{&1 | by_pc: Map.put(&1.by_pc, pc, user_id)})

      :error ->
        media
    end
  end

  defp reconcile_leg(media, channel_id, user_id, roster) do
    leg = media.legs[user_id]

    cond do
      leg.offer_outstanding and past_answer_deadline?(leg) ->
        media = teardown_leg(media, user_id)
        reconcile_leg(media, channel_id, user_id, roster)

      leg.offer_outstanding ->
        put_leg(media, user_id, %{leg | pending_roster: true})

      true ->
        {leg, egress_changed} = apply_egress_diff(leg, user_id, roster, media.sources)
        {leg, ingest_changed} = apply_ingest_diff(leg, media.sources[user_id] || %{})

        media = put_leg(media, user_id, leg)

        if egress_changed or ingest_changed,
          do: put_leg(media, user_id, push_offer(channel_id, user_id, leg, media)),
          else: media
    end
  end

  defp past_answer_deadline?(%{offered_at: at}) when is_integer(at),
    do: System.monotonic_time(:millisecond) - at > Cytale.Config.calls_answer_deadline_ms()

  defp past_answer_deadline?(_leg), do: false

  # One sendonly outbound transceiver per (other participant × active
  # source); stop those whose source or participant went away.
  defp apply_egress_diff(leg, owner_id, roster, sources) do
    desired =
      for other <- roster,
          other != owner_id,
          {source, _} <- Map.to_list(sources[other] || %{}),
          into: MapSet.new() do
        {other, source}
      end
      # mic rides the base roster (active once the leg exists).
      |> MapSet.union(MapSet.new(for other <- roster, other != owner_id, do: {other, :mic}))

    {egress, add_changed} =
      Enum.reduce(desired, {leg.egress, false}, fn key = {other, source}, {acc, changed} ->
        if Map.has_key?(acc, key) do
          {acc, changed}
        else
          kind = track_kind(source)
          track = MediaStreamTrack.new(kind)

          case pc_call(fn ->
                 PeerConnection.add_transceiver(leg.pc, track, direction: :sendonly)
               end) do
            {:ok, transceiver} ->
              entry = %{
                track_id: track.id,
                transceiver_id: transceiver.id,
                source: source,
                owner: other,
                next_seq: Enum.random(0..65_535),
                last_ts_out: 0,
                ts_offset: 0
              }

              {Map.put(acc, key, entry), true}

            :error ->
              {acc, changed}
          end
        end
      end)

    {egress, remove_changed} =
      Enum.reduce(Map.keys(egress), {egress, false}, fn key, {acc, changed} ->
        if MapSet.member?(desired, key) do
          {acc, changed}
        else
          %{transceiver_id: tid} = Map.get(acc, key)
          _ = pc_call(fn -> PeerConnection.stop_transceiver(leg.pc, tid) end)
          {Map.delete(acc, key), true}
        end
      end)

    {%{leg | egress: egress}, add_changed or remove_changed}
  end

  # Ingest transceivers for the owner's OWN published sources: mic at PC
  # birth (always); camera/screen/screen_audio while published (the
  # answerer attaches its tracks there by manifest mid, KTD1's send-side
  # binding). Video ingest m-lines get the rid splice on offers (spike).
  defp apply_ingest_diff(leg, my_sources) do
    desired =
      MapSet.new([:mic] ++ for({s, _} <- Map.to_list(my_sources), do: s))

    {mids, add_changed} =
      Enum.reduce(desired, {leg.ingest_mids, false}, fn source, {acc, changed} ->
        if Map.has_key?(acc, source) do
          {acc, changed}
        else
          kind = track_kind(source)

          case pc_call(fn ->
                 PeerConnection.add_transceiver(leg.pc, kind, direction: :recvonly)
               end) do
            {:ok, transceiver} ->
              {Map.put(acc, source, transceiver.id), true}

            :error ->
              {acc, changed}
          end
        end
      end)

    {mids, removed, remove_changed} =
      Enum.reduce(Map.keys(mids), {mids, MapSet.new(), false}, fn source, {acc, removed, changed} ->
        if MapSet.member?(desired, source) or source == :mic do
          {acc, removed, changed}
        else
          case Map.get(acc, source) do
            nil ->
              {acc, removed, changed}

            tid ->
              _ = pc_call(fn -> PeerConnection.stop_transceiver(leg.pc, tid) end)
              {Map.delete(acc, source), MapSet.put(removed, source), true}
          end
        end
      end)

    # P3: a stopped ingest transceiver's attribution dies with it — the
    # source went away, so any (attached) ingress entry for it is stale:
    # late/synthetic RTP for a dead source must not forward.
    ingress =
      if MapSet.size(removed) > 0,
        do: Map.filter(leg.ingress, fn {_t, {_owner, src}} -> not MapSet.member?(removed, src) end),
        else: leg.ingress

    {%{leg | ingest_mids: mids, ingress: ingress}, add_changed or remove_changed}
  end

  defp track_kind(:mic), do: :audio
  defp track_kind(:screen_audio), do: :audio
  defp track_kind(_video), do: :video

  # Resolve which source a newly attached ingest track belongs to: the
  # track lands on one of our recvonly ingest transceivers; match the
  # transceiver id directly (the receiver's track), then tid -> source via
  # our ingest records. Never m-line order.
  defp attribute_ingest(leg, owner, track) do
    transceivers = pc_call(fn -> PeerConnection.get_transceivers(leg.pc) end) || []

    source =
      Enum.find_value(transceivers, fn t ->
        if t.receiver && t.receiver.track && t.receiver.track.id == track.id do
          Enum.find_value(leg.ingest_mids, fn {src, tid} -> tid == t.id && src end)
        end
      end)

    case source do
      nil -> leg.ingress
      src -> Map.put(leg.ingress, track.id, {owner, src})
    end
  end

  # The mic ingest transceiver create_leg spawned (the first recvonly
  # audio transceiver): recorded so attribution and the manifest can name
  # it without re-deriving order.
  defp mic_ingest_tid(pc) do
    case pc_call(fn -> PeerConnection.get_transceivers(pc) end) do
      nil ->
        nil

      transceivers ->
        Enum.find_value(transceivers, fn t ->
          t.kind == :audio && t.direction == :recvonly && t.id
        end)
    end
  end

  # -- Offer push (wire-munged envelope v2, the spike's GO shape) -----------------------

  # A server PC for one participant: ICE config from Cytale.Config (U2),
  # VP8+opus codec pinning (load-bearing per the spike's arm b — default
  # codec sets breach the raised 128 KiB cap at N=25), linked to the room
  # (trap_exit'd), messages owned by the room, plus the single recvonly
  # audio ingest transceiver the answering client attaches its mic to
  # (V1's shape — video/screen ingests are added by apply_ingest_diff as
  # sources publish). Returns {:ok, pc} or :error.
  defp create_leg do
    ice = Cytale.Calls.ICE.config()
    {lo, hi} = ice.media_udp_port_range

    with {:ok, pc} <-
           pc_call(fn ->
             PeerConnection.start_link(
               controlling_process: self(),
               ice_servers: ice.ice_servers,
               ice_port_range: lo..hi//1,
               video_codecs: [vp8()],
               audio_codecs: [opus()]
             )
           end),
         {:ok, _ingest} <-
           pc_call(fn -> PeerConnection.add_transceiver(pc, :audio, direction: :recvonly) end) do
      {:ok, pc}
    else
      _ -> :error
    end
  end

  defp vp8 do
    %ExWebRTC.RTPCodecParameters{payload_type: 96, mime_type: "video/VP8", clock_rate: 90_000}
  end

  defp opus do
    %ExWebRTC.RTPCodecParameters{
      payload_type: 111,
      mime_type: "audio/opus",
      clock_rate: 48_000,
      channels: 2
    }
  end

  # Create + apply the UNMUNGED offer locally, then push the MUNGED copy:
  # rid/simulcast attrs spliced into video ingest m-lines (Chrome derives
  # its three encodings from them) and the whole thing wrapped in the
  # envelope-v2 manifest JSON.
  defp push_offer(channel_id, user_id, leg, media, opts \\ []) do
    with {:ok, offer} <- pc_call(fn -> PeerConnection.create_offer(leg.pc, opts) end),
         :ok <- pc_call(fn -> PeerConnection.set_local_description(leg.pc, offer) end) do
      manifest = build_manifest(leg, media)
      wire_sdp = munge_sdp(offer.sdp)

      body =
        Jason.encode!(%{
          "v" => 2,
          "type" => "offer",
          "sdp" => wire_sdp,
          "tracks" => manifest
        })

      emit_signal(channel_id, user_id, "sdp", body)
      %{leg | offer_outstanding: true, offered_at: System.monotonic_time(:millisecond)}
    else
      _ -> leg
    end
  end

  # The manifest (KTD1): one entry per egress transceiver (the stream the
  # VIEWER receives — `user_id` is the stream's owner, never the viewer)
  # and one per ingest transceiver (the viewer's own attach target, with
  # rids on video). Derived from the roster + our transceiver records —
  # never SDP parsing; mids resolve post-set-local-description.
  defp build_manifest(leg, _media) do
    transceivers = pc_call(fn -> PeerConnection.get_transceivers(leg.pc) end) || []
    mid_of = fn tid -> Enum.find_value(transceivers, fn t -> t.id == tid && t.mid end) end

    egress_entries =
      for {{other, source}, %{transceiver_id: tid}} <- leg.egress,
          mid = mid_of.(tid),
          do: %{
            "user_id" => Integer.to_string(other),
            "source" => Atom.to_string(source),
            "mid" => mid
          }

    ingest_entries =
      for {source, tid} <- leg.ingest_mids,
          tid != nil,
          mid = mid_of.(tid),
          do:
            %{
              "user_id" => Integer.to_string(leg.owner),
              "source" => Atom.to_string(source),
              "mid" => mid
            }
            |> maybe_rids(source)

    Enum.uniq_by(ingest_entries ++ egress_entries, & &1["mid"])
  end

  # rids ONLY on video ingest entries — the production codec rejects a
  # null rids field (U7 live finding); audio entries omit the key.
  defp maybe_rids(entry, source) when source in [:camera, :screen],
    do: Map.put(entry, "rids", @simulcast_rids)

  defp maybe_rids(entry, _), do: entry

  # Splice `a=rid:q/h/f recv` + `a=simulcast:recv q;h;f` into every recvonly
  # VIDEO m-line section (our ingest m-lines; egress is sendonly): a real
  # browser answerer derives its three rid encodings from these attrs (the
  # spike's arm-a browser result). The UNMUNGED offer was applied locally;
  # only the wire copy carries the splice (check_altered blocks the other
  # order).
  defp munge_sdp(sdp) do
    sdp
    |> String.split(~r{\r?\n}, trim: true)
    |> chunk_mlines()
    |> Enum.map(fn lines ->
      if ingest_video_section?(lines) do
        lines ++ ["a=rid:q recv", "a=rid:h recv", "a=rid:f recv", "a=simulcast:recv q;h;f"]
      else
        lines
      end
    end)
    |> Enum.map(&Enum.join(&1, "\r\n"))
    |> Enum.join("\r\n")
    |> then(&(&1 <> "\r\n"))
  end

  defp chunk_mlines(lines) do
    Enum.chunk_while(
      lines,
      [],
      fn line, acc ->
        if String.starts_with?(line, "m=") and acc != [] do
          {:cont, Enum.reverse(acc), [line]}
        else
          {:cont, [line | acc]}
        end
      end,
      fn acc -> {:cont, Enum.reverse(acc), []} end
    )
  end

  defp ingest_video_section?([m_line | _] = lines) do
    String.starts_with?(m_line, "m=video") and Enum.any?(lines, &(&1 == "a=recvonly"))
  end

  defp ingest_video_section?(_), do: false

  defp emit_signal(channel_id, user_id, kind, body) do
    :ok = Events.emit(:call_signal, Events.call_signal(channel_id, user_id, kind, body))
  end

  defp signaling_stable?(leg) do
    pc_call(fn -> PeerConnection.get_signaling_state(leg.pc) end) == :stable
  end

  # -- Teardown ---------------------------------------------------------------------------

  defp teardown_leg(media, user_id) do
    case media.legs do
      %{^user_id => leg} ->
        _ = pc_call(fn -> PeerConnection.close(leg.pc) end)
        _ = pc_call(fn -> PeerConnection.stop(leg.pc) end)
        forget_leg(media, user_id)

      _ ->
        media
    end
  end

  defp forget_leg(media, user_id) do
    case media.legs do
      %{^user_id => leg} ->
        # P3: the departed viewer's wants go with the leg (a rejoining
        # device re-declares its budget; a stale one would pin a gone
        # viewer's tiles forever). sources stay — the answer-deadline
        # rebuild must retain a still-participant's live sources.
        %{
          media
          | legs: Map.delete(media.legs, user_id),
            by_pc: Map.delete(media.by_pc, leg.pc),
            wants: Map.delete(media.wants, user_id)
        }

      _ ->
        media
    end
  end

  defp put_leg(media, user_id, leg), do: %{media | legs: Map.put(media.legs, user_id, leg)}

  defp drop_departed_sources(sources, user_ids) do
    roster = MapSet.new(user_ids)
    Map.filter(sources, fn {u, _} -> MapSet.member?(roster, u) end)
  end

  defp pc_call(fun) do
    fun.()
  catch
    :exit, _reason -> :error
  end
end
