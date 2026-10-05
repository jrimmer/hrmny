defmodule Cytale.Accounts.WebAuthnTest do
  @moduledoc """
  The RP-ID derivation pure function (ticket requirement: tested) plus the
  counter-monotonicity rule including the documented counter=0 edge. No
  database — the ceremonies' DB half is covered by the controller suite.
  """

  use ExUnit.Case, async: true

  doctest Cytale.Accounts.WebAuthn

  alias Cytale.Accounts.WebAuthn

  describe "rp_id/0 — derivation through the config (the tuple trap, 2026-09-19)" do
    test "an external origin derives the BARE host, not the {:ok, host} tuple" do
      # test.exs pins an explicit rp_id ("localhost", the ceremony fixtures);
      # clear it so the derivation path under test actually runs.
      original_ws = Application.get_env(:cytale, :webauthn, :unset)
      original_url = Application.get_env(:cytale, :external_base_url, :unset)
      pinned = if original_ws == :unset, do: [], else: original_ws
      Application.put_env(:cytale, :webauthn, Keyword.delete(pinned, :rp_id))
      Application.put_env(:cytale, :external_base_url, "https://hrmny.example.com")

      on_exit(fn ->
        case original_ws do
          :unset -> Application.delete_env(:cytale, :webauthn)
          v -> Application.put_env(:cytale, :webauthn, v)
        end

        case original_url do
          :unset -> Application.delete_env(:cytale, :external_base_url)
          v -> Application.put_env(:cytale, :external_base_url, v)
        end
      end)

      assert WebAuthn.rp_id() == "hrmny.example.com"
    end
  end

  # Swap the app env for one test (the module is async: true, but every test
  # that touches the env lives in this describe, which runs serially because
  # ExUnit runs a module's tests in one process).
  defp with_config(webauthn, external_base_url, fun) do
    original_ws = Application.get_env(:cytale, :webauthn, :unset)
    original_url = Application.get_env(:cytale, :external_base_url, :unset)
    Application.put_env(:cytale, :webauthn, webauthn)
    Application.put_env(:cytale, :external_base_url, external_base_url)

    try do
      fun.()
    after
      case original_ws do
        :unset -> Application.delete_env(:cytale, :webauthn)
        v -> Application.put_env(:cytale, :webauthn, v)
      end

      case original_url do
        :unset -> Application.delete_env(:cytale, :external_base_url)
        v -> Application.put_env(:cytale, :external_base_url, v)
      end
    end
  end

  describe "RP ID and expected origins from production-shaped config" do
    test "CYTALE_EXTERNAL_BASE_URL alone: the RP ID is its host, the one origin is its origin" do
      with_config([enabled: true], "https://hrmny.example.com", fn ->
        assert WebAuthn.rp_id() == "hrmny.example.com"
        assert WebAuthn.origins() == ["https://hrmny.example.com"]
        assert WebAuthn.available?()
      end)
    end

    test "a trailing slash or default port in the base URL still yields the browser's exact origin" do
      # The browser never puts a slash, path or default port in clientDataJSON;
      # matched verbatim, this .env spelling refused every passkey.
      for base <- ["https://hrmny.example.com/", "https://HRMNY.example.com:443", "https://hrmny.example.com/app/"] do
        with_config([enabled: true], base, fn ->
          assert WebAuthn.rp_id() == "hrmny.example.com"
          assert WebAuthn.origins() == ["https://hrmny.example.com"]
        end)
      end
    end

    test "a non-default port is part of the origin, never of the RP ID" do
      with_config([enabled: true], "http://localhost:4183", fn ->
        assert WebAuthn.rp_id() == "localhost"
        assert WebAuthn.origins() == ["http://localhost:4183"]
      end)
    end

    test "the explicit CYTALE_WEBAUTHN_RP_ID / _ORIGINS settings win over the base URL" do
      with_config(
        [enabled: true, rp_id: "example.com", origins: ["https://chat.example.com/", "https://app.example.com"]],
        "https://chat.example.com",
        fn ->
          assert WebAuthn.rp_id() == "example.com"
          assert WebAuthn.origins() == ["https://chat.example.com", "https://app.example.com"]
          assert WebAuthn.available?()
        end
      )
    end

    test "an explicit RP ID without a base URL is available; the origins fall back to loopback" do
      with_config([enabled: true, rp_id: "chat.example.com"], nil, fn ->
        assert WebAuthn.rp_id() == "chat.example.com"
        assert WebAuthn.available?()
      end)
    end

    test "neither hosted setting: the localhost fallback is never advertised" do
      with_config([enabled: true], nil, fn ->
        assert WebAuthn.rp_id() == "localhost"
        assert WebAuthn.origins() == ["http://localhost:4000", "http://127.0.0.1:4000"]
        refute WebAuthn.available?()
      end)
    end

    test "disabled stays unavailable even with a base URL" do
      with_config([enabled: false], "https://hrmny.example.com", fn ->
        refute WebAuthn.available?()
      end)
    end
  end

  describe "origin_from_url/1" do
    test "serializes the way a browser does" do
      assert WebAuthn.origin_from_url("https://chat.example.com") == {:ok, "https://chat.example.com"}
      assert WebAuthn.origin_from_url(" https://chat.example.com/ ") == {:ok, "https://chat.example.com"}
      assert WebAuthn.origin_from_url("http://chat.example.com:80") == {:ok, "http://chat.example.com"}
      assert WebAuthn.origin_from_url("https://chat.example.com:8443/x") == {:ok, "https://chat.example.com:8443"}
    end

    test "refuses what is not an origin" do
      assert WebAuthn.origin_from_url("chat.example.com") == :error
      assert WebAuthn.origin_from_url("") == :error
      assert WebAuthn.origin_from_url(nil) == :error
    end
  end

  defp client_data(challenge, overrides \\ %{}) do
    %{
      "type" => "webauthn.get",
      "challenge" => Base.url_encode64(challenge.bytes, padding: false),
      "origin" => "https://hrmny.example.com"
    }
    |> Map.merge(overrides)
    |> Jason.encode!()
  end

  defp auth_data(rp_id), do: :crypto.hash(:sha256, rp_id) <> <<0x05, 0::32>>

  describe "ceremony_matches/3 — the response belongs to this ceremony on this server" do
    setup do
      challenge =
        Wax.new_authentication_challenge(
          origin: ["https://hrmny.example.com"],
          rp_id: "hrmny.example.com",
          user_verification: "preferred",
          timeout: 300,
          allow_credentials: []
        )

      {:ok, challenge: challenge}
    end

    test "a matching response passes", %{challenge: challenge} do
      assert WebAuthn.ceremony_matches(challenge, auth_data("hrmny.example.com"), client_data(challenge)) == :ok
    end

    test "each mismatch names itself", %{challenge: challenge} do
      ad = auth_data("hrmny.example.com")

      assert WebAuthn.ceremony_matches(
               challenge,
               ad,
               client_data(challenge, %{"origin" => "https://cytale.example.com"})
             ) ==
               {:refused, :wrong_origin}

      assert WebAuthn.ceremony_matches(challenge, ad, client_data(challenge, %{"type" => "webauthn.create"})) ==
               {:refused, :wrong_type}

      assert WebAuthn.ceremony_matches(challenge, ad, client_data(challenge, %{"challenge" => "AAAA"})) ==
               {:refused, :wrong_challenge}

      assert WebAuthn.ceremony_matches(challenge, auth_data("cytale.example.com"), client_data(challenge)) ==
               {:refused, :wrong_rp_id}

      assert WebAuthn.ceremony_matches(challenge, ad, "not json") == {:refused, :malformed_response}
      assert WebAuthn.ceremony_matches(challenge, ad, "[]") == {:refused, :malformed_response}
    end
  end

  describe "rp_id_from_origin/1 — the tested pure function" do
    test "strips scheme, port, path, query, fragment and trailing slash noise" do
      assert WebAuthn.rp_id_from_origin("https://chat.example.com") == {:ok, "chat.example.com"}
      assert WebAuthn.rp_id_from_origin("http://chat.example.com/") == {:ok, "chat.example.com"}
      assert WebAuthn.rp_id_from_origin("https://chat.example.com:8443") == {:ok, "chat.example.com"}
      assert WebAuthn.rp_id_from_origin("https://chat.example.com/app/x?y=1#z") == {:ok, "chat.example.com"}
      assert WebAuthn.rp_id_from_origin("HTTPS://CHAT.EXAMPLE.COM") == {:ok, "chat.example.com"}
    end

    test "localhost (dev) derives to the host literal, no port" do
      assert WebAuthn.rp_id_from_origin("http://localhost:4000") == {:ok, "localhost"}
      assert WebAuthn.rp_id_from_origin("http://127.0.0.1:4000") == {:ok, "127.0.0.1"}
    end

    test "refuses garbage instead of guessing an RP ID" do
      assert WebAuthn.rp_id_from_origin("chat.example.com") == :error
      assert WebAuthn.rp_id_from_origin("not a url") == :error
      assert WebAuthn.rp_id_from_origin("") == :error
      assert WebAuthn.rp_id_from_origin(nil) == :error
    end
  end

  describe "counter_ok?/2 — sign-count monotonicity" do
    test "an increase is always accepted" do
      assert WebAuthn.counter_ok?(0, 1)
      assert WebAuthn.counter_ok?(5, 6)
      assert WebAuthn.counter_ok?(4_294_967_294, 4_294_967_295)
    end

    test "the documented counter=0 edge: an authenticator that never counts stays at 0" do
      assert WebAuthn.counter_ok?(0, 0)
    end

    test "a regression or a freeze after counting is a clone indicator: refused" do
      refute WebAuthn.counter_ok?(5, 3)
      refute WebAuthn.counter_ok?(5, 5)
      refute WebAuthn.counter_ok?(1, 0)
    end
  end
end
