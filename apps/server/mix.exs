defmodule Cytale.MixProject do
  use Mix.Project

  def project do
    [
      app: :cytale,
      version: "1.0.2",
      elixir: "~> 1.18",
      start_permanent: Mix.env() == :prod,
      elixirc_paths: elixirc_paths(Mix.env()),
      deps: deps(),
      description: "Hrmny server: the Phoenix API, real-time gateway and bot surface",
      source_url: "https://github.com/jrimmer/hrmny",
      package: [licenses: ["BSD-3-Clause"], links: %{"GitHub" => "https://github.com/jrimmer/hrmny"}]
    ]
  end

  # Compile test/support in the :test environment only.
  defp elixirc_paths(:test), do: ["lib", "test/support"]
  defp elixirc_paths(_), do: ["lib"]

  def application do
    [
      extra_applications: [:logger],
      mod: {Cytale.Application, []}
    ]
  end

  # All Hex dependencies for the phase are declared WHOLESALE here (one time),
  # so mix.lock never churns across later units (AGENTS.md hard rule #7).
  #
  # Pins verified against current hex.pm releases (2026-08):
  #   phoenix 1.8.13 · bandit 1.12.5 · xandra 0.20.0 · rustler 0.38.0 · muninn 0.5.5
  #   jason 1.4.5 · ezstd 1.2.4 · argon2_elixir 4.1.3 · joken 2.6.2 · web_push_ex 0.1.0
  defp deps do
    [
      # Web/API backbone — Phoenix 1.8 with the Bandit default adapter (U4..U12, U29)
      {:phoenix, "~> 1.8"},
      {:bandit, "~> 1.12"},

      # Storage — ScyllaDB driver; pool itself lands with U6, config carried from U4.
      # `decimal` is a direct dep because Xandra's protocol module unconditionally
      # `require Decimal` at compile time (its own hex dep is only optional).
      {:xandra, "~> 0.20"},
      {:decimal, "~> 3.1"},

      # Search — Tantivy NIF wrapper + Rustler glue (U13/U14).
      # muninn 0.5.x requires Elixir ~> 1.18 and a Rust ~> 1.92 toolchain.
      {:muninn, "~> 0.5"},
      {:rustler, "~> 0.38"},

      # Serialization & compression — wire protocol / gateway payloads (U7+)
      {:jason, "~> 1.4"},
      {:ezstd, "~> 1.2"},

      # Auth (U8) — argon2id with OWASP-tuned parameters, JWT signing
      {:argon2_elixir, "~> 4.1"},
      {:joken, "~> 2.6"},

      # Instance OIDC federated sign-in (ticket #12): the ID-token signature
      # half — RS256/ES256/PS256 verification against the provider's JWKS.
      # Already in the tree as joken's own dependency (same 1.11.x pin, so
      # mix.lock does not move); declared DIRECTLY here because Cytale.OIDC
      # uses the JOSE modules as a first-class API (joken only signs HS256
      # with our own secret and cannot verify a foreign provider's keys).
      {:jose, "~> 1.11"},

      # Push notification pipeline (U9/U10) — RFC 8291 encrypted Web Push
      {:web_push_ex, "~> 0.1"},

      # WebAuthn passkeys (ticket #36) — wax_ (pure-Elixir FIDO2: CBOR/COSE
      # parse, ES256/RS256 assertion verification, origin + RP-ID checks).
      # The trailing underscore is the package name (`wax` was taken on hex).
      {:wax_, "~> 0.7.0"},

      # CBOR codec for the software authenticator fixtures (the #36 ceremony
      # tests build attestation objects/assertions with it). NOT `only: :test`:
      # wax_ above requires cbor in EVERY environment, and Mix refuses a graph
      # where a prod dependency's own dependency is test-restricted — which is
      # what took the whole dev server and every test run down at 03:05
      # ("does not match the :only option calculated for"). Unrestricted, the
      # fixtures still use it exactly as before.
      {:cbor, "~> 1.0"},

      # Voice (U2, voice plan KTD1) — server-side WebRTC SFU. Pulls the NIF
      # chain ex_dtls (OpenSSL) / ex_libsrtp / ex_sctp (elixir_make + C).
      {:ex_webrtc, "~> 0.17"},

      # Test-only HTTP client (real HTTP round-trips against the endpoint).
      # No longer `only: :test`: ex_webrtc's NIF chain (bundlex, the
      # Membrane build tool) hard-depends on req → finch in EVERY env, and a
      # restricted finch makes the dep tree diverge (U2 deviation, forced).
      {:finch, "~> 0.23"}
    ]
  end
end
