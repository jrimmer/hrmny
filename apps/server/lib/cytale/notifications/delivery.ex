defmodule Cytale.Notifications.Delivery do
  @moduledoc """
  Where a decided notification goes (plan U4).

  A behaviour with a configured implementation, mirroring `Cytale.Publish`:
  the dispatcher decides, this seam delivers, and swapping the implementation
  never touches a call site. The real implementation sends web push and the
  desktop shell's native notifications; the configured default records the
  decision and sends nothing, which is what keeps the suite hermetic and what
  makes a notification decision assertable without a push service.

  Only `:push` verdicts reach an implementation. A `:badge` is in-app state
  the member sees on their next look, and `:none` is nothing at all — neither
  is a delivery channel's business, and passing them here would tempt an
  implementation into inventing one.
  """

  @typedoc "One decided, deliverable notification."
  @type notification :: %{
          user_id: integer(),
          verdict: :push,
          rule: atom(),
          level: String.t(),
          decided_by: atom(),
          event_name: String.t(),
          payload: map()
        }

  @callback deliver([notification()]) :: :ok

  @doc "Configured implementation module."
  @spec impl() :: module()
  def impl do
    Application.get_env(:cytale, __MODULE__, Cytale.Notifications.Delivery.Log)
  end

  @doc """
  Hand the pushable verdicts to the configured implementation.

  Fire-and-forget: a delivery failure must never propagate into the fan-out
  that produced it, because a member losing a notification is recoverable and
  the whole workspace losing the message is not.
  """
  @spec deliver([notification()]) :: :ok
  def deliver(notifications) when is_list(notifications) do
    impl().deliver(notifications)
  rescue
    error ->
      # Never raise into the fan-out. A broken delivery impl degrades to "no
      # notification", which is the correct failure direction for this
      # feature.
      require Logger
      Logger.warning("notification delivery failed: #{inspect(error)}")
      :ok
  end
end

defmodule Cytale.Notifications.Delivery.Log do
  @moduledoc """
  Default implementation: records the decision, sends nothing.

  This is the `:test` and pre-sender default. It exists so the fan-out's
  notification path is exercised end to end (policy reads, focus consult,
  verdict formation) by suites that have no push service and want no egress.
  """

  @behaviour Cytale.Notifications.Delivery

  require Logger

  @impl true
  def deliver([]), do: :ok

  def deliver(notifications) do
    Enum.each(notifications, fn %{user_id: user_id, rule: rule, event_name: name} ->
      Logger.info("notification: user=#{user_id} event=#{name} rule=#{rule}")
    end)

    :ok
  end
end

