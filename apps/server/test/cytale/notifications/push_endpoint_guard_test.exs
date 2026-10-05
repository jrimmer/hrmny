defmodule Cytale.Notifications.PushEndpointGuardTest do
  @moduledoc """
  S1 — the SSRF guard's own resolver and address classifier, below the
  controller (push_controller_test pins the wire refusals with injected
  resolvers; this pins the REAL resolver the production seam defaults to).

  No database, no network: `localhost` answers from the hosts file.
  """

  use ExUnit.Case, async: true

  alias Cytale.Notifications.PushEndpointGuard

  describe "resolve/1 (the production default resolver)" do
    test "answers {:ok, addresses} for a name the node can resolve" do
      assert {:ok, addresses} = PushEndpointGuard.resolve("localhost")
      assert addresses != []
      assert Enum.all?(addresses, &(is_tuple(&1) and tuple_size(&1) in [4, 8]))
      assert Enum.any?(addresses, &(&1 in [{127, 0, 0, 1}, {0, 0, 0, 0, 0, 0, 0, 1}]))
    end
  end

  describe "IPv4-mapped IPv6 literals are judged by their embedded v4 address" do
    test "a mapped loopback / metadata / private address is refused" do
      for literal <- ["::ffff:127.0.0.1", "::ffff:169.254.169.254", "::ffff:10.0.0.5", "::ffff:7f00:1"] do
        assert PushEndpointGuard.validate("https://[#{literal}]/sub") == {:error, :blocked_address},
               "#{literal} must be refused"
      end
    end

    test "a mapped public address stays public" do
      assert PushEndpointGuard.validate("https://[::ffff:192.0.2.10]/sub") == :ok
    end
  end
end
