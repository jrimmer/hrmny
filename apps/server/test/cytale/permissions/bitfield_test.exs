defmodule Cytale.Permissions.BitfieldTest do
  @moduledoc """
  U7 — permission bitflag definitions and bitwise helpers.

  Bit positions are the SHARED CONTRACT with the client
  (`packages/domain/src/permissions.ts`, U16): identical names, identical
  positions, serialized as decimal strings at the JSON boundary. These tests
  pin the exact positions so the two sides cannot drift.
  """

  use ExUnit.Case, async: true

  import Bitwise

  alias Cytale.Permissions.Bitfield

  # The client contract (packages/domain/src/permissions.ts), mirrored:
  @ts_contract %{
    view_channel: 1,
    send_messages: 2,
    read_message_history: 4,
    manage_channels: 8,
    manage_roles: 16,
    manage_workspace: 32,
    manage_messages: 64,
    mention_everyone: 128,
    create_invites: 256,
    kick_members: 512,
    ban_members: 1024,
    administrator: 2048,
    create_threads: 4096,
    manage_threads: 8192,
    upload_attachments: 16_384,
    add_reactions: 32_768,
    start_call: 65_536,
    # Calls V2 plan U2 (R13): 1 <<< 17 / 1 <<< 18 were free — START_CALL
    # (1 <<< 16) topped the bitfield before these two landed.
    send_video: 131_072,
    share_screen: 262_144,
    # Nicknames (#169).
    change_nickname: 524_288,
    manage_nicknames: 1_048_576
  }

  test "bit positions match the client contract exactly (all 21)" do
    Enum.each(@ts_contract, fn {name, value} ->
      assert Bitfield.bit(name) == value,
             "#{name} must be bit value #{value} (client contract)"
    end)
  end

  test "exactly 21 permissions are defined (16 at launch + START_CALL + SEND_VIDEO/SHARE_SCREEN + the two nickname bits)" do
    assert length(Bitfield.names()) == 21
  end

  test "the nickname bits are gap-free above SHARE_SCREEN (1 <<< 19 and 1 <<< 20)" do
    assert Bitfield.bit(:change_nickname) == Bitfield.bit(:share_screen) * 2
    assert Bitfield.bit(:manage_nicknames) == Bitfield.bit(:change_nickname) * 2
  end

  test "the calls V2 bits are gap-free above START_CALL (1 <<< 17 and 1 <<< 18)" do
    # START_CALL topped the contract at 1 <<< 16; the two new bits consume
    # the next free positions in order — nothing between, nothing beyond.
    assert Bitfield.bit(:start_call) == 65_536
    assert Bitfield.bit(:send_video) == Bitfield.bit(:start_call) * 2
    assert Bitfield.bit(:share_screen) == Bitfield.bit(:send_video) * 2
  end

  test "administrator is not the highest-numbered bit but is the bypass flag" do
    # Task spec says "ADMINISTRATOR = highest bit" among the legacy set; the
    # shipped client contract pins it at 1 <<< 11. The CONTRACT WINS (seam
    # discipline: one spelling per concept across client and server).
    assert Bitfield.bit(:administrator) == 2048
    assert Bitfield.administrator() == 2048
  end

  test "all/0 is the OR of every defined bit" do
    expected = Enum.reduce(@ts_contract, 0, fn {_name, v}, acc -> acc ||| v end)
    assert Bitfield.all() == expected
  end

  test "has?/2 checks single bits" do
    bits = Bitfield.bit(:send_messages) ||| Bitfield.bit(:view_channel)

    assert Bitfield.has?(bits, :send_messages)
    assert Bitfield.has?(bits, :view_channel)
    refute Bitfield.has?(bits, :manage_channels)
    refute Bitfield.has?(0, :view_channel)
    # administrator bit in isolation
    assert Bitfield.has?(Bitfield.administrator(), :administrator)
  end

  test "to_list/1 decodes exact membership (no phantom names)" do
    bits = Bitfield.bit(:view_channel) ||| Bitfield.bit(:ban_members)
    assert Bitfield.to_list(bits) == [:view_channel, :ban_members]
    assert Bitfield.to_list(0) == []
    assert Bitfield.to_list(Bitfield.all()) |> length() == 21
  end

  test "bor/2 unions bitfields" do
    a = Bitfield.bit(:view_channel)
    b = Bitfield.bit(:send_messages)

    assert Bitfield.bor(a, b) == a + b
    assert Bitfield.bor(a, a) == a
  end

  test "band_not/2 clears exactly the given bits" do
    bits = Bitfield.bit(:view_channel) ||| Bitfield.bit(:send_messages)

    assert Bitfield.band_not(bits, Bitfield.bit(:send_messages)) == Bitfield.bit(:view_channel)
    # clearing a bit that isn't set is a no-op
    assert Bitfield.band_not(Bitfield.bit(:view_channel), Bitfield.bit(:kick_members)) ==
             Bitfield.bit(:view_channel)
  end

  test "round-trip: to_list of bor re-encodes to the same bits" do
    bits = Bitfield.bit(:add_reactions) ||| Bitfield.bit(:upload_attachments)
    re = Enum.reduce(Bitfield.to_list(bits), 0, &Bitwise.bor(&2, Bitfield.bit(&1)))

    assert re == bits
  end
end
