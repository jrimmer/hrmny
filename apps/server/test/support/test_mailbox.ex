defmodule Cytale.TestMailbox do
  @moduledoc """
  Test accessor for the Dev mailer's mailbox file — the dev-mode token
  delivery channel since P0-3 (#35) removed tokens from the log line.

  `capture/3` snapshots the file's line count, runs the send, then returns
  the FIRST new entry matching kind + recipient. The append-only file plus
  the offset makes concurrent async suites safe (interleaved appends from
  other tests never shift earlier lines), and the nonce-unique test emails
  make the recipient filter exact.
  """

  import ExUnit.Assertions

  @spec capture((-> term()), String.t(), String.t()) :: String.t()
  def capture(send_fun, kind, to) do
    mailbox = Path.expand(System.get_env("CYTALE_DEV_MAILBOX", "tmp/dev_mailbox.jsonl"))
    offset = lines(mailbox) |> length()

    send_fun.()

    entry =
      lines(mailbox)
      |> Enum.drop(offset)
      |> Enum.find(&(&1["kind"] == kind and &1["to"] == to))

    assert entry,
           "expected a #{kind} mail for #{to} in #{mailbox} " <>
             "(got #{offset} prior + new entries: #{inspect(Enum.take(lines(mailbox) |> Enum.drop(offset), 3))})"

    entry["token"]
  end

  defp lines(path) do
    case File.read(path) do
      {:ok, body} ->
        body
        |> String.split("\n", trim: true)
        |> Enum.map(&Jason.decode!/1)

      {:error, _} ->
        []
    end
  end
end