defmodule Cytale.Notifications.Delivery.Push do
  @moduledoc """
  The real implementation: send each verdict to the recipient's devices.

  This is the join between the decision and the transport — the dispatcher
  produces verdicts, `Cytale.Notifications.WebPush` knows how to send one, and
  this walks from the first to the second. Without it every notification
  decided in the fan-out stopped at a log line.

  ## Per recipient, not per session

  A member's subscriptions are per DEVICE, and a member may have several. Each
  is sent independently, and each is retired independently when the push
  service reports it gone (R18) — one dead phone must not stop the laptop from
  being told.

  ## Fire-and-forget

  Sends run in a supervised task. A push service having a bad afternoon must
  not add its latency to message fan-out, and the caller has already delivered
  the message by the time this runs. `Delivery.deliver/1` also rescues, so a
  failure here can never propagate upward.
  """

  @behaviour Cytale.Notifications.Delivery

  require Logger

  alias Cytale.Notifications.{Mentions, Preview, Subscriptions, WebPush}

  @impl true
  def deliver([]), do: :ok

  def deliver(notifications) do
    {:ok, _pid} =
      Task.Supervisor.start_child(Cytale.Notifications.TaskSupervisor, fn ->
        Enum.each(notifications, &send_to_member/1)
      end)

    :ok
  end

  defp send_to_member(%{user_id: user_id, payload: payload} = notification) do
    subscriptions = Subscriptions.list_for_user(user_id)

    # A WITNESS for the zero-subscription case, which is otherwise completely
    # silent: a member who should be notified, has no push target, and is not
    # connected simply hears nothing, and there is no trace anywhere saying
    # why. That silence is indistinguishable from a broken pipeline — the
    # owner reported exactly that ("I was mentioned and nothing happened") and
    # the logs could not answer it.
    if subscriptions == [] do
      Logger.info(
        "notification for user #{user_id} has no push target " <>
          "(rule=#{notification.rule}); they are reachable in-app only"
      )
    end

    Enum.each(subscriptions, fn subscription ->
      send_one(subscription, notification, payload)
    end)
  end

  defp send_one(%{target_type: "web"} = subscription, notification, _payload) do
    body = WebPush.notification_body(payload_for(notification))

    case WebPush.send_to(subscription,
           user_id: notification.user_id,
           message: body
         ) do
      :ok ->
        # The success case was silent too, so "did a push actually go out" had
        # no answer short of watching the browser.
        Logger.info("push sent to user #{notification.user_id} (rule=#{notification.rule})")
        :ok

      {:gone, reason} ->
        # Already retired by the sender; this is the record of why.
        Logger.info("push subscription retired (#{inspect(reason)}) for user #{notification.user_id}")

      {:error, reason} ->
        # Left in place deliberately: a transient failure is not an
        # unsubscribe, and the next message is the retry.
        Logger.warning("push send failed for user #{notification.user_id}: #{inspect(reason)}")
    end
  end

  @doc """
  Send a probe notification to one member's devices, out of band (operator use).

  Deliberately NOT the fan-out path: this asks "can this member be notified at
  all", not "should they be told about this message". It therefore ignores the
  policy, the focus check and the preference ladder — the operator is testing
  the TRANSPORT, and a probe that answered "nothing sent" because the channel
  happened to be muted would be useless as a diagnostic.

  Returns a summary rather than raising, because the interesting outcomes are
  states: no target means the member will never be notified and that IS the
  answer to the question.
  """
  @spec send_probe(integer(), keyword()) :: map()
  def send_probe(user_id, opts \\ []) when is_integer(user_id) do
    body = Keyword.get(opts, :message, "Test notification from the admin API")
    subscriptions = Subscriptions.list_for_user(user_id)

    if subscriptions == [] do
      %{sent: 0, targets: 0, outcomes: [], note: "this member has no push target registered"}
    else
      outcomes =
        Enum.map(subscriptions, fn subscription ->
          probe_one(subscription, user_id, body)
        end)

      sent = Enum.count(outcomes, &(&1 == :ok))

      %{sent: sent, targets: length(subscriptions), outcomes: outcomes}
    end
  end

  defp probe_one(subscription, user_id, body) do
    case WebPush.send_to(subscription, user_id: user_id, message: body) do
      :ok -> :ok
      {:gone, reason} -> {:gone, reason}
      {:error, reason} -> {:error, reason}
    end
  end

  # A mobile token has no sender yet (R14 keeps the model ready). Reported as
  # an explicit not-yet-delivered rather than an error, so the path is visible
  # in logs without looking like a fault.
  defp send_one(%{target_type: target}, notification, _payload) do
    Logger.info("push target type #{inspect(target)} has no sender yet (user #{notification.user_id})")

    :ok
  end

  defp payload_for(%{event_name: _name, payload: payload} = notification) do
    channel_id = to_int(payload["channel_id"])
    author_id = to_int(payload["author_id"])
    channel = channel_id && Cytale.Workspaces.get_channel(channel_id)
    content = payload["content"]

    %{
      target: %{
        workspace_id: payload["workspace_id"],
        channel_id: payload["channel_id"],
        thread_id: payload["thread_id"],
        message_id: payload["id"]
      },
      # Titled by CONVERSATION, not by product name: the OS already shows the
      # app, so an app name here spends the most readable line on the one fact
      # the member does not need.
      title:
        Preview.title(
          channel_name: channel && channel.name,
          author_name: author_name_for(payload, author_id),
          is_dm: dm?(channel_id)
        ),
      body:
        Preview.body(content,
          names: mention_names(content),
          channel_names: channel_names_for(content, Map.get(notification, :user_id))
        ),
      # A notification with no icon renders as the browser's generic mark,
      # which communicates nothing. An explicit absolute URL is required: the
      # push service fetches it, so a relative path resolves against ITS
      # origin and 404s.
      icon: notification_icon(author_id)
    }
  end

  # The author's avatar when they have one, else the app mark. Both must be
  # absolute for the push service to fetch them.
  defp notification_icon(author_id) do
    base = public_origin()
    if base == nil, do: nil, else: base <> app_icon_path(author_id)
  rescue
    _ -> nil
  end

  defp app_icon_path(author_id) do
    case author_id && Cytale.Accounts.User.get(author_id) do
      %{avatar_url: url} when is_binary(url) and url != "" -> url
      _ -> "/icons/icon-192.png"
    end
  end

  # Same origin the app advertises externally; nil when unconfigured, in which
  # case no icon is sent rather than a broken one.
  defp public_origin do
    case Cytale.Config.external_base_url() do
      url when is_binary(url) and url != "" -> String.trim_trailing(url, "/")
      _ -> nil
    end
  rescue
    _ -> nil
  end

  defp to_int(nil), do: nil

  defp to_int(value) when is_integer(value), do: value

  defp to_int(value) when is_binary(value) do
    case Integer.parse(value) do
      {int, ""} -> int
      _ -> nil
    end
  end

  defp to_int(_other), do: nil

  # A DM has no workspace (the channel row is a `dm_channels` entry), which is
  # the same discriminator the call surfaces use.
  defp dm?(nil), do: false

  defp dm?(channel_id) do
    Cytale.Workspaces.get_channel(channel_id) == nil and Cytale.Workspaces.get_dm(channel_id) != nil
  rescue
    _ -> false
  end

  # The sender's name the way the app shows it: a webhook message's own
  # per-message identity first (the name the webhook posted under — never the
  # account behind it), then the author's account (a person's display name or
  # username, a bot's label).
  @doc false
  def author_name_for(%{"author_override" => %{"username" => name}}, _author_id)
      when is_binary(name) and name != "",
      do: name

  def author_name_for(_payload, nil), do: nil
  def author_name_for(_payload, author_id), do: display_name_for(author_id)

  defp display_name_for(user_id) do
    case Cytale.Accounts.User.get(user_id) do
      nil -> nil
      user -> user.display_name || user.username
    end
  rescue
    _ -> nil
  end

  # Only the ids the message actually mentions are resolved, so an ordinary
  # message costs nothing extra. An id we cannot resolve is left out on
  # purpose: Preview renders an unknown mention as "@someone" rather than a
  # snowflake, so a missing name degrades to a word instead of leaking an
  # internal identifier to a member's lock screen.
  # `<#id>` references the RECIPIENT may see named: a workspace channel they
  # hold VIEW_CHANNEL on, through the one resolver the REST gate uses. Anything
  # else (a private channel they are outside, a deleted one, a DM) is left out
  # and reads as `#channel`, so a push never discloses a name the app would not.
  @doc false
  def channel_names_for(content, user_id) when is_integer(user_id) do
    content
    |> Preview.channel_ids()
    |> Enum.reduce(%{}, fn channel_id, acc ->
      with %{workspace_id: ws, name: name} when is_integer(ws) and is_binary(name) <-
             Cytale.Workspaces.get_channel(channel_id),
           {:ok, bits} <- Cytale.Permissions.Principal.resolve(ws, %{user_id: user_id}, channel_id),
           true <- Cytale.Permissions.Bitfield.has?(bits, :view_channel) do
        Map.put(acc, channel_id, name)
      else
        _ -> acc
      end
    end)
  rescue
    _ -> %{}
  end

  def channel_names_for(_content, _user_id), do: %{}

  defp mention_names(content) do
    content
    |> Cytale.Notifications.Mentions.user_ids()
    |> Enum.reduce(%{}, fn user_id, acc ->
      case display_name_for(user_id) do
        nil -> acc
        name -> Map.put(acc, user_id, name)
      end
    end)
  rescue
    _ -> %{}
  end
