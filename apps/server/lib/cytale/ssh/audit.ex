defmodule Cytale.SSH.Audit do
  @moduledoc """
  The SSH certificate audit trail (R6a issuance, R8b bridge mints).

  One append-only partition per account, ordered newest-first by event id, so
  an operator answers "what was issued or minted for this member, and what was
  refused" with a single partition read (`list_for_account/2`). Events with no
  resolved account — an unknown serial, a missing or wrong bridge credential —
  land in the reserved partition `unknown_account_id/0` (0), because an audit
  entry that needs an account in order to exist is an audit entry the
  interesting cases cannot produce.

  ## Why this table outlives the account

  The plan is explicit that the audit trail is the DETECTION path for a
  compromise it cannot prevent: a stolen CA key mints certificates for any
  account, and the only signal is the record of what was issued and minted.
  Deleting the record with the account would delete the signal exactly when it
  matters, so the account-deletion cascade DE-IDENTIFIES instead
  (`deidentify_account/1`): the rows are rewritten into the unknown-account
  partition with the same event id, and the account reference (the id and the
  principal, which in this product IS the username) is removed. What survives
  is what detection actually consumes — the serial, the key fingerprint, the
  time, the action, the outcome and the reason.

  ## Failures are reported, never swallowed

  `record/1` returns `:ok` or `{:error, reason}` and logs a failed write at
  `:error` level plus a `[:cytale, :ssh, :audit_write_failure]` telemetry
  count. It does NOT raise and it does not abort the caller's operation: the
  audit write shares a database with the thing being audited, so treating a
  failed write as a failed issuance would turn a transient blip into an
  authentication outage. What the plan asks for is that the failure is LOUD —
  a best-effort write that silently disappears removes the signal without
  saying so — and that is what this does.
  """

  alias Cytale.Repo

  require Logger

  @unknown_account_id 0

  @typedoc "What happened. Issuance and mint both have an accept and a refusal."
  @type action :: :issued | :issue_refused | :minted | :mint_refused | :key_removed

  @typedoc """
  One audit entry. `account_id` may be `unknown_account_id/0` when no account
  resolved (an unknown serial, a refused credential).
  """
  @type event :: %{
          account_id: integer() | nil,
          action: action(),
          outcome: :ok | :refused,
          reason: atom() | nil,
          serial: integer() | nil,
          principal: String.t() | nil,
          fingerprint: String.t() | nil,
          occurred_at: DateTime.t() | nil
        }

  @doc "The partition reserved for events with no resolved account."
  @spec unknown_account_id() :: integer()
  def unknown_account_id, do: @unknown_account_id

  @doc """
  Append one entry. Returns `:ok` when it landed, `{:error, reason}` when it did
  not — with the failure logged and counted either way. Never raises.
  """
  @spec record(event()) :: :ok | {:error, term()}
  def record(event) when is_map(event) do
    occurred_at = event[:occurred_at] || DateTime.utc_now() |> DateTime.truncate(:millisecond)
    account_id = event[:account_id] || @unknown_account_id

    case Repo.execute(
           "INSERT INTO {{K}}.ssh_certificate_audit (account_id, event_id, action, outcome, reason, serial, principal, fingerprint, occurred_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
           [
             {"bigint", account_id},
             {"bigint", Cytale.Snowflake.next()},
             {"text", to_string(event.action)},
             {"text", to_string(event[:outcome] || :ok)},
             {"text", event[:reason] && to_string(event[:reason])},
             {"bigint", event[:serial]},
             {"text", event[:principal]},
             {"text", event[:fingerprint]},
             {"timestamp", occurred_at}
           ]
         ) do
      {:ok, _} -> :ok
      {:error, reason} -> report_failure(event, reason)
    end
  rescue
    # A raise (an unreachable cluster, a driver-level failure) is a failed write
    # like any other: reported, never escalated into the caller's operation.
    e -> report_failure(event, e)
  end

  @doc """
  One account's entries, newest first. An unknown account id yields `[]` rather
  than erroring, so a caller can ask about any id safely.
  """
  @spec list_for_account(integer(), pos_integer()) :: [map()]
  def list_for_account(account_id, limit \\ 100) when is_integer(account_id) do
    Repo.execute!(
      "SELECT event_id, action, outcome, reason, serial, principal, fingerprint, occurred_at FROM {{K}}.ssh_certificate_audit WHERE account_id = ? LIMIT ?",
      [{"bigint", account_id}, {"int", limit}]
    )
    |> Enum.map(fn row ->
      %{
        event_id: row["event_id"],
        account_id: account_id,
        action: to_action(row["action"]),
        outcome: to_outcome(row["outcome"]),
        reason: row["reason"],
        serial: row["serial"],
        principal: row["principal"],
        fingerprint: row["fingerprint"],
        occurred_at: row["occurred_at"]
      }
    end)
    |> Enum.sort_by(& &1.event_id, :desc)
  end

  @doc """
  Re-home an account's entries into the unknown-account partition and drop the
  account reference from them. The deletion cascade calls this instead of
  deleting the trail (see the moduledoc), and it is idempotent: entries already
  de-identified are not in the account's partition to begin with.
  """
  @spec deidentify_account(integer()) :: :ok
  def deidentify_account(account_id) when is_integer(account_id) do
    if account_id != @unknown_account_id do
      account_id
      |> list_for_account(1_000)
      |> Enum.each(fn event ->
        :ok = write_deidentified(event)
        :ok = delete_event(account_id, event.event_id)
      end)
    end

    :ok
  end

  # ---------------------------------------------------------------------------
  # internals
  # ---------------------------------------------------------------------------

  defp write_deidentified(event) do
    Repo.execute!(
      "INSERT INTO {{K}}.ssh_certificate_audit (account_id, event_id, action, outcome, reason, serial, principal, fingerprint, occurred_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [
        {"bigint", @unknown_account_id},
        {"bigint", event.event_id},
        {"text", to_string(event.action)},
        {"text", to_string(event.outcome)},
        {"text", event.reason},
        {"bigint", event.serial},
        # The account reference is the id AND the principal (R4 makes the
        # principal the member's username). Both go; the detection signal —
        # serial, fingerprint, time, action, outcome, reason — stays.
        {"text", nil},
        {"text", event.fingerprint},
        {"timestamp", event.occurred_at}
      ]
    )

    :ok
  end

  defp delete_event(account_id, event_id) do
    Repo.execute!(
      "DELETE FROM {{K}}.ssh_certificate_audit WHERE account_id = ? AND event_id = ?",
      [{"bigint", account_id}, {"bigint", event_id}]
    )

    :ok
  end

  defp report_failure(event, reason) do
    Logger.error(
      "SSH audit write failed (action=#{inspect(event[:action])} outcome=#{inspect(event[:outcome])} " <>
        "serial=#{inspect(event[:serial])}): #{inspect(reason)}"
    )

    :telemetry.execute([:cytale, :ssh, :audit_write_failure], %{count: 1}, %{
      action: event[:action]
    })

    {:error, reason}
  rescue
    # Reporting must never be the reason a caller fails harder than the write did.
    _ -> {:error, reason}
  end

  defp to_action(value) when is_binary(value) do
    case value do
      "issued" -> :issued
      "issue_refused" -> :issue_refused
      "minted" -> :minted
      "mint_refused" -> :mint_refused
      "key_removed" -> :key_removed
      other -> other
    end
  end

  defp to_action(value), do: value

  defp to_outcome("ok"), do: :ok
  defp to_outcome("refused"), do: :refused
  defp to_outcome(value), do: value
end
