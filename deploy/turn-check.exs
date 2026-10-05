#!/usr/bin/env elixir

# deploy/turn-check.exs — TURN allocation verification (voice plan U12, the
# committed verification step the runbook names).
#
# Proves the deploy kit's TURN path end-to-end against a RUNNING eturnal:
# it mints an ephemeral credential EXACTLY like the app does (username =
# unix expiry timestamp, password = Base64(HMAC-SHA1(secret, username)) —
# eturnal REST-auth, draft-uberti-behave-turn-rest) and performs a real
# TURN Allocate handshake over UDP. A relayed address in the success
# response means: eturnal is up, the secret matches, the relay range is
# usable, and credential minting is correct — the falsification the voice
# spike deferred (research doc §8.2 item 5) gets its first run here.
#
# Usage (any machine with Elixir >= 1.15 and network access on first run —
# Mix.install fetches ex_turn/ex_stun once, then caches):
#
#   elixir deploy/turn-check.exs --host 127.0.0.1 --port 3478 --secret "$ETURNAL_SECRET"
#
#   --host    TURN server address            (default 127.0.0.1)
#   --port    TURN server port               (default 3478)
#   --secret  the shared secret (also read from $ETURNAL_SECRET) — REQUIRED
#   --ttl     credential validity, seconds   (default 3600, as the app mints)
#
# Exit status: 0 = allocation created; 1 = anything else (with a reason).

Mix.install([{:ex_turn, "~> 0.2"}])

defmodule TurnCheck do
  @moduledoc false

  @default_host "127.0.0.1"
  @default_port 3_478
  @default_ttl 3_600
  @timeout_ms 5_000
  @max_steps 6

  def main(argv) do
    opts = parse!(argv)

    secret =
      opts[:secret] || System.get_env("ETURNAL_SECRET") ||
        fail("no --secret and $ETURNAL_SECRET is unset")

    host = Keyword.get(opts, :host, @default_host)
    port = Keyword.get(opts, :port, @default_port)
    ttl = Keyword.get(opts, :ttl, @default_ttl)

    IO.puts("TURN allocation check: #{host}:#{port} (ttl #{ttl}s)")

    # Mint the ephemeral pair exactly like Cytale.Config.calls_ice_servers/1.
    username = Integer.to_string(System.os_time(:second) + ttl)
    password = Base.encode64(:crypto.mac(:hmac, :sha, secret, username))
    IO.puts("minted username (expiry): #{username}")

    uri = ExSTUN.URI.parse!("turn:#{host}:#{port}?transport=udp")

    with {:ok, socket} <- :gen_udp.open(0, [:binary, active: false]),
         {:ok, client} <- ExTURN.Client.new(uri, username, password),
         {:send, dst, data, client} <- ExTURN.Client.allocate(client),
         :ok <- :gen_udp.send(socket, dst, data),
         {:ok, relayed, _client} <- roundtrip(socket, client, 0) do
      IO.puts("PASS: allocation created, relayed address #{fmt(relayed)}")
      :gen_udp.close(socket)
      System.halt(0)
    else
      {:error, reason} ->
        fail("TURN allocation failed: #{inspect(reason)}")

      other ->
        fail("unexpected client return: #{inspect(other)}")
    end
  end

  # One TURN round-trip per recursion: receive the next datagram, hand it to
  # the client, and either finish (allocation_created) or send whatever the
  # client wants out (the 401 challenge's authenticated retry) and repeat.
  defp roundtrip(_socket, _client, step) when step >= @max_steps,
    do: {:error, :too_many_round_trips}

  defp roundtrip(socket, client, step) do
    with {:ok, {ip, port, resp}} <- :gen_udp.recv(socket, 0, @timeout_ms) do
      case ExTURN.Client.handle_message(client, {:socket_data, ip, port, resp}) do
        {:allocation_created, relayed, client} ->
          {:ok, relayed, client}

        {:send, _dst, data, client} ->
          :ok = :gen_udp.send(socket, {client.turn_ip, client.turn_port}, data)
          roundtrip(socket, client, step + 1)

        {:error, reason, _client} ->
          {:error, reason}

        other ->
          {:error, {:bad_handle_return, other}}
      end
    end
  end

  defp parse!(argv) do
    argv
    |> Enum.chunk_every(2)
    |> Enum.map(fn
      ["--host", v] -> {:host, v}
      ["--port", v] -> {:port, String.to_integer(v)}
      ["--secret", v] -> {:secret, v}
      ["--ttl", v] -> {:ttl, String.to_integer(v)}
      [flag, _] -> fail("unknown flag #{flag}")
      [flag] -> fail("missing value for #{flag}")
    end)
  end

  defp fmt({ip, port}) when is_tuple(ip), do: "#{:inet.ntoa(ip)}:#{port}"

  defp fail(reason) do
    IO.puts(:stderr, "FAIL: #{reason}")
    System.halt(1)
  end
end

TurnCheck.main(System.argv())
