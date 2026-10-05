defmodule Cytale.Gateway.PreEncodedTest do
  @moduledoc """
  Hardening plan 2.3: a fan-out event is JSON-encoded ONCE, not once per recipient
  socket. The saving is the payload (`d`), since the per-session `s` makes the
  envelope itself unshareable; the wrapper splices the pre-encoded bytes so the
  wire stays byte-identical.
  """

  use Cytale.ScyllaCase, async: false

  alias Cytale.Gateway.PreEncoded
  alias Cytale.Gateway.PushRegistry
  alias Cytale.Workspaces.FanOut

  # A payload with everything Jason has to work for: nesting, a list, escapes, a
  # non-ASCII string, a float and a null.
  defp payload do
    %{
      "id" => "95326886237831168",
      "content" => "quote \" backslash \\ newline \n emoji 👍 accent é",
      "nested" => %{"a" => [1, 2, %{"b" => nil}], "c" => 1.5},
      "attachments" => [%{"url" => "/api/v1/attachments/abc", "size" => 12_345}]
    }
  end

  describe "byte identity" do
    test "a wrapped envelope is byte-for-byte the unwrapped envelope" do
      fragment = PreEncoded.encode(payload())

      plain = Jason.encode!(%{op: 0, s: 7, t: "MessageCreate", d: payload()})
      wrapped = Jason.encode!(%{op: 0, s: 7, t: "MessageCreate", d: fragment})

      assert wrapped == plain
    end

    test "the fragment alone encodes to the payload's JSON" do
      assert Jason.encode!(PreEncoded.encode(payload())) == Jason.encode!(payload())
    end

    test "encode/1 emits one payload_encode event carrying the encoded size" do
      parent = self()
      ref = make_ref()
      handler_id = "pre-encoded-#{System.unique_integer([:positive])}"

      :ok =
        :telemetry.attach(
          handler_id,
          [:cytale, :gateway, :payload_encode],
          fn _event, measurements, _metadata, ^parent -> send(parent, {:encoded, ref, measurements}) end,
          parent
        )

      fragment = PreEncoded.encode(payload())

      assert_receive {:encoded, ^ref, %{bytes: bytes}}
      assert bytes == IO.iodata_length(Jason.encode!(payload()))

      :ok = :telemetry.detach(handler_id)
      assert Jason.encode!(fragment) == Jason.encode!(payload())
    end

    test "for_fanout/2 pre-encodes only when a fan-out can amortise the walk" do
      assert %PreEncoded{} = PreEncoded.for_fanout(2, payload())
      assert %PreEncoded{} = PreEncoded.for_fanout(500, payload())

      # One recipient gains nothing: the socket would have encoded it once anyway.
      assert PreEncoded.for_fanout(1, payload()) == nil
      assert PreEncoded.for_fanout(0, payload()) == nil
      assert PreEncoded.for_fanout(3, nil) == nil
    end
  end

  describe "one encode for an N-recipient fan-out" do
    test "three subscribed sockets cost ONE payload encode, and all receive the same bytes" do
      channel_id = Cytale.Snowflake.next()
      route = PushRegistry.channel_key(Integer.to_string(channel_id))
      parent = self()

      # Real subscribers, no websockets needed: the fan-out addresses route
      # subscribers by pid, and this test is about how many times the payload is
      # ENCODED, not about how it reaches the wire. Each forwarder hands the push
      # it receives back to this process.
      pids =
        for _ <- 1..3 do
          pid = spawn(fn -> forward_one_push(parent) end)
          :ok = PushRegistry.subscribe(route, "1", pid)
          pid
        end

      ref = make_ref()
      handler_id = "fanout-encode-#{System.unique_integer([:positive])}"

      :ok =
        :telemetry.attach(
          handler_id,
          [:cytale, :gateway, :payload_encode],
          fn _event, measurements, _metadata, ^parent -> send(parent, {:encoded, ref, measurements}) end,
          parent
        )

      delivered = FanOut.deliver(channel_id, {"TypingStart", payload()})

      encodings = drain_encodes(ref)
      :ok = :telemetry.detach(handler_id)

      assert delivered == 3

      # THE COUNT: one encode for three recipients. Before 2.3 this path encoded
      # nothing at all (each socket encoded the payload for itself, per
      # recipient), so this pins the producer-side encode to EXACTLY once.
      assert length(encodings) == 1

      # …and every recipient got the identical wrapper, so no socket re-walks the
      # payload: the bytes each one splices are the same.
      for _ <- pids do
        assert_receive {:push, "TypingStart", %PreEncoded{} = fragment}, 1_000
        assert Jason.encode!(fragment) == Jason.encode!(payload())
      end
    end
  end

  defp forward_one_push(parent) do
    receive do
      {:cytale_gateway_push, _from, {event_name, _payload}, fragment} ->
        send(parent, {:push, event_name, fragment})
    end

    :ok
  end

  defp drain_encodes(ref, acc \\ []) do
    receive do
      {:encoded, ^ref, measurements} -> drain_encodes(ref, [measurements | acc])
    after
      100 -> Enum.reverse(acc)
    end
  end
end
