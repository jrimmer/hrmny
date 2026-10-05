defmodule Cytale.Calls.ICE do
  @moduledoc """
  ICE/TURN configuration surface for the calls media plane (voice plan U2,
  KTD1/KTD2).

  `config/0` doubles as the ex_webrtc compile-smoke: it is the first function
  in the tree that touches the dependency, and it verifies the NIF chain
  (`ExDTLS` / `ExLibSRTP` natives via bundlex + unifex) actually loads in the
  running VM — the release-image failure mode U2 front-loads before any media
  code exists. U5's `Cytale.Calls.Media` consumes `config/0` when creating
  server-side PeerConnections.
  """

  alias Cytale.Config

  # ExWebRTC's public entry module plus the bundlex NIF anchors of its
  # ex_dtls / ex_libsrtp natives. `Code.ensure_loaded/1` runs each module's
  # `@on_load` (Bundlex.Loader's `:erlang.load_nif`); a broken native build
  # fails HERE, loudly — not inside a live call (U5).
  @native_anchors [ExWebRTC.PeerConnection, ExDTLS.Native.Nif, ExLibSRTP.Native.Nif]

  @doc """
  The media plane's ICE configuration: `ice_servers` (ex_webrtc
  `ice_servers` shape — `[]` means host candidates only) and the
  `media_udp_port_range` reserved for ICE sockets.
  """
  @spec config :: %{
          ice_servers: [map()],
          media_udp_port_range: {pos_integer(), pos_integer()}
        }
  def config do
    for module <- @native_anchors do
      {:module, ^module} = Code.ensure_loaded(module)
    end

    %{
      ice_servers: Config.calls_ice_servers(),
      media_udp_port_range: Config.calls_media_udp_port_range()
    }
  end
end
