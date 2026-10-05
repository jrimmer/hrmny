defmodule CytaleWeb.Compat.Permissions do
  @moduledoc """
  Cytale permission bits → Discord permission bits, for every bitfield that
  leaves on the Discord-compatible wire (#173).

  The two layouts share no positions: Cytale's bit 3 is MANAGE_CHANNELS where
  Discord's is ADMINISTRATOR, Cytale's 11 is ADMINISTRATOR where Discord's is
  SEND_MESSAGES. Sending Cytale bits raw made a Discord library read the wrong
  answer — `interaction.app_permissions.administrator` (discord.py) or
  `appPermissions.has('Administrator')` (discord.js) was true for a bot that
  could merely manage channels. Native clients keep Cytale's own bits; only
  the compat surface translates.

  The table maps BY NAME, and every `Cytale.Permissions.Bitfield` name must
  appear in it (the drift test): a bit added on the Cytale side cannot reach
  a bot untranslated. Where one Cytale bit covers several Discord ones (Cytale
  has no separate thread-send or speak bits), it maps to all of them.
  """

  import Bitwise

  alias Cytale.Permissions.Bitfield

  # Discord's bit positions (developer docs, "Permissions" → bitwise flags).
  @discord %{
    create_instant_invite: 0,
    kick_members: 1,
    ban_members: 2,
    administrator: 3,
    manage_channels: 4,
    manage_guild: 5,
    add_reactions: 6,
    stream: 9,
    view_channel: 10,
    send_messages: 11,
    manage_messages: 13,
    attach_files: 15,
    read_message_history: 16,
    mention_everyone: 17,
    connect: 20,
    speak: 21,
    change_nickname: 26,
    manage_nicknames: 27,
    manage_roles: 28,
    manage_threads: 34,
    create_public_threads: 35,
    send_messages_in_threads: 38
  }

  # Cytale name → the Discord names it grants.
  @table %{
    view_channel: [:view_channel],
    # Cytale has one send bit for channels and their threads.
    send_messages: [:send_messages, :send_messages_in_threads],
    read_message_history: [:read_message_history],
    manage_channels: [:manage_channels],
    manage_roles: [:manage_roles],
    manage_workspace: [:manage_guild],
    manage_messages: [:manage_messages],
    mention_everyone: [:mention_everyone],
    create_invites: [:create_instant_invite],
    kick_members: [:kick_members],
    ban_members: [:ban_members],
    administrator: [:administrator],
    # Cytale threads are public threads.
    create_threads: [:create_public_threads],
    manage_threads: [:manage_threads],
    upload_attachments: [:attach_files],
    add_reactions: [:add_reactions],
    # Starting or joining a call is Discord's connect + speak.
    start_call: [:connect, :speak],
    # Discord's STREAM ("Video") covers both camera video and screen share.
    send_video: [:stream],
    share_screen: [:stream],
    change_nickname: [:change_nickname],
    manage_nicknames: [:manage_nicknames]
  }

  @doc "The Cytale bit names this table maps (the drift test compares it to `Bitfield.names/0`)."
  @spec mapped_names() :: [atom()]
  def mapped_names, do: Map.keys(@table)

  @doc "A Cytale bitfield as the Discord bitfield granting the same things."
  @spec to_discord(non_neg_integer()) :: non_neg_integer()
  def to_discord(bits) when is_integer(bits) and bits >= 0 do
    Enum.reduce(@table, 0, fn {cytale, discord_names}, acc ->
      if Bitfield.has?(bits, cytale) do
        Enum.reduce(discord_names, acc, &(&2 ||| 1 <<< Map.fetch!(@discord, &1)))
      else
        acc
      end
    end)
  end

  @doc "The Discord bit for a Discord permission name this table knows (tests)."
  @spec discord_bit(atom()) :: pos_integer()
  def discord_bit(name), do: 1 <<< Map.fetch!(@discord, name)
end
