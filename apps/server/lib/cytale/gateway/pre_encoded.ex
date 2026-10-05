defmodule Cytale.Gateway.PreEncoded do
  @moduledoc """
  A payload whose JSON is ALREADY on the wire, ready to be spliced into an
  envelope (hardening plan 2.3).

  Every fan-out event is JSON-encoded once per RECIPIENT socket: the socket holds
  the per-session seq, so the envelope `%{op: 0, s: seq, t: name, d: payload}`
  cannot be pre-encoded as a whole. What can is the `d` payload, which is
  identical for every recipient — so the fan-out encodes it ONCE
  (`encode/1`) and hands the receiving socket this wrapper, whose `Jason.Encoder`
  returns the pre-encoded iodata verbatim. Jason still walks the envelope, but the
  expensive part (the nested payload, embeds/attachments and all) is copied
  rather than re-encoded. A 500-session channel went from 500 encodes of the same
  bytes to one.

  BYTE-IDENTICAL by construction: `encode/1` runs the same `Jason.encode!/1` the
  socket would have run on the same value with the same options, and the encoder
  below emits that result unchanged — so a wrapped envelope is byte-for-byte the
  envelope without the wrapper. The gateway's wire-contract tests compare frames
  literally, and `PreEncoded`'s own test compares both spellings.

  NOT for the compat path: a compat session TRANSLATES the payload (Dialect
  shape, intents/visibility filtering) inside the socket, so the pre-encoded
  native bytes are not what it puts on its wire. The socket only uses the
  fragment when nothing was rewritten; see the fan-out's `pre_encoded/1`.
  """

  @enforce_keys [:json]
  defstruct [:json]

  @type t :: %__MODULE__{json: iodata()}

  @doc """
  Encode `payload` once for a fan-out, emitting
  `[:cytale, :gateway, :payload_encode]` (the counted evidence that one event is
  encoded once, not once per recipient).
  """
  @spec encode(term()) :: t()
  def encode(payload) do
    json = Jason.encode!(payload)
    :telemetry.execute([:cytale, :gateway, :payload_encode], %{bytes: IO.iodata_length(json)}, %{})
    %__MODULE__{json: json}
  end

  @doc """
  The fan-out-side helper: the wrapper for this event, or `nil` when pre-encoding
  cannot pay — a single recipient, or an event with no payload to speak of.

  Kept here rather than in each producer so the decision is one place: pre-encoding
  walks the payload ONCE and a fan-out with one live recipient would pay that walk
  for nothing (the socket would have done one anyway).
  """
  @spec for_fanout(integer(), term()) :: t() | nil
  def for_fanout(recipient_count, payload)
      when is_integer(recipient_count) and recipient_count > 1 and not is_nil(payload) do
    encode(payload)
  end

  def for_fanout(_recipient_count, _payload), do: nil
end

defimpl Jason.Encoder, for: Cytale.Gateway.PreEncoded do
  # Verbatim: the bytes were produced by `Jason.encode!/1` over this same value.
  def encode(%{json: json}, _opts), do: json
end
