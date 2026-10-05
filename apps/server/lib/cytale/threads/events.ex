defmodule Cytale.Threads.Events do
  @moduledoc """
  Thread gateway event payload builders (U12) — the wire contract shared with
  the `@cytale/protocol` package (CamelCase event names, snowflake ids as
  decimal strings). These build the `d` payloads; the fan-out path delivers
  them as `{event_name, payload}` through `Cytale.Publish`.

  Event names (protocol `EventName` union):
    * `ThreadCreate`
    * `ThreadUpdate`
    * `ThreadDelete`
    * `ThreadMemberAdd`
    * `ThreadMemberRemove`
    * `ThreadListSync`
    * `ThreadMessageCreate`

  Channel-scoped payloads here (`ThreadCreate`, `ThreadUpdate`, `ThreadDelete`,
  `ThreadMessageCreate`) carry `channel_id` because the fan-out re-derives its
  delivery route from the PAYLOAD, not from the channel handed to
  `Cytale.Publish.publish/2`: without one the event resolves to the
  workspace-wide route that no session subscribes to and reaches nobody in
  silence (#109, #110). The builders with no producer yet — `thread_member_add/2`,
  `thread_member_remove/2`, `thread_list_sync/2` — carry `thread_id` only, so a
  producer added for one of them must bring the channel anchor with it, the way
  #109 had to add it to `ThreadUpdate`.
  """

  alias Cytale.Threads.Member
  alias Cytale.Threads.Thread

  @doc """
  THREAD_CREATE payload.

  `parent_message_id` is the seed message the thread hangs off (`nil` for a
  standalone thread). It is what lets a client that did NOT create the thread
  draw the reply indicator on the seed message: without it, a thread a bot, a
  webhook, another person or another device started on your message stayed
  invisible until a reload refetched the roster, and replies landed in it
  unseen (approval prompts timed out that way). The roster read
  (`GET /channels/:id/threads`) has always carried the field; the live event
  now matches it.
  """
  @spec thread_create(Thread.t()) :: map()
  def thread_create(t) do
    %{
      "id" => Integer.to_string(t.thread_id),
      "channel_id" => Integer.to_string(t.channel_id),
      "parent_message_id" => snowflake_or_nil(Map.get(t, :parent_message_id)),
      "name" => t.name,
      "created_by" => Integer.to_string(t.created_by),
      # nil-guarded. The compat thread controller used to keep a PRIVATE copy of
      # this payload for two reasons, and this was one of them: an unguarded
      # `DateTime.to_iso8601/1` raises on a nil `created_at`. Fixing it here
      # removes the reason for the copy, so both surfaces share ONE producer
      # (hardening plan 4.10).
      "created_at" => t.created_at && DateTime.to_iso8601(t.created_at)
    }
  end

  @doc """
  THREAD_UPDATE payload (name/archived changes).

  `channel_id` is not decoration: the fan-out routes a publish by the CHANNEL
  the PAYLOAD names (`Workspaces.Workspace.handle_cast/2` → `route_for/1`), not
  by the channel the caller passed to `Publish.publish/2` — so a payload
  without one resolves to the `{:workspace, :all}` route that
  `fanout_route_keys/2` gives no session, and the event is delivered to nobody
  in silence. `ThreadCreate` and `ThreadDelete` have always carried it; this
  one had no producer until #109, which is how the omission survived.

  `parent_message_id` rides along for the reason `thread_create/1` carries it:
  a client that missed the create (it connected after it) still learns where
  the thread's indicator belongs. The anchor never changes, so restating it is
  always true.
  """
  @spec thread_update(Thread.t(), map()) :: map()
  def thread_update(t, changes) do
    %{
      "id" => Integer.to_string(t.thread_id),
      "channel_id" => Integer.to_string(t.channel_id),
      "parent_message_id" => snowflake_or_nil(Map.get(t, :parent_message_id)),
      "name" => Map.get(changes, :name, t.name),
      "archived" => Map.get(changes, :archived, t.archived)
    }
  end

  @doc "THREAD_DELETE payload."
  @spec thread_delete(Thread.t()) :: map()
  def thread_delete(t) do
    %{
      "id" => Integer.to_string(t.thread_id),
      "channel_id" => Integer.to_string(t.channel_id)
    }
  end

  @doc "THREAD_MEMBER_ADD payload."
  @spec thread_member_add(integer(), integer()) :: map()
  def thread_member_add(thread_id, user_id) do
    %{
      "thread_id" => Integer.to_string(thread_id),
      "user_id" => Integer.to_string(user_id)
    }
  end

  @doc "THREAD_MEMBER_REMOVE payload."
  @spec thread_member_remove(integer(), integer()) :: map()
  def thread_member_remove(thread_id, user_id) do
    %{
      "thread_id" => Integer.to_string(thread_id),
      "user_id" => Integer.to_string(user_id)
    }
  end

  @doc "THREAD_LIST_SYNC payload (bulk followed-thread state for a user)."
  @spec thread_list_sync(integer(), [{Thread.t(), Member.t()}]) :: map()
  def thread_list_sync(workspace_id, followed) do
    %{
      "workspace_id" => Integer.to_string(workspace_id),
      "threads" =>
        Enum.map(followed, fn {t, m} ->
          # Each entry IS a ThreadCreate payload (the protocol says so), so it
          # comes from the same builder — one definition, anchor included.
          thread_create(t)
          |> Map.put("member_state", %{
            "notify" => m.notify,
            "last_read_id" => m.last_read_id && Integer.to_string(m.last_read_id)
          })
        end)
    }
  end

  @doc """
  THREAD_MESSAGE_CREATE payload (a thread reply).

  `channel_id` rides along for the same reason `thread_update/2` carries it
  (#110): the fan-out routes a publish by the channel the PAYLOAD names, so a
  payload without one resolves to the `{:workspace, :all}` route that no
  session subscribes to and the event reaches nobody in silence. The
  `@cytale/protocol` `ThreadMessageCreate` type does not declare the field
  (the wire has carried it all along — `Messages.Message.to_wire/1`, the
  production producer, emits it), which is exactly the shape that made #109
  invisible: a builder that mirrors its type looks correct in isolation.

  The input is the wire-shaped message (`Messages.Message.to_wire/1`), whose
  `channel_id` is always present.
  """
  @spec thread_message_create(map()) :: map()
  def thread_message_create(wire_message) do
    %{
      "id" => wire_message["id"],
      "channel_id" => wire_message["channel_id"],
      "thread_id" => wire_message["thread_id"],
      "author_id" => wire_message["author_id"],
      "content" => wire_message["content"],
      "created_at" => wire_message["created_at"],
      "edited_at" => wire_message["edited_at"]
    }
  end

  # A Thread row's optional snowflake (the anchor is nil for a standalone
  # thread) as its wire string.
  defp snowflake_or_nil(nil), do: nil
  defp snowflake_or_nil(id) when is_integer(id), do: Integer.to_string(id)
end
