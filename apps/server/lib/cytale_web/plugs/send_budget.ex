defmodule CytaleWeb.Plugs.SendBudget do
  @moduledoc """
  The ONE message-send rate budget, applied to all four send routes
  (`CytaleWeb.SendRoutes`) for every sender — a person or a bot, on the
  native or the Discord-compatible surface. A sender has the same budget
  whichever route and dialect it posts through, and the routes share its
  counters: five sends natively and five through compat into one channel are
  ten sends into that channel.

  Two fixed-window buckets (`Cytale.Config.send_budget/0`, where the numbers
  and their reasons live):

    * per sender, per CONVERSATION — the path's channel or thread id;
    * per sender, across all conversations.

  The counters are the native rate plug's (same algorithm, same supervised
  table, swept on the same cadence). Every other request keeps its own
  budget: the native `:api` account bucket and the compat route classes step
  aside for sends and apply to everything else as before (the native per-IP
  ceiling still covers sends).

  The answer is in the route's DIALECT, so neither surface's clients see the
  other's shape:

    * native — `X-RateLimit-Limit`/`-Remaining`/`-Reset-After`, and a 429
      with `Retry-After`, `X-RateLimit-Scope` and `{error: {key:
      "rate_limited", code: 42901, message, scope, retry_after_ms}}`
      (`CytaleWeb.Plugs.RateLimit`'s rendering);
    * compat — Discord's `X-RateLimit-Limit`/`-Remaining`/`-Reset`/
      `-Reset-After`/`-Bucket`, and a 429 with `Retry-After`,
      `X-RateLimit-Scope: user` and `{message, code: 0, retry_after, global:
      false}` (`CytaleWeb.Compat.RateLimit`'s rendering).

  The headers describe the bucket CLOSER to exhaustion (on a 429, the one
  that tripped), so a client pacing by them never trips the other.

  WHICH limit tripped is data in both dialects, named once (`@limits`): the
  native `scope` — `"conversation"` or `"sender"` — in the body and the
  `X-RateLimit-Scope` header; on compat, whose `X-RateLimit-Scope` only has
  Discord's `user`/`global`/`shared` (both limits are `user` there, as a
  channel's own bucket is in Discord's model), the `X-RateLimit-Bucket` id,
  one fixed id per limit, which Discord clients key their queues by.
  """

  @behaviour Plug

  alias CytaleWeb.Compat.RateLimit, as: Compat
  alias CytaleWeb.Plugs.RateLimit, as: Native
  alias CytaleWeb.SendRoutes

  @impl true
  def init(opts), do: opts

  @impl true
  def call(conn, _opts) do
    with {dialect, target} <- SendRoutes.target(conn),
         %{user_id: user_id} <- conn.assigns[:current_user] do
      apply_budget(conn, dialect, user_id, target)
    else
      _ -> conn
    end
  end

  defp apply_budget(conn, dialect, user_id, target) do
    %{conversation: {conv_limit, conv_window}, principal: {all_limit, all_window}} =
      Cytale.Config.send_budget()

    now = System.system_time(:millisecond)
    conversation = bucket(:send_conversation, {:user, user_id, target}, conv_limit, conv_window, now)

    if tripped?(conversation) do
      refuse(conn, dialect, conversation, now)
    else
      principal = bucket(:send_principal, {:user, user_id}, all_limit, all_window, now)

      if tripped?(principal),
        do: refuse(conn, dialect, principal, now),
        else: stamp(conn, dialect, Enum.min_by([conversation, principal], &remaining/1), now)
    end
  end

  # The ONE naming of each send limit, read by both dialects: `wire_scope` is
  # the native 429's `scope` (body and `X-RateLimit-Scope`); `compat_bucket`
  # seeds the compat `X-RateLimit-Bucket` id. The seeds are the ids the
  # buckets have always carried, so a Discord client's learned bucket map
  # survives.
  @limits %{
    send_conversation: %{wire_scope: "conversation", compat_bucket: "send:send_conversation"},
    send_principal: %{wire_scope: "sender", compat_bucket: "send:send_principal"}
  }

  defp bucket(scope, identity, limit, window_ms, now) do
    key = {scope, identity}
    {count, window_end} = Native.consume(key, limit, window_ms, now)
    %{wire_scope: wire_scope} = Map.fetch!(@limits, scope)

    %{
      scope: scope,
      wire_scope: wire_scope,
      key: key,
      limit: limit,
      window_ms: window_ms,
      count: count,
      window_end: window_end
    }
  end

  defp tripped?(%{count: count, limit: limit}), do: count > limit
  defp remaining(%{count: count, limit: limit}), do: limit - count

  # -- the dialects -------------------------------------------------------------------

  defp stamp(conn, :native, b, now), do: Native.stamp_headers(conn, b.limit, b.count, b.window_end, now)

  defp stamp(conn, :compat, b, now),
    do: Compat.stamp_headers(conn, b.limit, b.count, b.window_end, retry_ms(b, now), compat_bucket(b))

  defp refuse(conn, :native, b, now), do: Native.refuse(conn, b, now)

  defp refuse(conn, :compat, b, now) do
    retry_ms = retry_ms(b, now)

    conn
    |> Compat.stamp_headers(b.limit, b.count, b.window_end, retry_ms, compat_bucket(b))
    |> Compat.maybe_limited(b.count, b.limit, retry_ms,
      bucket: compat_bucket(b),
      key: b.key,
      scope: b.scope,
      window_ms: b.window_ms
    )
  end

  defp retry_ms(b, now), do: max(1, b.window_end - now)

  # Discord's `X-RateLimit-Bucket`: one id per LIMIT, so a Discord client
  # tells the conversation limit from the sender's by it. The conversation id
  # stays out of it — it is the major parameter, as a channel id is in
  # Discord's own buckets, and Discord clients key a queue by bucket + major
  # parameter — so a sender's id for one conversation never changes.
  defp compat_bucket(%{scope: scope}), do: Compat.bucket(Map.fetch!(@limits, scope).compat_bucket)
end
