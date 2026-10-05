defmodule CytaleWeb.Compat.PermissionsTest do
  @moduledoc """
  #173 — Cytale permission bits leave on the Discord-compatible wire in
  Discord's layout. The two layouts share no positions (Cytale's bit 3 is
  MANAGE_CHANNELS, Discord's is ADMINISTRATOR), so a raw Cytale field read as
  Discord flags gave bots wrong answers.
  """

  use ExUnit.Case, async: true

  import Bitwise

  alias Cytale.Permissions.Bitfield
  alias CytaleWeb.Compat.Permissions

  test "every Cytale permission is mapped (a new bit cannot reach a bot untranslated)" do
    assert Enum.sort(Permissions.mapped_names()) == Enum.sort(Bitfield.names())
  end

  test "the two bits the issue named land on Discord's positions" do
    # Cytale MANAGE_CHANNELS (1 <<< 3) is Discord MANAGE_CHANNELS (1 <<< 4),
    # never Discord ADMINISTRATOR (1 <<< 3).
    assert Permissions.to_discord(Bitfield.bit(:manage_channels)) == 1 <<< 4
    # Cytale ADMINISTRATOR (1 <<< 11) is Discord ADMINISTRATOR (1 <<< 3),
    # never Discord SEND_MESSAGES (1 <<< 11).
    assert Permissions.to_discord(Bitfield.bit(:administrator)) == 1 <<< 3
  end

  test "the nickname bits are Discord's CHANGE_NICKNAME and MANAGE_NICKNAMES" do
    assert Permissions.to_discord(Bitfield.bit(:change_nickname)) == 1 <<< 26
    assert Permissions.to_discord(Bitfield.bit(:manage_nicknames)) == 1 <<< 27
  end

  test "one Cytale bit can grant several Discord ones" do
    send = Permissions.to_discord(Bitfield.bit(:send_messages))
    assert send == (1 <<< 11 ||| 1 <<< 38)
    assert Permissions.to_discord(Bitfield.bit(:start_call)) == (1 <<< 20 ||| 1 <<< 21)
  end

  test "a read_write bot's bits read correctly as Discord flags; empty stays empty" do
    bits = Cytale.Access.bits(:read_write)
    discord = Permissions.to_discord(bits)

    for name <- [
          :view_channel,
          :send_messages,
          :read_message_history,
          :attach_files,
          :add_reactions,
          :create_public_threads,
          :change_nickname
        ] do
      assert band(discord, Permissions.discord_bit(name)) != 0, "#{name} should be set"
    end

    for name <- [:administrator, :manage_channels, :manage_guild, :kick_members, :manage_nicknames] do
      assert band(discord, Permissions.discord_bit(name)) == 0, "#{name} should not be set"
    end

    assert Permissions.to_discord(0) == 0
  end

  test "Bitfield.all() maps to exactly the union of the table's Discord bits" do
    all = Permissions.to_discord(Bitfield.all())

    for name <- Bitfield.names() do
      assert band(all, Permissions.to_discord(Bitfield.bit(name))) == Permissions.to_discord(Bitfield.bit(name))
    end
  end
end
