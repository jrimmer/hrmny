defmodule Cytale.PushResolverStub do
  @moduledoc """
  The suite's default DNS stand-in for the S1 push-endpoint guard
  (`config :cytale, push_endpoint_resolver` in config/test.exs).

  Every name resolves to 192.0.2.10 — TEST-NET-1, reserved by IANA and not
  assigned to anything, so the guard classifies it public (it is in none of
  the audited private/reserved ranges) while the suite is guaranteed no test
  ever emits a real DNS query. Tests that need a REFUSAL (loopback,
  link-local, resolution failure) put their own stub in and restore it — the
  standard `Application.put_env` + `on_exit` pattern.
  """

  @doc "Resolve any host to a harmless, public-class TEST-NET-1 address."
  @spec resolve(String.t()) :: {:ok, [:inet.ip_address()]}
  def resolve(_host), do: {:ok, [{192, 0, 2, 10}]}
end
