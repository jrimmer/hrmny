defmodule Cytale.Gateway.Opcode do
  @moduledoc """
  Elixir mirror of `packages/protocol/src/opcodes.ts` (U2) — single numeric
  source of truth for every gateway frame opcode. Values MUST match exactly;
  `Cytale.Gateway.OpcodeTest`-style parity is guaranteed by construction here,
  since this table was transcribed op-for-op from the TS constant and any
  drift would break the wire contract with U15/U17/U28 clients.

  Op codes 4 and 8 are unassigned forever (Discord voice legacy): a client
  sending them gets close 4002 unknown_opcode (protocol violation). Ops >= 20
  are Cytale-reserved commands; ops 20-24 are defined (20 typing, 21 read ack,
  22 call state update, 23 call signal, 24 focus report).
  """

  alias Cytale.Gateway.Opcode

  @typedoc "Any defined gateway opcode"
  @type t ::
          :dispatch
          | :heartbeat
          | :identify
          | :presence_update
          | :resume
          | :reconnect
          | :invalid_session
          | :hello
          | :heartbeat_ack
          | :typing_start_client
          | :message_ack
          | :call_state_update
          | :call_signal
          | :focus_update

  # -- Core table (mirror of GatewayOp in packages/protocol/src/opcodes.ts) --

  @dispatch 0
  @heartbeat 1
  @identify 2
  @presence_update 3
  @resume 5
  @reconnect 6
  @invalid_session 9
  @hello 10
  @heartbeat_ack 11
  @reserved_op_min 20
  @typing_start_client 20
  @message_ack 21
  @call_state_update 22
  @call_signal 23
  @focus_update 24

  @doc "Server→client dispatch frame carrying an event."
  @spec dispatch :: 0
  def dispatch, do: @dispatch

  @doc "Client→server heartbeat ping."
  @spec heartbeat :: 1
  def heartbeat, do: @heartbeat

  @doc "Client→server session start."
  @spec identify :: 2
  def identify, do: @identify

  @doc "Client→server presence change request (ack-less until U11 wires presence)."
  @spec presence_update :: 3
  def presence_update, do: @presence_update

  @doc "Client→server session resumption after reconnect."
  @spec resume :: 5
  def resume, do: @resume

  @doc "Server→client \"drop and reconnect immediately\"."
  @spec reconnect :: 6
  def reconnect, do: @reconnect

  @doc "Server→client session-dead signal (`d` = resumable boolean flag)."
  @spec invalid_session :: 9
  def invalid_session, do: @invalid_session

  @doc "Server→client first payload after connect (`d.hello_payload`)."
  @spec hello :: 10
  def hello, do: @hello

  @doc "Server→client heartbeat acknowledgement (null payload)."
  @spec heartbeat_ack :: 11
  def heartbeat_ack, do: @heartbeat_ack

  @doc "Floor of the Cytale-reserved command range."
  @spec reserved_op_min :: 20
  def reserved_op_min, do: @reserved_op_min

  @doc "Reserved op 20: client→server typing signal."
  @spec typing_start_client :: 20
  def typing_start_client, do: @typing_start_client

  @doc "Reserved op 21: client→server read acknowledgement."
  @spec message_ack :: 21
  def message_ack, do: @message_ack

  @doc "Reserved op 22: client→server voice-call control plane (calls plan U1)."
  @spec call_state_update :: 22
  def call_state_update, do: @call_state_update

  @doc "Reserved op 23: client→server opaque media-signaling relay (calls plan U1)."
  @spec call_signal :: 23
  def call_signal, do: @call_signal

  @doc """
  Reserved op 24: client→server focus report — is THIS session the one the
  member is actively looking at?

  Delivery reads it so one event does not notify every device: the focused
  session is already showing the thing, so the notification belongs on the
  others. Presence is not a substitute — its `idle` status is one the member
  *chooses*, not one the client detects.
  """
  @spec focus_update :: 24
  def focus_update, do: @focus_update

  # -- Reflection tables ------------------------------------------------------

  @to_code %{
    dispatch: @dispatch,
    heartbeat: @heartbeat,
    identify: @identify,
    presence_update: @presence_update,
    resume: @resume,
    reconnect: @reconnect,
    invalid_session: @invalid_session,
    hello: @hello,
    heartbeat_ack: @heartbeat_ack,
    typing_start_client: @typing_start_client,
    message_ack: @message_ack,
    call_state_update: @call_state_update,
    call_signal: @call_signal,
    focus_update: @focus_update
  }

  @from_code Map.new(@to_code, fn {name, code} -> {code, name} end)

  @doc "Numeric wire value for an opcode name (crashes on unknown names — programmer error)."
  @spec to_code(t()) :: integer()
  for {name, code} <- @to_code do
    def to_code(unquote(name)), do: unquote(code)
  end

  @doc "Decode a numeric wire opcode into its name, or :error for unassigned values."
  @spec from_code(integer()) :: {:ok, t()} | :error
  def from_code(code)

  for {code, name} <- @from_code do
    def from_code(unquote(code)), do: {:ok, unquote(name)}
  end

  def from_code(_), do: :error

  @known_codes Map.keys(@from_code)
  @unknown_codes Enum.sort(Enum.to_list(0..30) -- @known_codes)

  @doc """
  Every defined opcode as `%{name => code}`.

  The reflection source for callers that must NOT transcribe the table: the
  `mix protocol.manifest` task reads this instead of scanning a guessed
  numeric range, so an opcode added above the old scan ceiling is reflected
  in the wire manifest rather than silently left out.
  """
  @spec all() :: %{t() => integer()}
  def all, do: @to_code

  @doc "Is `code` a currently-defined gateway opcode?"
  @spec known?(integer()) :: boolean()
  def known?(code) when is_integer(code), do: Map.has_key?(@from_code, code)
  def known?(_), do: false

  @doc """
  Test-probe list of unknown gatekeeping codes (the probing values used by
  malformed-frame tests: 4 and 8 = Discord voice forever-unassigned; 7 = gap;
  25+ = reserved range but undefined).
  """
  @spec unknown_gatekeep_codes :: [integer()]
  def unknown_gatekeep_codes, do: @unknown_codes

  @doc "Numeric op for a WebSocket-close close-code key (see #{inspect(Opcode)} close reasons)."
  @spec close_code(:unknown_opcode | :invalid_gateway_version | :auth_error) :: 4000..4999
  def close_code(:unknown_opcode), do: 4002
  def close_code(:invalid_gateway_version), do: 4012
  def close_code(:auth_error), do: 4004
end
