defmodule VoiceSidecar.MixProject do
  use Mix.Project

  def project do
    [app: :voice_sidecar, version: "0.1.0", elixir: "~> 1.17", deps: deps()]
  end

  def application do
    # :ssl — the WS client dials TLS gateways (:ssl.connect) when
    # VOICE_GATEWAY_TLS is set; the app must be RUNNING before the first
    # participant connects, so it belongs in extra_applications.
    [extra_applications: [:logger, :ssl], mod: {VoiceSidecar, []}]
  end

  defp deps do
    [
      {:ex_webrtc, "~> 0.17"},
      {:ex_rtp, "~> 0.3"},
      {:jason, "~> 1.4"}
    ]
  end
end
