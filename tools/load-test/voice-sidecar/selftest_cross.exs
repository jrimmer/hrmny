# Cross-beam self-test: negotiate a server-shaped PC against a sidecar-shaped
# PC IN SEPARATE BEAM PROCESSES, exchanging SDP/ICE through files (the
# gateway's CALL_SIGNAL seam replaced by the filesystem — the UDP media path
# is what we are isolating).
#
#   mix run selftest_cross.exs server &
#   mix run selftest_cross.exs client
#
# Each role prints CROSS-RESULT lines; exit 0 on connect, 1 on failure.

alias ExWebRTC.{MediaStreamTrack, PeerConnection, RTPCodecParameters, SessionDescription}

role = hd(System.argv())
dir = "/tmp/voice-cross"
File.mkdir_p!(dir)

codec = %RTPCodecParameters{
  payload_type: 111,
  mime_type: "audio/opus",
  clock_rate: 48_000,
  channels: 2
}

defmodule Cross.Wait do
  def file(path, timeout) do
    deadline = System.monotonic_time(:millisecond) + timeout
    do_wait(path, deadline)
  end

  defp do_wait(path, deadline) do
    case File.read(path) do
      {:ok, bin} when byte_size(bin) > 0 ->
        bin

      _ ->
        if System.monotonic_time(:millisecond) < deadline do
          :timer.sleep(50)
          do_wait(path, deadline)
        else
          raise "timeout waiting for #{path}"
        end
    end
  end
end

wait_file = &Cross.Wait.file/2

defmodule Cross.Gather do
  def wait_complete(pc, timeout \\ 8_000) do
    deadline = System.monotonic_time(:millisecond) + timeout
    do_wait(pc, deadline)
  end

  defp do_wait(pc, deadline) do
    receive do
      {:ex_webrtc, ^pc, {:ice_gathering_state_change, :complete}} -> :ok
      _ -> if System.monotonic_time(:millisecond) < deadline, do: do_wait(pc, deadline)
    after
      200 -> if System.monotonic_time(:millisecond) < deadline, do: do_wait(pc, deadline)
    end
  end
end

case role do
  "server" ->
    File.rm("#{dir}/answer.json")

    {:ok, pc} =
      PeerConnection.start_link(
        controlling_process: self(),
        ice_port_range: 50_200..50_299,
        audio_codecs: [codec],
        video_codecs: []
      )

    {:ok, _} = PeerConnection.add_transceiver(pc, :audio, direction: :recvonly)
    {:ok, offer} = PeerConnection.create_offer(pc)
    :ok = PeerConnection.set_local_description(pc, offer)
    :ok = Cross.Gather.wait_complete(pc)
    full = PeerConnection.get_local_description(pc)
    File.write!("#{dir}/offer.json", Jason.encode!(SessionDescription.to_json(full)))

    answer_json = wait_file.("#{dir}/answer.json", 20_000)

    :ok =
      PeerConnection.set_remote_description(
        pc,
        SessionDescription.from_json(Jason.decode!(answer_json))
      )

    result =
      receive do
        {:ex_webrtc, ^pc, {:connection_state_change, :connected}} -> :connected
      after
        15_000 -> :timeout
      end

    IO.puts("CROSS-RESULT server #{inspect(result)}")
    PeerConnection.close(pc)
    System.halt(if(result == :connected, do: 0, else: 1))

  "client" ->
    offer_json = wait_file.("#{dir}/offer.json", 20_000)

    {:ok, pc} =
      PeerConnection.start_link(
        controlling_process: self(),
        ice_ip_filter: fn ip -> tuple_size(ip) == 4 end,
        audio_codecs: [codec],
        video_codecs: []
      )

    mic = MediaStreamTrack.new(:audio)
    {:ok, _} = PeerConnection.add_track(pc, mic)

    :ok =
      PeerConnection.set_remote_description(
        pc,
        SessionDescription.from_json(Jason.decode!(offer_json))
      )

    {:ok, answer} = PeerConnection.create_answer(pc)
    :ok = PeerConnection.set_local_description(pc, answer)
    :ok = Cross.Gather.wait_complete(pc)
    full = PeerConnection.get_local_description(pc)
    File.write!("#{dir}/answer.json", Jason.encode!(SessionDescription.to_json(full)))

    result =
      receive do
        {:ex_webrtc, ^pc, {:connection_state_change, :connected}} -> :connected
      after
        15_000 -> :timeout
      end

    IO.puts("CROSS-RESULT client #{inspect(result)}")
    PeerConnection.close(pc)
    System.halt(if(result == :connected, do: 0, else: 1))
end
