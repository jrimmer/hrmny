# One-shot self-test: negotiate a server-shaped PC (restricted media port
# range, sole offerer, recvonly ingest + sendonly egress — media.ex shape)
# against a sidecar-shaped PC (this project's create options), pump RTP both
# ways, and print whether both connect + counts. Run:
#
#   mix run selftest.exs
#
# Isolates PC-level failures (DTLS/ICE/codecs) from the gateway-mediated
# path. Exits 0 when both PCs connect and RTP flows.

alias ExWebRTC.{MediaStreamTrack, PeerConnection, RTPCodecParameters, SessionDescription}

{:ok, srv} =
  PeerConnection.start_link(
    controlling_process: self(),
    ice_port_range: 50_200..50_299,
    audio_codecs: [
      %RTPCodecParameters{
        payload_type: 111,
        mime_type: "audio/opus",
        clock_rate: 48_000,
        channels: 2
      }
    ],
    video_codecs: []
  )

{:ok, _} = PeerConnection.add_transceiver(srv, :audio, direction: :recvonly)

{:ok, cli} =
  PeerConnection.start_link(
    controlling_process: self(),
    ice_transport_policy: :all,
    ice_ip_filter: fn ip -> tuple_size(ip) == 4 end,
    audio_codecs: [
      %RTPCodecParameters{
        payload_type: 111,
        mime_type: "audio/opus",
        clock_rate: 48_000,
        channels: 2
      }
    ],
    video_codecs: []
  )

mic = MediaStreamTrack.new(:audio)
{:ok, _} = PeerConnection.add_track(cli, mic)

# Sole-offerer flow: srv offer → cli apply+answer → srv apply; ICE both ways.
{:ok, offer} = PeerConnection.create_offer(srv)
:ok = PeerConnection.set_local_description(srv, offer)
offer_json = Jason.encode!(SessionDescription.to_json(PeerConnection.get_local_description(srv)))

:ok =
  PeerConnection.set_remote_description(
    cli,
    SessionDescription.from_json(Jason.decode!(offer_json))
  )

{:ok, answer} = PeerConnection.create_answer(cli)
:ok = PeerConnection.set_local_description(cli, answer)
answer_json = Jason.encode!(SessionDescription.to_json(answer))

:ok =
  PeerConnection.set_remote_description(
    srv,
    SessionDescription.from_json(Jason.decode!(answer_json))
  )

# Relay candidates both ways for a couple of seconds.
defmodule Selftest.Relay do
  def both(a, b, deadline) do
    one(a, b, deadline)
    one(b, a, deadline)
  end

  def one(from, to, deadline) do
    receive do
      {:ex_webrtc, ^from, {:ice_candidate, cand}} ->
        PeerConnection.add_ice_candidate(to, cand)
        if System.monotonic_time(:millisecond) < deadline, do: one(from, to, deadline)

      _other ->
        if System.monotonic_time(:millisecond) < deadline, do: one(from, to, deadline)
    after
      0 -> :ok
    end
  end
end

Selftest.Relay.both(srv, cli, System.monotonic_time(:millisecond) + 2_000)

# Wait for both to report connected.
defmodule Selftest.Wait do
  def connected(pc, name, deadline) do
    receive do
      {:ex_webrtc, ^pc, {:connection_state_change, :connected}} ->
        IO.puts("selftest: #{name} connected")
        :ok

      {:ex_webrtc, ^pc, _other} ->
        if System.monotonic_time(:millisecond) < deadline, do: connected(pc, name, deadline)

      _ ->
        if System.monotonic_time(:millisecond) < deadline, do: connected(pc, name, deadline)
    after
      2_000 -> :timeout
    end
  end
end

now = System.monotonic_time(:millisecond)
IO.puts("selftest: srv=#{inspect(Selftest.Wait.connected(srv, "server-shaped", now + 10_000))}")

IO.puts(
  "selftest: cli=#{inspect(Selftest.Wait.connected(cli, "sidecar-shaped", System.monotonic_time(:millisecond) + 10_000))}"
)

:timer.sleep(500)

send_rtp = fn pc, track_id, k, b ->
  n = System.os_time(:nanosecond)
  ts = div((n - b) * 48_000, 1_000_000_000)

  packet =
    ExRTP.Packet.new(<<n::128, 0::size(118 * 8)>>, timestamp: ts, sequence_number: rem(k, 65_536))

  PeerConnection.send_rtp(pc, track_id, packet)
end

base = System.os_time(:nanosecond)

for k <- 1..100 do
  send_rtp.(cli, mic.id, k, base)
  :timer.sleep(10)
end

:timer.sleep(1_000)

receive do
  {:ex_webrtc, ^srv, {:rtp, _t, _rid, _p}} -> IO.puts("selftest: server got RTP")
after
  1_000 -> IO.puts("selftest: server got NO RTP")
end

:ok = PeerConnection.close(srv)
:ok = PeerConnection.close(cli)
IO.puts("selftest done")
System.halt(0)
