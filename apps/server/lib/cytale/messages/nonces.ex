defmodule Cytale.Messages.Nonces do
  @moduledoc """
  Durable send dedupe: the `message_nonces` reservation table.

  The in-memory Idempotency-Key replay (`CytaleWeb.Plugs.Idempotency`) is the
  fast path, but it cannot carry the guarantee alone: its table dies with the
  node, it records a response only AFTER the controller finished (so a retry
  arriving while the first POST is still running re-executes it), and it
  never records a 5xx — while a 5xx can follow a write that LANDED (a Scylla
  write timeout raises even when the replica applied it; a publish step
  failing after the insert). Each of those turned a client's retry into a
  second copy of the message.

  The reservation closes all of them. Before the message row is written, the
  create path claims `(author_id, nonce)` with a lightweight transaction that
  names the message id this attempt minted. Exactly one attempt wins:

    * the winner writes the message under the reserved id;
    * every other attempt — concurrent or later, on any node, across a
      restart — is told the reserved `{channel_id, message_id}` and answers
      with THAT message instead of creating one.

  Because the id is fixed by the reservation, re-driving a write whose first
  attempt died (the loser finds the reservation but no message row) writes
  the SAME row again — an idempotent upsert, never a second message. The
  claim, the replay and that recovery live in ONE place, the send pipeline
  every route shares (`Cytale.Messages.Send`).

  Thread replies share the table as-is: a reply is an ordinary `messages`
  row under its PARENT channel, so its reservation names
  `{parent_channel_id, message_id}` and a retry is told apart from a
  timeline message by the reserved row's `thread_id`.

  The TTL (one day) bounds the table: a nonce is a retry key, not an archive.
  """

  alias Cytale.Repo

  @ttl_seconds 86_400

  # A nonce is client-minted and travels as text; the cap keeps a hostile
  # value from growing the partition key without bound.
  @max_nonce_bytes 64

  @doc "Reservation lifetime in seconds."
  @spec ttl_seconds() :: pos_integer()
  def ttl_seconds, do: @ttl_seconds

  @doc """
  Normalize a client-supplied nonce: a non-empty string of at most
  #{@max_nonce_bytes} bytes, or an integer (Discord clients send numeric
  nonces) rendered as its decimal string. Anything else is `nil` — no
  durable dedupe for this request, exactly as before the table existed.
  """
  @spec normalize(term()) :: String.t() | nil
  def normalize(nonce) when is_binary(nonce) and byte_size(nonce) in 1..@max_nonce_bytes, do: nonce
  def normalize(nonce) when is_integer(nonce), do: Integer.to_string(nonce)
  def normalize(_), do: nil

  @doc """
  Claim `(author_id, nonce)` for `{channel_id, message_id}`.

  Returns `:claimed` when this call won the reservation, or
  `{:existing, channel_id, message_id}` naming the reservation an earlier
  attempt holds. A failed LWT (timeout, unavailable) is `{:error, reason}` —
  the caller decides whether to proceed without dedupe.
  """
  @spec claim(integer(), String.t(), integer(), integer()) ::
          :claimed | {:existing, integer(), integer()} | {:error, term()}
  def claim(author_id, nonce, channel_id, message_id)
      when is_integer(author_id) and is_binary(nonce) and is_integer(channel_id) and is_integer(message_id) do
    case Repo.query(
           "INSERT INTO {{K}}.message_nonces (author_id, nonce, channel_id, message_id) VALUES (?, ?, ?, ?) IF NOT EXISTS USING TTL #{@ttl_seconds}",
           [{"bigint", author_id}, {"text", nonce}, {"bigint", channel_id}, {"bigint", message_id}]
         ) do
      {:ok, page} ->
        case page |> Enum.to_list() |> List.first() do
          %{"[applied]" => true} ->
            :claimed

          %{"[applied]" => false, "channel_id" => existing_channel, "message_id" => existing_id}
          when is_integer(existing_channel) and is_integer(existing_id) ->
            {:existing, existing_channel, existing_id}

          other ->
            {:error, {:unexpected_lwt_result, other}}
        end

      {:error, reason} ->
        {:error, reason}
    end
  end

  @await_attempts 10
  @await_interval_ms 100

  @doc """
  The message a reservation names, allowing the first attempt a moment to
  land it (a retry can race the original request's insert). `nil` when it
  never appears — the caller re-drives the write under the reserved id.
  """
  @spec await_message(integer(), integer()) :: Cytale.Messages.t() | nil
  def await_message(channel_id, message_id) when is_integer(channel_id) and is_integer(message_id),
    do: await_message(channel_id, message_id, 1)

  defp await_message(channel_id, message_id, attempt) do
    case Cytale.Messages.get_message(channel_id, message_id) do
      nil when attempt < @await_attempts ->
        Process.sleep(@await_interval_ms)
        await_message(channel_id, message_id, attempt + 1)

      result ->
        result
    end
  end

  @doc "The reservation for `(author_id, nonce)`, if one is live."
  @spec lookup(integer(), String.t()) :: {integer(), integer()} | nil
  def lookup(author_id, nonce) when is_integer(author_id) and is_binary(nonce) do
    "SELECT channel_id, message_id FROM {{K}}.message_nonces WHERE author_id = ? AND nonce = ?"
    |> Repo.query!([{"bigint", author_id}, {"text", nonce}])
    |> Enum.to_list()
    |> case do
      [%{"channel_id" => channel_id, "message_id" => message_id}] -> {channel_id, message_id}
      _ -> nil
    end
  end
end
