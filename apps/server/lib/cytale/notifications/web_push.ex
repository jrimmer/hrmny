defmodule Cytale.Notifications.WebPush.Transport do
  @moduledoc """
  The HTTP leg, as a swappable behaviour.

  A push send is the one operation in this feature that leaves the process, and
  it is also the one whose interesting outcomes (a deleted subscription, a
  temporary outage, an auth failure) are decided by a remote status code. A
  seam here means those paths are exercised deterministically in tests with no
  egress, which matters because two of them are silent-failure paths in
  production.
  """

  @typedoc "A built push request."
  @type request :: %{
          endpoint: String.t(),
          body: binary(),
          headers: %{String.t() => String.t()}
        }

  @callback post(request(), keyword()) :: {:ok, non_neg_integer()} | {:error, term()}
end

defmodule Cytale.Notifications.WebPush do
  @moduledoc """
  Sends a web push, and retires a subscription the push service says is gone
  (plan U6, R12/R18).

  ## Why this library

  The dependency this replaced (`web_push_encryption` 0.3.1) encoded payloads
  with the older `aesgcm` scheme. Safari and iOS reject `aesgcm` outright, so
  it would have appeared to work on desktop Chrome and Firefox and failed
  silently on the platform this feature most needs — the worst possible
  failure shape, because every desktop test passes. The replacement emits
  `aes128gcm` with a VAPID `Authorization` header, and deliberately builds the
  request without sending it, so the HTTP leg and its retry policy stay here
  (KTD11).

  ## The quiet-failure trap

  A browser that unsubscribes — or is uninstalled, or clears its storage —
  makes its endpoint start answering 404 or 410. A store that keeps that row
  fails silently forever: every send errors, nothing surfaces, and the member
  simply stops hearing about anything. So a gone response DELETES the row.

  The distinction that matters is gone-versus-transient: a 5xx, a timeout, or a
  connection reset leaves the subscription alone, because unsubscribing a
  member over a push service's bad afternoon is a worse outcome than retrying.

  ## What this cannot do

  No platform reports whether a notification was actually displayed. Focus
  modes, OS-level notification settings, and force-quit apps are all invisible
  from here, so silence is treated as unknown rather than as failure — the
  plan's lifecycle contract is pruned on what the push service says, never on
  what a member did not see.
  """

  require Logger

  alias Cytale.Notifications.PushEndpointGuard
  alias Cytale.Notifications.Subscriptions

  @gone_statuses [404, 410]

  @doc """
  Send a notification to one stored subscription.

  Pass `:user_id` so a gone response can retire the row; without it the send
  still happens and only the status is reported.

  Returns `:ok`, `{:gone, reason}` (and removes the row), or
  `{:error, reason}` (and leaves it).
  """
  @spec send_to(map(), keyword()) :: :ok | {:gone, term()} | {:error, term()}
  def send_to(subscription, opts \\ []) do
    with {:ok, parsed} <- parse(subscription),
         :ok <- guard_endpoint(parsed, opts),
         {:ok, request} <- build_request(parsed, opts) do
      post(request, subscription, opts)
    else
      # The guard already retired the row; {:gone, _} is the caller's signal.
      {:gone, _reason} = gone -> gone
      other -> other
    end
  end

  # S1 (SSRF): re-check the endpoint immediately before the POST. A row
  # registered before the guard existed, or whose host re-resolved somewhere
  # private, is treated as PERMANENTLY dead — the same retire path a 404/410
  # takes — never posted to. The log carries host+path only, never a full
  # client-supplied URL.
  defp guard_endpoint(%{endpoint: endpoint}, opts) do
    case PushEndpointGuard.validate(endpoint) do
      :ok ->
        :ok

      {:error, reason} ->
        Logger.warning(
          "web push: endpoint failed the SSRF guard (#{inspect(reason)}); " <>
            "retiring the subscription: #{PushEndpointGuard.log_target(endpoint)}"
        )

        retire(%{endpoint: endpoint}, opts)
        {:gone, {:blocked_endpoint, reason}}
    end
  end

  # -- internals -----------------------------------------------------------------

  defp parse(%{endpoint: endpoint, keys: keys_blob}) when is_binary(endpoint) do
    with {:ok, decoded} <- decode_keys(keys_blob) do
      {:ok, %{endpoint: endpoint, keys: decoded}}
    end
  end

  defp parse(_other), do: {:error, :malformed_subscription}

  defp decode_keys(keys_blob) when is_binary(keys_blob) do
    case Jason.decode(keys_blob) do
      {:ok, %{"p256dh" => p256dh, "auth" => auth}} when is_binary(p256dh) and is_binary(auth) ->
        {:ok, %{p256dh: p256dh, auth: auth}}

      _ ->
        {:error, :malformed_keys}
    end
  end

  defp decode_keys(_other), do: {:error, :malformed_keys}

  # The library signs, encrypts, and assembles the headers; sending is ours.
  #
  # The builder is a configured function rather than a direct call, so the
  # sender's own logic — where the production failure modes live — is testable
  # without reproducing the crypto library's key material. Signing correctness
  # is the library's property and is proven against a live push service on
  # deploy, not by a unit test asserting that bytes exist.
  defp build_request(%{endpoint: endpoint, keys: keys}, opts) do
    message = default_message(opts)
    builder().(endpoint, keys, message)
  rescue
    error ->
      # Missing VAPID configuration lands here. Report it rather than crashing
      # a fan-out: an unconfigured push key is an operator problem, not a
      # reason to lose the message that triggered the send.
      Logger.warning("web push request build failed: #{inspect(error)}")
      {:error, :build_failed}
  end

  @doc false
  # The default builder: sign, encrypt, and assemble through the library.
  @spec library_builder(String.t(), map(), String.t()) :: {:ok, map()} | {:error, term()}
  def library_builder(endpoint, keys, message) do
    subscription = %WebPushEx.Subscription{endpoint: URI.parse(endpoint), keys: keys}
    request = WebPushEx.request(subscription, message)

    {:ok, %{endpoint: request.endpoint, body: request.body, headers: request.headers}}
  end

  defp builder do
    Application.get_env(:cytale, :web_push_builder, &library_builder/3)
  end

  defp default_message(opts) do
    Keyword.get(opts, :message) ||
      Jason.encode!(%{title: "Hrmny", body: "You have a new notification"})
  end

  @doc """
  Encode a notification as the JSON body the service worker reads.

  The worker calls `event.data.json()`, so the body must be a JSON STRING —
  handing a map through would arrive as an object literal the worker cannot
  parse, and every notification would fall back to its generic-text branch.

  The shape matches `public/push-handler.js`: `title`, `body`, and `target`
  carrying the ids the click handler routes on.
  """
  @spec notification_body(map()) :: String.t()
  def notification_body(%{title: title, body: body} = notification) do
    Jason.encode!(%{
      title: title,
      body: body,
      target: Map.get(notification, :target, %{})
    })
  end

  defp post(request, subscription, opts) do
    case transport().post(request, opts) do
      {:ok, status} when status in @gone_statuses ->
        reason = {:gone, status}
        retire(subscription, opts)
        {:gone, reason}

      {:ok, status} when status in 200..299 ->
        :ok

      {:ok, status} ->
        {:error, {:unexpected_status, status}}

      {:error, reason} ->
        {:error, reason}
    end
  end

  # The row is addressed by endpoint, which is what the push service reports,
  # so retiring needs no hash and no extra read.
  defp retire(subscription, opts) do
    case Keyword.get(opts, :user_id) do
      nil ->
        Logger.warning(
          "web push: endpoint reported gone but no user_id was supplied, so the row cannot be retired: #{subscription.endpoint}"
        )

        :ok

      user_id ->
        :ok = Subscriptions.delete_by_endpoint(user_id, subscription.endpoint)
        :ok
    end
  end

  defp transport, do: Application.get_env(:cytale, Cytale.Notifications.WebPush.Transport, __MODULE__.Finch)
end

defmodule Cytale.Notifications.WebPush.Finch do
  @moduledoc """
  The real transport: one POST through the Finch pool the app already runs.

  No retry here. A push that failed transiently is not worth blocking a
  fan-out for, and the alternative — a retry queue — is a scheduler this plan
  deliberately does not add (KTD11). The next message to that member is the
  retry.
  """

  @behaviour Cytale.Notifications.WebPush.Transport

  @impl true
  def post(%{endpoint: endpoint, body: body, headers: headers}, _opts) do
    request = Finch.build(:post, endpoint, Map.to_list(headers), body)

    case Finch.request(request, Cytale.Notifications.WebPush.Finch, receive_timeout: 10_000) do
      {:ok, %Finch.Response{status: status}} -> {:ok, status}
      {:error, reason} -> {:error, reason}
    end
  end
end
