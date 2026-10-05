defmodule Cytale.Interactions.TokenStore do
  @moduledoc """
  ETS-backed store for short-lived interaction tokens (bots plan U8, KTD13).

  The interaction id in the callback URL + this token are the credential
  pair for `POST /api/v10/interactions/{id}/{token}/callback` — Discord
  libraries send no Authorization header there, so the URL token IS the
  credential. Lifecycle rules:

    * **15-minute life** (config `[:interactions, :token_ttl_ms]`); expiry is
      checked at READ time (correctness never depends on the sweeper) and a
      periodic sweep drops stale rows so the table stays bounded.
    * **Revocation cascade**: interaction tokens are DERIVATIVE credentials
      of the bot principal — `revoke_principal/1` (invoked from
      `Cytale.Accounts.Principals.revoke/1`) purges a principal's
      outstanding tokens, so a bot revoked between invocation and callback
      answers 401, never posts.

  Long-lived-owner rule: a named PUBLIC ETS set owned by this GenServer
  (started in the application tree); readers never touch the owner process.
  Only the SHA-256 hash of a token is stored — the plaintext exists in the
  INTERACTION_CREATE payload and nowhere else.

  Row shape: `{interaction_id, data_map, ack_count}` — the trailing integer
  is the SINGLE-USE ack slot (C-1, Discord parity): `put/3` stores it at `0`
  and `consume_ack/2` is the atomic check-and-set that flips it, so exactly
  ONE type-4 response ever posts as the interaction's ack (followups post
  without touching the slot; see `consume_ack/2`).
  """

  use GenServer

  @table __MODULE__
  # token_hash => {interaction_id, expires_at_ms}: `resolve_by_token/1`'s
  # point lookup. A separate table so the main table's rows (and `count/0`)
  # keep their meaning.
  @index_table Module.concat(__MODULE__, ByHash)
  @sweep_interval_ms 60_000

  # -- Client API ----------------------------------------------------------------

  @doc "Starts the ETS owner (application tree child)."
  @spec start_link(keyword()) :: GenServer.on_start()
  def start_link(_opts \\ []) do
    GenServer.start_link(__MODULE__, :ok, name: __MODULE__)
  end

  @doc """
  Store `token` for `interaction_id` with `data` (the callback's context:
  application/workspace/channel ids + invocation provenance). TTL comes from
  `Cytale.Config.interaction_token_ttl/0`.
  """
  @spec put(integer(), String.t(), map()) :: :ok
  def put(interaction_id, token, data)
      when is_integer(interaction_id) and is_binary(token) and is_map(data) do
    row =
      Map.merge(data, %{
        token_hash: hash(token),
        expires_at_ms: System.system_time(:millisecond) + Cytale.Config.interaction_token_ttl_ms()
      })

    # Third element: the un-consumed single-use ack slot (consume_ack/2).
    true = :ets.insert(table(), {interaction_id, row, 0})
    # The token-hash index `resolve_by_token/1` reads (one lookup, not a scan).
    true = :ets.insert(index_table(), {row.token_hash, interaction_id, row.expires_at_ms})
    :ok
  end

  @doc """
  Fetch the interaction's data when `token` matches and is unexpired.
  Errors: `:unknown_interaction` (no row — never minted, swept, or purged by
  revocation), `:expired`, `:bad_token`.
  """
  @spec fetch(integer(), String.t()) :: {:ok, map()} | {:error, :unknown_interaction | :expired | :bad_token}
  def fetch(interaction_id, token) when is_integer(interaction_id) and is_binary(token) do
    case :ets.lookup(table(), interaction_id) do
      [{^interaction_id, %{token_hash: token_hash, expires_at_ms: expires_at} = data, _ack}] ->
        cond do
          System.system_time(:millisecond) > expires_at -> {:error, :expired}
          hash(token) != token_hash -> {:error, :bad_token}
          true -> {:ok, data}
        end

      [] ->
        {:error, :unknown_interaction}
    end
  end

  @doc """
  Consume the interaction's SINGLE-USE ack (C-1, Discord parity): the first
  type-4 response owns the interaction's reply; every later one is a
  followup. The check-and-set is ONE atomic `:ets.update_counter` hop on the
  row's ack slot — exactly ONE caller (even under concurrency) reads back
  `1` and wins the flip 0→1; every other caller reads a higher value back
  and loses. Replay counts can only climb as high as the callback bucket
  allows (10/15 min), so the unbounded counter is harmless. The token is
  re-verified against the row so a replayed ack never wins on a stale
  credential.

  Errors: `:unknown_interaction` (row gone — swept/purged between the
  caller's `fetch/2` and this hop), `:bad_token`, `:ack_consumed`.
  """
  @spec consume_ack(integer(), String.t()) ::
          :ok | {:error, :ack_consumed | :bad_token | :unknown_interaction}
  def consume_ack(interaction_id, token) when is_integer(interaction_id) and is_binary(token) do
    case :ets.lookup(table(), interaction_id) do
      [{^interaction_id, %{token_hash: token_hash}, _ack}] ->
        if hash(token) == token_hash do
          try do
            case :ets.update_counter(table(), interaction_id, {3, 1}) do
              1 -> :ok
              _already_consumed -> {:error, :ack_consumed}
            end
          rescue
            # The row vanished mid-hop (sweep/revocation race) — nobody wins.
            ArgumentError -> {:error, :unknown_interaction}
          end
        else
          {:error, :bad_token}
        end

      [] ->
        {:error, :unknown_interaction}
    end
  end

  @doc """
  Merge `fields` into the interaction's stored data map — the ONE way
  per-token state extends (components plan U3): the 3-tuple row shape NEVER
  changes, so the ack slot and the token hash stay exactly where they are
  (`update_element` touches ONLY the data slot — a racing `consume_ack/2`
  flip on the counter slot can never be clobbered by this write). The token
  is re-verified against the row's hash; errors mirror `fetch/2` minus
  expiry (a merge racing the sweep is a lost marker, never a corruption —
  the callers' writes are advisory bookkeeping).
  """
  @spec merge_data(integer(), String.t(), map()) :: :ok | {:error, :unknown_interaction | :bad_token}
  def merge_data(interaction_id, token, fields)
      when is_integer(interaction_id) and is_binary(token) and is_map(fields) do
    case :ets.lookup(table(), interaction_id) do
      [{^interaction_id, %{token_hash: token_hash} = data, _ack}] ->
        if hash(token) == token_hash do
          true = :ets.update_element(table(), interaction_id, {2, Map.merge(data, fields)})
          :ok
        else
          {:error, :bad_token}
        end

      [] ->
        {:error, :unknown_interaction}
    end
  end

  @doc """
  Resolve an outstanding interaction by its token ALONE (components plan
  U3): the webhook-shaped continuation routes (`/webhooks/{app}/{token}`)
  carry NO interaction id in the URL, so the token is the only credential
  segment. ONE lookup in the token-hash index (Tier 3 B, 10a — this was a
  full-table fold on an UNAUTHENTICATED route, so every garbage request paid
  a scan of every outstanding interaction), then the row itself is re-checked:
  the exact hash and an unexpired TTL (read-time correctness, never
  sweeper-dependent). An index entry whose row was purged (revocation) is a
  plain miss.
  """
  @spec resolve_by_token(String.t()) :: {:ok, integer(), map()} | {:error, :unknown_interaction}
  def resolve_by_token(token) when is_binary(token) do
    token_hash = hash(token)
    now = System.system_time(:millisecond)

    with [{^token_hash, id, _exp}] <- :ets.lookup(index_table(), token_hash),
         [{^id, %{token_hash: ^token_hash, expires_at_ms: expires} = data, _ack}] when expires > now <-
           :ets.lookup(table(), id) do
      {:ok, id, data}
    else
      _ -> {:error, :unknown_interaction}
    end
  end

  @doc """
  The submit-side read of a modal (#30). A MODAL_SUBMIT comes from the HUMAN
  who invoked the original interaction, and a human never holds the bot's
  token — so this reads by interaction id alone and makes the INVOKER the
  credential instead: it answers only for an unexpired row that carries a
  `modal` (set by the bot's type-9 callback) and whose `invoked_by.user_id` is
  `user_id`. Every miss is the same `:modal_unavailable` — no oracle for other
  users' interactions.
  """
  @spec fetch_modal(integer(), term()) :: {:ok, map()} | {:error, :modal_unavailable}
  def fetch_modal(interaction_id, user_id) when is_integer(interaction_id) do
    now = System.system_time(:millisecond)

    case :ets.lookup(table(), interaction_id) do
      [{^interaction_id, %{modal: %{}, invoked_by: %{user_id: invoker}, expires_at_ms: exp} = data, _ack}]
      when exp > now ->
        # Compared as strings: claims carry the id as either type.
        if to_string(invoker) == to_string(user_id), do: {:ok, data}, else: {:error, :modal_unavailable}

      _ ->
        {:error, :modal_unavailable}
    end
  end

  @doc """
  Claim a modal for submission — SINGLE-USE (#30, Discord parity: a modal
  submits once). `:ets.insert_new` of a claim row is the atomic
  check-and-set: exactly one concurrent submitter wins. The claim row carries
  its own `expires_at_ms`, so the ordinary sweep reaps it with the token.
  """
  @spec claim_modal(integer(), integer()) :: :ok | {:error, :modal_unavailable}
  def claim_modal(interaction_id, expires_at_ms) when is_integer(interaction_id) do
    if :ets.insert_new(table(), {{:modal_claim, interaction_id}, %{expires_at_ms: expires_at_ms}, 0}),
      do: :ok,
      else: {:error, :modal_unavailable}
  end

  @doc """
  Purge every token minted for `application_id` — the derivative-credential
  half of principal revocation. Returns the number of purged rows. Safe
  before boot (no table → 0) so `Principals.revoke/1` can call it
  unconditionally.
  """
  @spec revoke_principal(integer()) :: non_neg_integer()
  def revoke_principal(application_id) when is_integer(application_id) do
    if :ets.whereis(table()) == :undefined do
      0
    else
      :ets.foldl(
        fn
          {id, %{application_id: ^application_id}, _ack}, acc ->
            :ets.delete(table(), id)
            acc + 1

          _, acc ->
            acc
        end,
        0,
        table()
      )
    end
  end

  @doc "Live row count (tests/telemetry)."
  @spec count() :: non_neg_integer()
  def count, do: :ets.info(table(), :size)

  # -- GenServer -------------------------------------------------------------------

  @impl true
  def init(:ok) do
    :ets.new(table(), [:set, :named_table, :public])
    :ets.new(index_table(), [:set, :named_table, :public, read_concurrency: true])
    Process.send_after(self(), :sweep, @sweep_interval_ms)
    {:ok, %{}}
  end

  @impl true
  def handle_info(:sweep, state) do
    now = System.system_time(:millisecond)

    :ets.foldl(
      fn
        {id, %{expires_at_ms: expires_at}, _ack}, _acc when expires_at < now ->
          :ets.delete(table(), id)

        _, _acc ->
          :ok
      end,
      :ok,
      table()
    )

    # The index's rows carry their own expiry and go with the same sweep.
    :ets.select_delete(index_table(), [{{:_, :_, :"$1"}, [{:<, :"$1", now}], [true]}])

    Process.send_after(self(), :sweep, @sweep_interval_ms)
    {:noreply, state}
  end

  defp hash(token), do: Base.encode16(:crypto.hash(:sha256, token), case: :lower)

  defp table, do: @table
  defp index_table, do: @index_table
end
