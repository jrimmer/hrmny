defmodule Cytale.Accounts.Mailer do
  @moduledoc """
  Provider-agnostic mailer seam (U8). The unit sends exactly two kinds of
  mail — verification and password-reset — so login carries zero external
  dependencies. Adapters swap without touching call sites:

      config :cytale, Cytale.Accounts.Mailer, adapter: MyApp.SMTPAdapter

  The default adapter (`Dev`) writes the mail to a local mailbox FILE and
  never performs network I/O — dev/test require no SMTP infrastructure, and
  it never touches the log (see the P0-3 note on the adapter). A production
  SMTP/API adapter implements the behaviour and is configured per
  environment; the ops runbook owns DKIM/SPF/warm-up for the sending domain
  (deliverability is owned like any other service dependency).

  Metrics (pillars instrumentation, edit #9): `verification_email_delivery_success`
  is emitted here on every send result so the harness can assert
  deliverability rather than assume it.
  """

  require Logger

  @typedoc "The two mails this unit sends."
  @type kind :: :verify_email | :password_reset

  @typedoc "Adapter input for one outgoing mail."
  @type message :: %{
          kind: kind(),
          to: String.t(),
          username: String.t(),
          token: String.t()
        }

  @callback deliver(message()) :: :ok | {:error, term()}

  @doc "Configured adapter module (default: Dev)."
  @spec adapter() :: module()
  def adapter do
    Application.get_env(:cytale, __MODULE__, [])
    |> Keyword.get(:adapter, __MODULE__.Dev)
  end

  @doc """
  Send one mail through the configured adapter. NEVER raises.

  Adapters are third-party code — an SMTP client, an HTTP API, or (Dev) the
  filesystem — so this seam converts whatever they do into
  `:ok | {:error, term()}`; nothing escapes as an exception. Callers keep
  going on `{:error, _}`: the token that could not be mailed is already
  stored, so a request must never fail with its mail sink (a misconfigured
  adapter used to 500 every `POST /api/v1/auth/register` after creating the
  user row). Failures are logged here, at the one seam every adapter shares,
  and counted by the `verification_email_delivery` telemetry.
  """
  @spec deliver(message()) :: :ok | {:error, term()}
  def deliver(%{kind: kind, to: to} = msg) when kind in [:verify_email, :password_reset] do
    result = safe_deliver(msg)

    if result != :ok do
      Logger.error(
        "[mailer] #{kind} delivery FAILED for #{to}: #{inspect(result)} — the request is NOT " <>
          "failed (the pending token is stored, so a resend retries delivery). " <>
          "CYTALE_MAILER=dev writes the token to CYTALE_DEV_MAILBOX, which must be a WRITABLE " <>
          "path: inside a container with a read-only rootfs that means a mounted volume, " <>
          "e.g. /app/priv/search/dev_mailbox.jsonl."
      )
    end

    :telemetry.execute(
      [:cytale, :accounts, :verification_email_delivery],
      %{success: if(result == :ok, do: 1, else: 0)},
      %{kind: kind}
    )

    result
  end

  defp safe_deliver(msg) do
    case adapter().deliver(msg) do
      :ok -> :ok
      {:error, reason} -> {:error, reason}
      other -> {:error, {:unexpected_adapter_return, other}}
    end
  rescue
    e -> {:error, {:adapter_raised, Exception.message(e)}}
  catch
    :exit, reason -> {:error, {:adapter_exited, reason}}
    kind, reason -> {:error, {:adapter_threw, kind, reason}}
  end

  defmodule Dev do
    @moduledoc """
    Development adapter: appends the mail to a local mailbox file so scripts
    and the smoke test can complete verification without scraping logs.

    The token NEVER rides the log (#35 P0-3): log access must never equal
    account takeover. The mailbox FILE is the only token sink — it is the
    dev-mode delivery channel, and prod only reaches this adapter through
    the explicit CYTALE_MAILER=dev opt-in (runtime.exs fails fast otherwise).

    The mailbox must be WRITABLE BY THE RELEASE, which a container with a
    read-only rootfs cannot satisfy for the CWD-relative default
    (`tmp/dev_mailbox.jsonl` → /app/tmp under the image's WORKDIR): point
    CYTALE_DEV_MAILBOX at a mounted volume instead (compose.yaml does).
    """

    @behaviour Cytale.Accounts.Mailer

    require Logger

    @impl true
    def deliver(%{kind: kind, to: to, username: username, token: token}) do
      mailbox = Path.expand(System.get_env("CYTALE_DEV_MAILBOX", "tmp/dev_mailbox.jsonl"))

      Logger.info(
        "[mailer:dev] #{kind} mail for #{username} <#{to}> — token goes to #{mailbox} " <>
          "(dev mode; configure a real adapter in prod)"
      )

      entry =
        Jason.encode!(%{
          kind: kind,
          to: to,
          username: username,
          token: token,
          at: DateTime.utc_now() |> DateTime.to_iso8601()
        }) <> "\n"

      # File.write! here was the live-box outage (2026-09-10): read-only rootfs
      # → the raise propagated out of register AFTER the user row existed,
      # 500ing a request that had already succeeded, and losing the token with
      # it. Report the sink, never raise.
      with :ok <- File.mkdir_p(Path.dirname(mailbox)),
           :ok <- File.write(mailbox, entry, [:append]) do
        :ok
      else
        {:error, reason} -> {:error, {:mailbox_unwritable, mailbox, reason}}
      end
    end
  end
end
