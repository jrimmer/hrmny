defmodule Cytale.Messages.Events do
  @moduledoc """
  Message gateway event payload builders — the wire contract shared with the
  `@cytale/protocol` package (CamelCase event names, snowflake ids as decimal
  strings). These build the `d` payloads; the fan-out delivers them as
  `{event_name, payload}` through `Cytale.Publish`.

  Message events have historically had their shape split across producers
  (`Messages.Message.to_wire/1` for the create wire, controller-local
  `message_json/1` for updates); this module is where the shared builders
  live as they are collected. `message_delete/1` is the first: the three
  delete routes hand-assembled identical maps, the exact drift the
  `TypingStart` guard (`Cytale.Gateway.PayloadsTest`) exists to prevent.

  `MessageDelete` carries `channel_id` because the fan-out re-derives its
  delivery route from the PAYLOAD, not from the channel handed to
  `Cytale.Publish.publish/2`: without one the event resolves to the
  workspace-wide route that no session subscribes to and reaches nobody in
  silence (#109, #110).
  """

  @doc """
  MESSAGE_DELETE payload (a message row: id, parent channel, thread scope).

  `thread_id` is present-but-null for channel messages — deletion is
  terminal, so identity fields only; the wire shape is the three keys and
  nothing else.
  """
  @spec message_delete(Cytale.Messages.t()) :: map()
  def message_delete(message) do
    %{
      "id" => Integer.to_string(message.id),
      "channel_id" => Integer.to_string(message.channel_id),
      "thread_id" => message.thread_id && Integer.to_string(message.thread_id)
    }
  end
end
