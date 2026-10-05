defmodule Cytale.Notifications.BroadcastGate do
  @moduledoc """
  Who may make `@everyone` / `@here` REACH people.

  The tokens are text; what they do — a broadcast inbox row for every member
  who can see the channel, and a push at the "mentions" level — is a
  capability, and the capability is the `mention_everyone` permission bit
  (Discord's rule). Without this gate any member could page an entire
  workspace, including members who suppressed nothing because they trusted
  only admins to use it.

  The text is never rewritten: a message from an author without the bit keeps
  its `@everyone`, it just notifies nobody on that account (a direct `<@id>`
  mention in the same message still works).

  Authors resolve through the ONE resolver (`Cytale.Permissions.Principal`) at
  the message's channel (a thread reply's channel is its parent):

    * humans — their own bits in that channel;
    * webhooks — the webhook's CREATOR's bits (a webhook is a capability URL
      its creator handed out; it can never broadcast further than they could);
    * bots/agents — their parent's bits ∩ their access grant, and no grant
      level confers `mention_everyone` (`Cytale.Access.never/0`), so machine
      authors never broadcast.

  DMs have no workspace and no broadcast audience: always false.

  On top of this gate, EVERY sender's `allowed_mentions` may withhold the
  broadcast (`Cytale.Messages.AllowedMentions.everyone?/1`, applied in
  `Cytale.Messages.create_message/1`): the sender can only narrow, never
  widen, what the bit allows.
  """

  alias Cytale.Accounts.Principals
  alias Cytale.Notifications.Mentions
  alias Cytale.Permissions.{Bitfield, Principal}
  alias Cytale.Workspaces

  @doc """
  Whether a message with `content`, by `author_id`, in `channel_id`, may
  broadcast. False without a broadcast token at all (no reads made then).
  """
  @spec permitted?(String.t() | nil, integer() | nil, integer() | nil) :: boolean()
  def permitted?(content, author_id, channel_id) do
    Mentions.broadcast?(content || "") and author_holds_bit?(author_id, channel_id)
  end

  @doc """
  Whether `author_id` holds `mention_everyone` in `channel_id` (see the
  moduledoc for how each principal kind resolves). Fail-closed on anything
  unresolvable.
  """
  @spec author_holds_bit?(integer() | nil, integer() | nil) :: boolean()
  def author_holds_bit?(author_id, channel_id) when is_integer(author_id) and is_integer(channel_id) do
    with %{workspace_id: workspace_id} <- Workspaces.get_channel(channel_id),
         claims when is_map(claims) <- claims_for(author_id),
         {:ok, bits} <- Principal.resolve(workspace_id, claims, channel_id) do
      Bitfield.has?(bits, :mention_everyone)
    else
      _ -> false
    end
  rescue
    _ -> false
  end

  def author_holds_bit?(_author_id, _channel_id), do: false

  # The resolver's claims for an author id: a webhook plays its creator (the
  # parent, as a human), any other machine principal resolves as itself.
  defp claims_for(author_id) do
    case Principals.get(author_id) do
      nil ->
        %{user_id: author_id, kind: :human}

      %{kind: :webhook, parent_user_id: parent} when is_integer(parent) ->
        %{user_id: parent, kind: :human}

      %{kind: kind} = principal ->
        if Principal.machine_kind?(kind) do
          %{
            user_id: principal.user_id,
            kind: kind,
            parent_user_id: principal.parent_user_id,
            restrictions: principal.restrictions,
            access: principal.access
          }
        else
          nil
        end
    end
  end
end
