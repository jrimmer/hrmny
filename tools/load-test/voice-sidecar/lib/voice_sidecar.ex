defmodule VoiceSidecar do
  @moduledoc """
  The voice sidecar application (calls plan U13): runs N headless ex_webrtc
  participants against a live Cytale gateway, pumps synthetic RTP on every
  negotiated send leg, counts inbound RTP per leg, and emits machine-readable
  report lines the TS harness parses:

      VOICE_META  {...}   once at start
      VOICE_TICK  {...}   every 5 s
      VOICE_FINAL {...}   at window end — includes steady-window delivery %

  **V2 video legs (calls V2 plan U7):** with `VOICE_VIDEO=1`, participants
  also publish camera/screen sources (op-22), pump video-rate RTP per
  published source, and count inbound video per (user, source) via the
  offer-manifest attribution — the per-source counters live in the public
  ETS table `VoiceSidecar.VideoStats` and ride every tick/final as the
  per-participant `video` map. The `sent`/`received` totals stay AUDIO-only
  (the V1 steady-window delivery math keeps its meaning).

  Doctrine boundary and the full env contract: README.md. This module is the
  orchestrator; `VoiceSidecar.Participant` is the per-leg engine and
  `VoiceSidecar.WS` the ported RFC 6455 subset.
  """

  use Application

  alias VoiceSidecar.Participant

  require Logger

  @tick_ms 5_000
  # OUTBOUND clamp only: caps the CALL_SIGNAL bodies a participant may SEND to
  # the server's documented 128 KiB op-23 limit (README.md). It is deliberately
  # NOT the inbound wire cap — the inbound FRAME cap (declared-length rejection
  # + buffer ceiling) has its single source in VoiceSidecar.WS's
  # @max_frame_bytes (S-2/R-9): one constant per direction, never shared.
  @max_size_bytes 131_072
  @video_tab VoiceSidecar.VideoStats

  @impl true
  def start(_type, _args) do
    # No-op when the env contract is absent (e.g. `mix run selftest.exs`
    # scripts) — the harness always provides the full contract.
    if System.get_env("VOICE_TOKENS_FILE") in [nil, ""] or
         System.get_env("VOICE_CHANNEL_ID") in [nil, ""] do
      {:ok, self()}
    else
      run_sidecar()
    end
  end

  defp run_sidecar do
    conf = read_config()
    stats = :atomics.new(conf.n * Participant.stride(), signed: false)

    maybe_video_table(conf)

    started = System.monotonic_time(:millisecond)

    emit("VOICE_META", %{
      n: conf.n,
      pps: conf.pps,
      duration_s: conf.duration_s,
      turn_only: conf.turn_only,
      channel_id: conf.channel_id,
      video: %{
        enabled: conf.video,
        camera_count: conf.camera_count,
        screen_count: conf.screen_count,
        video_pps: conf.video_pps,
        video_bytes: conf.video_bytes,
        tiles: conf.tiles,
        churn_publishers: conf.churn_publishers,
        churn_interval_ms: conf.churn_interval_ms,
        churn_rounds: conf.churn_rounds
      }
    })

    # Staggered arrival (VOICE_JOIN_STAGGER_MS, default 250 ms): real
    # callers never join in the same millisecond — a stampede multiplies the
    # room's renegotiation cascade (N offers per join) behind its glare
    # guard, and the harness's op-23 pacing amplifies the queue.
    stagger_ms = String.to_integer(env("VOICE_JOIN_STAGGER_MS") || "250")

    pids =
      for i <- 0..(conf.n - 1) do
        token = Enum.at(conf.tokens, i)

        opts = [
          idx: i,
          label: "#{conf.label_prefix}#{i}",
          token: token,
          host: conf.host,
          port: conf.port,
          path: conf.path,
          tls: conf.tls,
          channel_id: conf.channel_id,
          pps: conf.pps,
          payload_bytes: conf.payload_bytes,
          stats: stats,
          turn: turn_config(conf, i),
          video: conf.video,
          video_pps: conf.video_pps,
          video_bytes: conf.video_bytes,
          publish_delay_ms: conf.publish_delay_ms,
          camera_count: conf.camera_count,
          screen_count: conf.screen_count,
          tiles: conf.tiles[to_string(i)],
          churn_interval_ms: conf.churn_interval_ms,
          churn_rounds: if(i < conf.churn_publishers, do: conf.churn_rounds, else: 0)
        ]

        pid = spawn(fn -> Participant.run(self(), opts) end)
        Process.monitor(pid)
        if i < conf.n - 1, do: :timer.sleep(stagger_ms)
        pid
      end

    run_window(conf, stats, started, pids, [])
    # System.stop(0) inside finalize is already in flight by now.
    {:ok, self()}
  end

  defp maybe_video_table(conf) do
    if conf.video do
      if :ets.whereis(@video_tab) == :undefined do
        :ets.new(@video_tab, [:named_table, :public, :set, write_concurrency: true])
      end
    end
  end

  defp run_window(conf, stats, started, pids, ticks_rev) do
    deadline = started + conf.duration_s * 1_000

    receive do
      {:DOWN, _ref, :process, pid, reason} ->
        if reason != :normal, do: Logger.info("sidecar participant down: #{inspect(reason)}")
        run_window(conf, stats, started, List.delete(pids, pid), ticks_rev)
    after
      min(@tick_ms, max(deadline - System.monotonic_time(:millisecond), 1)) ->
        elapsed = System.monotonic_time(:millisecond) - started
        tick = snapshot(conf, stats, elapsed)
        emit("VOICE_TICK", tick)

        all_dead = Enum.all?(tick.participants, &(&1.ws_closed == 1))
        done = elapsed >= conf.duration_s * 1_000

        if done or all_dead do
          finalize(conf, stats, started, pids, ticks_rev)
        else
          run_window(conf, stats, started, pids, [tick | ticks_rev])
        end
    end
  end

  defp finalize(conf, stats, started, pids, ticks_rev) do
    for pid <- pids, do: send(pid, :stop)
    # Give the leave ops / PC teardowns a moment to land (best-effort).
    Process.sleep(1_500)

    final = snapshot(conf, stats, System.monotonic_time(:millisecond) - started)
    ticks = [final | ticks_rev] |> Enum.reverse()

    {delivery, window_ms, pps_achieved} = steady_delivery(conf, ticks)

    emit("VOICE_FINAL", %{
      n: conf.n,
      pps: conf.pps,
      pps_achieved: pps_achieved,
      t: final.t,
      participants: final.participants,
      all_connected: final.all_connected,
      delivery_pct: delivery,
      steady_window_ms: window_ms
    })

    System.stop(0)
  end

  # Steady-window delivery: from the first tick where EVERY participant is
  # connected to the final reading. The honest full-delivery metric is
  # CONSERVATION against the senders' ACTUAL pump volume — Δreceived_i vs
  # the summed Δsent of the OTHER n−1 senders (nominally (n−1)×pps×Δt, but
  # OS timer granularity makes the achieved pump rate slightly lower; the
  # achieved rate is reported alongside as `pps_achieved`). VIDEO packets
  # never enter this math (budgeted forwarding is not full fan-out — the
  # TS scenario derives per-receiver video conservation from the ticks'
  # per-source maps).
  defp steady_delivery(conf, ticks) do
    case Enum.find(ticks, & &1.all_connected) do
      nil ->
        {nil, 0, nil}

      steady ->
        final = List.last(ticks)
        window_ms = final.t - steady.t

        sent_delta =
          Enum.map(final.participants, & &1.sent)
          |> Enum.zip(Enum.map(steady.participants, & &1.sent))
          |> Enum.map(fn {a, b} -> a - b end)

        received_delta =
          Enum.map(final.participants, & &1.received)
          |> Enum.zip(Enum.map(steady.participants, & &1.received))
          |> Enum.map(fn {a, b} -> a - b end)

        total_sent = Enum.sum(sent_delta)
        total_received = Enum.sum(received_delta)
        # Every packet should reach the other n−1 receivers.
        expected_total = total_sent * (conf.n - 1)

        pps_achieved =
          if window_ms > 0,
            do: Float.round(total_sent / (window_ms / 1_000) / conf.n, 2),
            else: nil

        if expected_total > 0 and window_ms >= @tick_ms do
          {Float.round(total_received / expected_total * 100, 2), window_ms, pps_achieved}
        else
          {nil, window_ms, pps_achieved}
        end
    end
  end

  defp snapshot(conf, stats, t) do
    stride = Participant.stride()

    participants =
      for i <- 0..(conf.n - 1) do
        b = i * stride

        %{
          label: "#{conf.label_prefix}#{i}",
          connected: :atomics.get(stats, b + 1),
          sent: :atomics.get(stats, b + 2),
          received: :atomics.get(stats, b + 3),
          last_latency_ms: ms(:atomics.get(stats, b + 4)),
          max_latency_ms: ms(:atomics.get(stats, b + 5)),
          offers: :atomics.get(stats, b + 6),
          answers: :atomics.get(stats, b + 7),
          ice_sent: :atomics.get(stats, b + 8),
          inbound_tracks: :atomics.get(stats, b + 9),
          connected_after_ms: :atomics.get(stats, b + 10),
          ws_closed: :atomics.get(stats, b + 11),
          # V2 (U7):
          max_sdp_body_bytes: :atomics.get(stats, b + 12),
          pc_failures: :atomics.get(stats, b + 13),
          video_sent: :atomics.get(stats, b + 14),
          video_received: :atomics.get(stats, b + 15),
          max_video_latency_ms: ms(:atomics.get(stats, b + 16)),
          churn_toggles: :atomics.get(stats, b + 17),
          video: video_snapshot(i)
        }
      end

    %{
      t: t,
      participants: participants,
      all_connected: participants != [] and Enum.all?(participants, &(&1.connected == 1))
    }
  end

  # Fold this participant's per-source ETS counters into the tick map:
  # `sent` is per published source, `recv` is per (owner, source) keyed
  # "user/source" (Jason-safe). Absent table (video off) → empty maps.
  defp video_snapshot(idx) do
    if :ets.whereis(@video_tab) == :undefined do
      %{"sent" => %{}, "recv" => %{}}
    else
      # Counter objects are {key, value} with key = {idx, tag, a, b} (the
      # update_counter default-object layout).
      objects = :ets.match_object(@video_tab, {{idx, :_, :_, :_}, :_})

      sent =
        objects
        |> Enum.filter(&match?({{^idx, :sent_v, _, _}, _}, &1))
        |> Map.new(fn {{_idx, :sent_v, _self, source}, v} -> {source, v} end)

      recv =
        objects
        |> Enum.filter(&match?({{^idx, :recv_v, _, _}, _}, &1))
        |> Map.new(fn {{_idx, :recv_v, user, source}, v} -> {"#{user}/#{source}", v} end)

      %{"sent" => sent, "recv" => recv}
    end
  end

  defp ms(ns) when ns > 0, do: Float.round(ns / 1_000_000, 2)
  defp ms(_), do: nil

  defp turn_config(conf, i)
       when conf.turn_only > i and is_binary(conf.turn_url) and conf.turn_url != "" and
              is_binary(conf.turn_secret) and conf.turn_secret != "" do
    username = Integer.to_string(System.os_time(:second) + 3_600)
    password = Base.encode64(:crypto.mac(:hmac, :sha, conf.turn_secret, username))
    %{url: conf.turn_url, username: username, password: password}
  end

  defp turn_config(_conf, _i), do: nil

  defp emit(prefix, map) do
    IO.puts(prefix <> " " <> Jason.encode!(map))
  end

  defp read_config do
    tokens =
      "VOICE_TOKENS_FILE" |> env!() |> File.read!() |> Jason.decode!()

    n =
      case env("VOICE_PARTICIPANTS") do
        nil -> length(tokens)
        v -> min(String.to_integer(v), length(tokens))
      end

    video = env("VOICE_VIDEO") == "1"

    %{
      host: env("VOICE_GATEWAY_HOST") || "127.0.0.1",
      port: String.to_integer(env("VOICE_GATEWAY_PORT") || "4100"),
      path: env("VOICE_GATEWAY_PATH") || "/gateway/websocket",
      # S-2: dial the gateway over TLS (:ssl, OTP-default verification). "1"
      # matches the VOICE_VIDEO house style; "true" is accepted too because
      # the plain word reads more naturally for a transport switch.
      tls: env("VOICE_GATEWAY_TLS") in ["1", "true"],
      tokens: tokens,
      channel_id: env!("VOICE_CHANNEL_ID"),
      n: n,
      duration_s: String.to_integer(env("VOICE_DURATION_S") || "60"),
      pps: String.to_integer(env("VOICE_PPS") || "50"),
      payload_bytes: min(String.to_integer(env("VOICE_PAYLOAD_BYTES") || "160"), @max_size_bytes),
      turn_url: env("VOICE_TURN_URL") || "",
      turn_secret: env("VOICE_TURN_SECRET") || "",
      turn_only: String.to_integer(env("VOICE_TURN_ONLY_COUNT") || "0"),
      label_prefix: env("VOICE_LABEL_PREFIX") || "v",
      video: video,
      video_pps: String.to_integer(env("VOICE_VIDEO_PPS") || "200"),
      video_bytes: min(String.to_integer(env("VOICE_VIDEO_BYTES") || "1000"), @max_size_bytes),
      camera_count: min(String.to_integer(env("VOICE_CAMERA_COUNT") || "0"), n),
      screen_count: min(String.to_integer(env("VOICE_SCREEN_COUNT") || "0"), n),
      publish_delay_ms: String.to_integer(env("VOICE_PUBLISH_DELAY_MS") || "2000"),
      tiles: tiles_config(env("VOICE_TILES_JSON")),
      churn_publishers: String.to_integer(env("VOICE_CHURN_PUBLISHERS") || "0"),
      churn_interval_ms: String.to_integer(env("VOICE_CHURN_INTERVAL_MS") || "400"),
      churn_rounds: String.to_integer(env("VOICE_CHURN_ROUNDS") || "8")
    }
  end

  defp tiles_config(nil), do: %{}
  defp tiles_config(""), do: %{}

  defp tiles_config(json) do
    case Jason.decode(json) do
      {:ok, map} when is_map(map) ->
        Map.new(map, fn {k, v} -> {k, v} end)

      _ ->
        %{}
    end
  end

  defp env(name), do: System.get_env(name)
  defp env!(name), do: System.get_env(name) || raise("required env #{name} missing")
end
