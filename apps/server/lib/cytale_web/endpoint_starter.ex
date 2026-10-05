defmodule CytaleWeb.EndpointStarter do
  @moduledoc """
  Starts `CytaleWeb.Endpoint`, retrying a start that loses the race with the
  previous instance's remains.

  When the endpoint crashes, the root supervisor restarts it at once — but the
  dying listener can still hold the port for a few milliseconds, so the new
  listener's bind fails with `:eaddrinuse`. A plain child spec turns each of
  those into an immediate failed restart, and on a loaded host all of the root
  supervisor's restart budget (`max_restarts: 20` in 5 s) went in that window:
  the supervisor gave up and the WHOLE application shut down, 2–8 ms after a
  single endpoint crash. Observed in CI (run 2752: 944 failures) and
  reproduced with two concurrent suites (1026 failures), each time through
  `Cytale.ApplicationTest`'s kill-and-recover test; with supervisor reports
  on, the failed restart read
  `failed to start child: :listener ** (EXIT) :eaddrinuse` and the next
  attempt 16 ms later succeeded.

  The second form of the same race: the killed endpoint's NAMED children
  (`Phoenix.Config` under the endpoint's name) are still going down when the
  restart begins, so the new instance fails with `{:already_started, pid}` —
  twenty times in under a millisecond under load, and the same shutdown
  (reproduced with supervisor reports on: "failed to start child:
  Phoenix.Config ** (EXIT) already started").

  So both conflicts are retried here, inside ONE start attempt, with a short
  backoff and a deadline. Any other start failure is returned unchanged, so a
  real misconfiguration still fails fast.
  """

  require Logger

  @retry_ms 50
  @deadline_ms 5_000

  @doc "The endpoint's child spec, started through the bind-retrying start."
  def child_spec(opts) do
    %{
      id: CytaleWeb.Endpoint,
      start: {__MODULE__, :start_link, [opts]},
      type: :supervisor
    }
  end

  @doc false
  def start_link(opts \\ []) do
    start(opts, System.monotonic_time(:millisecond) + @deadline_ms, 0)
  end

  defp start(opts, deadline, attempts) do
    case CytaleWeb.Endpoint.start_link(opts) do
      {:error, reason} = error ->
        if leftover?(reason) and System.monotonic_time(:millisecond) < deadline do
          if attempts == 0 do
            Logger.warning(
              "endpoint start met the previous instance still going down (#{inspect(reason, limit: 8)}); retrying"
            )
          end

          Process.sleep(@retry_ms)
          start(opts, deadline, attempts + 1)
        else
          error
        end

      ok ->
        ok
    end
  end

  # Either conflict arrives nested in start-failure tuples (endpoint → Bandit
  # server → :listener, or endpoint → Phoenix.Config); look anywhere in the
  # reason.
  defp leftover?(:eaddrinuse), do: true
  defp leftover?({:already_started, pid}) when is_pid(pid), do: true
  defp leftover?(reason) when is_tuple(reason), do: reason |> Tuple.to_list() |> Enum.any?(&leftover?/1)
  defp leftover?(reason) when is_list(reason), do: Enum.any?(reason, &leftover?/1)
  defp leftover?(_), do: false
end
