defmodule Cytale.Gateway.ProtocolError do
  @moduledoc """
  Gateway protocol violation (U10): carries the WebSocket close code, a
  human-readable reason for the log line, and optional gateway frames that
  must be flushed to the client before the close (e.g. InvalidSession).
  """

  defexception [:code, :reason, :frames]

  @type t :: %__MODULE__{
          code: 4000..4999,
          reason: String.t(),
          frames: [map()]
        }

  @spec exception(keyword()) :: t()
  def exception(opts) when is_list(opts) do
    %__MODULE__{
      code: Keyword.get(opts, :code, 4000),
      reason: Keyword.get(opts, :reason, "protocol error"),
      frames: Keyword.get(opts, :frames, [])
    }
  end

  @doc "Convenience constructor used across the gateway modules."
  @spec new(4000..4999, String.t(), [map()]) :: t()
  def new(code, reason, frames \\ []), do: %__MODULE__{code: code, reason: reason, frames: frames}

  @impl true
  def message(%__MODULE__{code: code, reason: reason}), do: "gateway #{code}: #{reason}"
end
