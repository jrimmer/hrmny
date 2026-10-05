defmodule Cytale.Gateway.Session do
  @moduledoc """
  Per-connection gateway session record (U10): identity binding, dispatch
  sequence counter, single-use resume_token, resume buffer, and
  heartbeat-deadline accounting.

  Pure data transitions only — no timers, sockets, or ETS access — so every
  protocol rule is deterministically unit-testable and immune to scheduler
  jitter. Wall-clock time is always injected (`now_ms`) by the caller
  (the gateway socket owns clock and timers; `Cytale.Gateway.SessionStore`
  owns persistence and expiry).

  ## Lifecycle

      connecting → identifying → ready → connected ─┬→ disconnected ──▶ (window expiry)
                          ▲                         └→ resuming → connected
                          └── re-Identify after InvalidSession(false)

  The first two phases are socket-local handler states: this record is minted
  only at IDENTIFY success. On disconnect the record survives in the session
  store until its resume window expires; a new connection RESUMing it goes
  straight back to live without a second READY.

  ## Identity binding (the resume-security contract)

  A Resume requires ALL of: matching `session_id` AND the single-use
  `resume_token` minted at IDENTIFY success AND an authenticated identity on
  the new connection. Possession of a session_id or token alone never
  suffices — stolen either value with mismatched auth identity is rejected.

  ## Draining / storm damping

  * One live connection per session_id (store-enforced uniqueness).
  * Planned shutdown pushes the server Reconnect frame (op 6 native / op 7
    compat — Discord's dialect maps Resume to 6) staggered ~4/sec with
    per-session random jitter before close — pairs with U19's client-side
    jitter.
  """

  alias Cytale.Gateway.Compression

  @enforce_keys [:session_id, :user]
  defstruct [
    :session_id,
    :user,
    :last_disconnect_at_ms,
    seq: 0,
    resume_token: nil,
    last_heartbeat_at_ms: nil,
    missed: 0,
    created_at_ms: nil,
    compress: :none,
    events: [],
    phase: :connected,
    mode: :native,
    intents: 0
  ]

  @typedoc """
  Bound, verified identity behind the session.

  U2 (bots plan): machine identities additionally carry `:kind`, `:parent_id`,
  `:restrictions` (provenance for the U3 rights resolver). The keys are
  OPTIONAL — human identities keep the two-key `%{id, username}` shape, and
  `new/2` projects old-shaped maps byte-identically.
  """
  @type user :: %{
          required(:id) => String.t(),
          required(:username) => String.t(),
          optional(:kind) => atom(),
          optional(:parent_id) => integer() | nil,
          optional(:restrictions) => map() | nil
        }

  @typedoc "One buffered Dispatch envelope."
  @type envelope :: %{
          required(:op) => 0,
          required(:s) => pos_integer(),
          required(:t) => String.t(),
          optional(:d) => map()
        }

  @typedoc "Serializable record held across disconnects for the resume window."
  @type t :: %__MODULE__{
          session_id: String.t(),
          user: user(),
          seq: non_neg_integer(),
          resume_token: String.t() | nil,
          last_heartbeat_at_ms: integer() | nil,
          last_disconnect_at_ms: integer() | nil,
          missed: non_neg_integer(),
          created_at_ms: integer() | nil,
          compress: Compression.mode(),
          events: [envelope()],
          phase: :connected | :disconnected,
          mode: mode(),
          intents: non_neg_integer()
        }

  @typedoc """
  Session wire dialect (U7, KTD5 — keyed on credential type):

    * `:native` — `cytale_` credentials: CamelCase dispatch names, minimal
      READY, `v` = 1. Byte-identical to the pre-U7 gateway.
    * `:compat` — `cytbot_` machine credentials: SCREAMING_SNAKE dispatch
      names, Discord payload shapes via the shared compat codec, a
      Discord-shaped READY followed by a synthesized GUILD_CREATE per
      workspace, intents-honoring dispatch filter.
  """
  @type mode :: :native | :compat

  # Missed-heartbeat tolerance. Five consecutive missed intervals ⇒ dead link
  # (Discord-shaped); overridable per check via opts for tests.
  @max_missed_heartbeats 5

  # Resume-buffer retention cap (the B1 bound): the NEWEST @buffer_cap
  # envelopes stay buffered for replay; anything older is evicted
  # oldest-first as new dispatches arrive. A Resume from a seq BELOW the
  # evicted window is not replayable — `replay_complete?/2` decides that and
  # the socket turns it into the fresh-Identify path (Invalid Session,
  # resumable=false). Documented in docs/protocol/gateway.md.
  @buffer_cap 1_000

  # ---------------------------------------------------------------------------
  # Construction / phase transitions
  # ---------------------------------------------------------------------------

  @doc "Missed-beat budget before a link is declared dead."
  @spec max_missed_heartbeats :: pos_integer()
  def max_missed_heartbeats, do: @max_missed_heartbeats

  @doc "Retained-envelope cap for the resume buffer (oldest evicted beyond it)."
  @spec buffer_cap :: pos_integer()
  def buffer_cap, do: @buffer_cap

  @doc """
  Mint a fresh session at IDENTIFY success. Options:

    * `:now_ms` — creation wall-clock stamp
    * `:compress` — negotiated codec (`#{inspect(Compression)} mode: :zstd_stream | :zlib_stream | :none`)
    * `:mode` — wire dialect (`:native` default | `:compat`, U7/KTD5)
    * `:intents` — compat-session intent bitmask (default 0)
    * `:session_id` / `:resume_token` — forced values (tests)

  The bound user keeps `:id`/`:username` (fetched — both are mandatory in
  every identity shape) plus the optional machine-provenance keys when the
  identity declares them (`Map.has_key?`, so a declared-but-nil `restrictions`
  survives while old two-key maps project byte-identically).
  """
  @spec new(user(), keyword()) :: t()
  def new(user, opts \\ []) when is_map(user) do
    %__MODULE__{
      session_id: Keyword.get_lazy(opts, :session_id, &generate_session_id/0),
      user: project_user(user),
      resume_token: Keyword.get_lazy(opts, :resume_token, &generate_resume_token/0),
      created_at_ms: Keyword.get(opts, :now_ms),
      compress: Keyword.get(opts, :compress, :none),
      phase: :connected,
      mode: Keyword.get(opts, :mode, :native),
      intents: Keyword.get(opts, :intents, 0)
    }
  end

  defp project_user(user) do
    # NOTE: this projection is the session's AUTHORITY for every resolve that
    # runs off `session.user` (the handshake, the resume replay, a restored
    # session) — omitting a key here silently strips that principal of it. The
    # access document rides with restrictions for exactly that reason.
    Enum.reduce([:kind, :parent_id, :restrictions, :access], base_user(user), fn key, acc ->
      if Map.has_key?(user, key), do: Map.put(acc, key, Map.get(user, key)), else: acc
    end)
  end

  defp base_user(user),
    do: %{id: Map.fetch!(user, :id), username: Map.fetch!(user, :username)}

  @doc """
  Connection dropped: record survives buffered until window expiry. `now_ms`
  anchors the resume window on the disconnect itself (not session creation —
  a long-lived session that just dropped stays fully resumable).
  """
  @spec mark_disconnected(t(), integer()) :: t()
  def mark_disconnected(%__MODULE__{} = s, now_ms) when is_integer(now_ms),
    do: %{s | phase: :disconnected, last_disconnect_at_ms: now_ms}

  @doc "Session live again (fresh Identify/Resume accepted)."
  @spec mark_connected(t()) :: t()
  def mark_connected(%__MODULE__{} = s), do: %{s | phase: :connected}
  @doc "Does the record represent a currently-connected session?"
  @spec live?(t()) :: boolean()
  def live?(%__MODULE__{phase: phase}), do: phase == :connected

  @doc """
  Has the record outlived the hard resume-window floor? The window is anchored
  on the last disconnect (falling back to creation for never-connected
  records) — long-lived sessions do not expire by being old, only by staying
  dropped too long.
  """
  @spec expired?(t(), integer(), pos_integer()) :: boolean()
  def expired?(%__MODULE__{} = s, now_ms, window_ms)
      when is_integer(now_ms) and is_integer(window_ms) do
    case anchor_ms(s) do
      nil -> false
      anchor -> now_ms - anchor > window_ms
    end
  end

  defp anchor_ms(%__MODULE__{last_disconnect_at_ms: d}) when is_integer(d), do: d
  defp anchor_ms(%__MODULE__{created_at_ms: c}) when is_integer(c), do: c
  defp anchor_ms(_), do: nil

  # ---------------------------------------------------------------------------
  # Heartbeat accounting (missed beats recomputed from elapsed time)
  # ---------------------------------------------------------------------------

  @doc "Arm/refresh the heartbeat deadline; resets the miss streak."
  @spec heartbeat_received(t(), integer()) :: {:ok, t()} | {:error, :not_armed}
  def heartbeat_received(%__MODULE__{} = s, now_ms) when is_integer(now_ms) do
    {:ok, %{s | last_heartbeat_at_ms: now_ms, missed: 0}}
  end

  def heartbeat_received(_session, _now_ms), do: {:error, :not_armed}

  @doc """
  Recompute misses from elapsed time. Dead iff the LAST beat is older than
  `interval × (allowed + 1)` — i.e. exactly `allowed + 1` full periods have
  passed without any sign of life, so `allowed` beats have genuinely been
  skipped. Second element = whole missed periods elapsed (for logs/metrics).
  """
  @spec status(t(), integer(), pos_integer(), pos_integer()) :: {:dead | :alive, non_neg_integer()}
  def status(%__MODULE__{} = s, now_ms, interval, allowed \\ nil)
      when is_integer(interval) and interval > 0,
      do: status_impl(s, now_ms, interval, allowed || @max_missed_heartbeats)

  defp status_impl(%__MODULE__{last_heartbeat_at_ms: ms}, now_ms, interval, allowed)
       when is_integer(ms) do
    elapsed = max(now_ms - ms, 0)
    missed = div(elapsed, interval)

    if elapsed >= interval * (allowed + 1) do
      {:dead, min(missed, allowed)}
    else
      {:alive, missed}
    end
  end

  defp status_impl(_session, _now, _interval, _allowed), do: {:alive, 0}

  @doc "Test support: force the miss counter to `n`."
  @spec set_missed!(t(), non_neg_integer()) :: t()
  def set_missed!(%__MODULE__{} = s, n) when n >= 0, do: %{s | missed: n}

  # ---------------------------------------------------------------------------
  # Sequence-numbered event buffer (the resume-window contents)
  # ---------------------------------------------------------------------------

  @doc """
  Append under the next seq; returns `{updated_session, wire_envelope}` where
  the envelope is the op-0 Dispatch frame carrying the event. The buffer is
  stored NEWEST-FIRST (O(1) prepend — the former `events ++ [env]` append was
  O(n) per dispatch); the readers reverse it back to oldest-first. The
  buffer is BOUNDED at `buffer_cap/0` envelopes: once at cap, the incoming
  envelope evicts the OLDEST retained one, so the retained window is always
  the newest `buffer_cap/0` seqs.
  """
  @spec buffer_event(t(), String.t(), map()) :: {t(), envelope()}
  def buffer_event(%__MODULE__{} = s, event_name, payload)
      when is_binary(event_name) and is_map(payload) do
    next_seq = s.seq + 1
    env = %{op: 0, s: next_seq, t: event_name, d: payload}

    events =
      [env | s.events]
      |> bound_buffer()

    {%{s | seq: next_seq, events: events}, env}
  end

  # Newest-first list: keeping the first `buffer_cap` entries keeps the
  # NEWEST seqs and evicts the oldest (the tail). No-op under the cap.
  defp bound_buffer(events) when length(events) > @buffer_cap,
    do: Enum.take(events, @buffer_cap)

  defp bound_buffer(events), do: events

  @doc """
  The oldest retained seq (the eviction watermark); nil when nothing is
  buffered. Envelopes with a smaller seq have been evicted and can no
  longer be replayed.
  """
  @spec oldest_buffered_seq(t()) :: pos_integer() | nil
  def oldest_buffered_seq(%__MODULE__{events: []}), do: nil

  def oldest_buffered_seq(%__MODULE__{events: events}),
    do: events |> List.last() |> Map.fetch!(:s)

  @doc """
  Can a Resume from `client_seq` replay with NO seq gap? False when eviction
  has dropped envelopes between the client's seq and the oldest retained one
  (`client_seq + 1 < oldest buffered`) — the caller must then refuse the
  resume (Invalid Session, resumable=false → fresh Identify) instead of
  replaying a stale window with a hole in it. Seqs are contiguous by
  construction (an envelope is buffered exactly when its seq is consumed).
  """
  @spec replay_complete?(t(), non_neg_integer()) :: boolean()
  def replay_complete?(%__MODULE__{events: []}, _client_seq), do: true

  def replay_complete?(%__MODULE__{} = s, client_seq) when is_integer(client_seq),
    do: client_seq + 1 >= oldest_buffered_seq(s)

  @doc "Envelope stored under `seq`, if still retained."
  @spec peek_buffered(t(), pos_integer()) :: envelope() | nil
  def peek_buffered(%__MODULE__{events: events}, seq), do: Enum.find(events, &(&1.s == seq))

  @doc "All envelopes with `seq > given`, oldest-first: exactly what Resume replays."
  @spec buffered_after(t(), non_neg_integer()) :: [envelope()]
  def buffered_after(%__MODULE__{events: events}, seq),
    do: events |> Enum.reverse() |> Enum.filter(&(&1.s > seq))

  @doc "Envelope count currently retained."
  @spec buffered_count(t()) :: non_neg_integer()
  def buffered_count(%__MODULE__{events: events}), do: length(events)

  @doc "Drop every envelope up to AND INCLUDING `seq`. Higher seq values crash: caller bug."
  @spec trim_to_seq(t(), non_neg_integer()) :: t()
  def trim_to_seq(%__MODULE__{seq: highest}, seq) when seq > highest do
    raise ArgumentError,
          "trim_to_seq #{seq} exceeds recorded high-water-mark #{highest}"
  end

  # Seqs are monotonic, so dropping the oldest-first prefix (s <= seq) is a
  # plain reject on the newest-first list; the kept suffix stays newest-first
  # for the next append (identical to the former drop_while result).
  def trim_to_seq(%__MODULE__{} = s, seq),
    do: %{s | events: Enum.reject(s.events, &(&1.s <= seq))}

  # ---------------------------------------------------------------------------
  # Control-frame builders
  # ---------------------------------------------------------------------------

  @doc "op 10 Hello — `d.heartbeat_interval`; compression offer rides alongside per U2/U10."
  @spec hello_frame(pos_integer()) :: %{op: 10, d: map()}
  def hello_frame(heartbeat_interval),
    do: %{op: Cytale.Gateway.Opcode.hello(), d: %{heartbeat_interval: heartbeat_interval}}

  @doc "Compression modes offered in the Hello handshake body."
  @spec hello_compression_offer() :: [String.t()]
  def hello_compression_offer, do: Compression.supported_modes()

  @doc "op 9 InvalidSession — `d` carries the resumable flag alone (U2 payloads.ts)."
  @spec invalid_session_frame(boolean()) :: %{op: 9, d: boolean()}
  def invalid_session_frame(resumable?),
    do: %{op: Cytale.Gateway.Opcode.invalid_session(), d: resumable?}

  @doc """
  op 6 Reconnect — planned-drain / teardown signal (the NATIVE dialect; op 5
  is Resume there). `mode` selects the dialect: compat sessions speak
  Discord's opcode map, where op 6 is the CLIENT Resume and the server-pushed
  Reconnect is **op 7** — sending 6 would be a client-to-server op on a
  Discord client's wire.
  """
  @spec reconnect_frame() :: %{op: 6}
  @spec reconnect_frame(:native | :compat) :: %{op: 6 | 7}
  def reconnect_frame(mode \\ :native)

  def reconnect_frame(:native), do: %{op: Cytale.Gateway.Opcode.reconnect()}

  # Discord's server-sent Reconnect (op 7) — NOT part of the native table
  # mirrored from packages/protocol; it exists only on the compat dialect's
  # outbound wire and is deliberately absent from the inbound routing table.
  def reconnect_frame(:compat), do: %{op: 7}

  @doc "op 11 Heartbeat ACK reply."
  @spec heartbeat_ack_frame() :: %{op: 11}
  def heartbeat_ack_frame, do: %{op: Cytale.Gateway.Opcode.heartbeat_ack()}

  # ---------------------------------------------------------------------------
  # Secret minting helpers
  # ---------------------------------------------------------------------------

  @alphabet ~c"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"

  @doc "Opaque session id: 's' + 20 alphanumerics (~119 bits entropy)."
  @spec generate_session_id() :: String.t()
  def generate_session_id, do: "s" <> random_string(20)

  @doc "Single-use secret: 32 alphanumerics (~190 bits), never derivable from session_id."
  @spec generate_resume_token() :: String.t()
  def generate_resume_token, do: random_string(32)

  defp random_string(n) do
    n
    |> :crypto.strong_rand_bytes()
    |> :binary.bin_to_list()
    |> Enum.map(&Enum.at(@alphabet, rem(&1, length(@alphabet))))
    |> List.to_string()
  end
end