end

defmodule Cytale.Notifications.Delivery.Recorder do
  @moduledoc """
  Test implementation: accumulates delivered notifications so a suite can
  assert what the fan-out decided.

  Configure with `config :cytale, Cytale.Notifications.Delivery,
  Cytale.Notifications.Delivery.Recorder`, then `start/0` and `notifications/0`.
  Kept in `lib` rather than `test/support` because the config layer resolves
  it before the support tree is compiled.
  """

  @behaviour Cytale.Notifications.Delivery

  use Agent

  @name __MODULE__

  @doc """
  Start (or reset) the recorder.

  Unlinked on purpose. A recorder linked to the test that started it died
  with that test, asynchronously, so the next test's `start/0` could find the
  dying one still registered, reset it, and then lose it mid-test (`no
  process` from `notifications/0`). One long-lived recorder, reset per test,
  has no such gap.
  """
  @spec start() :: :ok
  def start do
    case Agent.start(fn -> [] end, name: @name) do
      {:ok, _pid} -> :ok
      {:error, {:already_started, _pid}} -> Agent.update(@name, fn _ -> [] end)
    end
  end

  @doc "Every notification delivered since the last `start/0`, oldest first."
  @spec notifications() :: [Cytale.Notifications.Delivery.notification()]
  def notifications do
    Agent.get(@name, & &1)
  end

  @impl true
  def deliver(notifications) do
    case Process.whereis(@name) do
      nil -> :ok
      _pid -> Agent.update(@name, fn acc -> acc ++ notifications end)
    end

    :ok
  end
end

defmodule Cytale.Notifications.PushMetrics do
  @moduledoc """
  The web-push ENABLED signal (7.12) — "this deploy has no sender" made
  scrapeable.

  Web push signs with a VAPID keypair the operator must generate
  (`scripts/vapid-keys.sh`). With either half absent the app deliberately still
  boots and falls back to `Cytale.Notifications.Delivery.Log`, which records the
  decision and sends nothing: on a by-the-book deploy push is silently OFF, and
  nothing said so. The gauge is that missing signal — a rule can alert on
  `cytale_push_enabled 0` instead of an operator learning it from a member who
  was never notified.

  Unlike the backups/error-alert families (which render nothing before their
  scheduler has run), this family is ALWAYS exposed: "is push on" has a definite
  answer on every node, so an absent `0` must not be confusable with a scrape
  that failed. The convention is the same (`exposition/0` appended to `/metrics`
  by `CytaleWeb.MetricsController`).
  """

  @doc "True when the configured delivery implementation is the real push sender."
  @spec enabled?() :: boolean()
  def enabled?, do: Cytale.Notifications.Delivery.impl() == Cytale.Notifications.Delivery.Push

  @doc "The `cytale_push_enabled` family in Prometheus text format (always present)."
  @spec exposition() :: String.t()
  def exposition do
    "# HELP cytale_push_enabled 1 when a VAPID keypair is configured and web push delivery is on; 0 = notifications are logged, not sent.\n" <>
      "# TYPE cytale_push_enabled gauge\n" <>
      "cytale_push_enabled #{if enabled?(), do: 1, else: 0}\n"
  end
end
