defmodule Cytale.Accounts.TOTPTest do
  @moduledoc """
  #127 — the RFC 6238 core, PURE tests (no DB, no app services): the RFC's
  own official SHA-1 test vectors asserted verbatim (the hand-rolled pick's
  correctness case, stated in the module), then the acceptance policy the
  ticket pins — the ±1-step window, the replay floor, and the input
  hygiene (case/whitespace-tolerant base32, garbage codes refused).
  """

  use ExUnit.Case, async: true

  alias Cytale.Accounts.TOTP

  # RFC 6238's SHA-1 secret (ASCII "12345678901234567890"), T0=0, X=30,
  # 6-digit truncation — the appendix-B vectors, exactly.
  @rfc_secret Base.encode32("12345678901234567890", padding: false)

  # The RFC's appendix-B values are the 8-digit forms; these are their exact
  # 6-digit truncations (the suffix the dynamic-truncation mod 10^6 keeps):
  #   94287082, 07081804, 14050471, 89005924, 69279037, 65353130.
  @rfc_vectors [
    {59, "287082"},
    {1_111_111_109, "081804"},
    {1_111_111_111, "050471"},
    {1_234_567_890, "005924"},
    {2_000_000_000, "279037"},
    {20_000_000_000, "353130"}
  ]

  describe "RFC 6238 official SHA-1 vectors" do
    test "every appendix-B vector verifies verbatim" do
      for {unix, expected} <- @rfc_vectors do
        assert {:ok, ^expected} = TOTP.code_for(@rfc_secret, unix)
        # And the verifier accepts the vector's own code at its own time.
        assert {:ok, %{step: step, drift: 0}} = TOTP.verify(@rfc_secret, expected, unix, nil)
        assert step == div(unix, 30)
      end
    end
  end

  describe "the ±1-step window" do
    test "the previous step's code verifies at drift -1" do
      now = 2_000_000_000
      {:ok, code} = TOTP.code_for(@rfc_secret, now - 30)

      assert {:ok, %{drift: -1}} = TOTP.verify(@rfc_secret, code, now, nil)
    end

    test "the next step's code verifies at drift +1" do
      now = 2_000_000_000
      {:ok, code} = TOTP.code_for(@rfc_secret, now + 30)

      assert {:ok, %{drift: 1}} = TOTP.verify(@rfc_secret, code, now, nil)
    end

    test "two steps away is outside the window — refused" do
      now = 2_000_000_000
      {:ok, old} = TOTP.code_for(@rfc_secret, now - 60)
      {:ok, future} = TOTP.code_for(@rfc_secret, now + 60)

      assert {:error, :invalid_code} = TOTP.verify(@rfc_secret, old, now, nil)
      assert {:error, :invalid_code} = TOTP.verify(@rfc_secret, future, now, nil)
    end
  end

  describe "the replay floor (min_step)" do
    test "the just-used step is refused even though the code is inside its window" do
      now = 2_000_000_000
      {:ok, code} = TOTP.code_for(@rfc_secret, now)
      {:ok, %{step: step}} = TOTP.verify(@rfc_secret, code, now, nil)

      assert {:error, :invalid_code} = TOTP.verify(@rfc_secret, code, now, step)
      # A neighbour code from BEFORE the floor is refused too (a previous
      # step's code cannot come back once the floor has moved past it).
      {:ok, older} = TOTP.code_for(@rfc_secret, now - 30)

      assert {:error, :invalid_code} = TOTP.verify(@rfc_secret, older, now, step)
    end

    test "a fresh step beyond the floor still verifies" do
      # Consume the T=59 vector's step, then present the NEXT vector's code
      # (a strictly later step): accepted, the floor only holds back the past.
      {:ok, %{step: step_59}} = TOTP.verify(@rfc_secret, "287082", 59, nil)
      assert step_59 == 1

      assert {:ok, %{step: 37_037_036}} = TOTP.verify(@rfc_secret, "081804", 1_111_111_109, step_59)
    end
  end

  describe "input hygiene" do
    test "generate_secret: 20 bytes, base32, unpadded, unique" do
      for _ <- 1..50 do
        secret = TOTP.generate_secret()
        refute secret =~ "="
        assert {:ok, key} = Base.decode32(secret, case: :mixed, padding: false)
        assert byte_size(key) == 20
      end

      secrets = for _ <- 1..20, do: TOTP.generate_secret()
      assert Enum.uniq(secrets) == secrets
    end

    test "lowercase and grouped (whitespace) secrets decode — authenticator apps print groups" do
      grouped = @rfc_secret |> String.graphemes() |> Enum.chunk_every(4) |> Enum.join(" ")
      lowercase = String.downcase(@rfc_secret)

      {:ok, code} = TOTP.code_for(@rfc_secret, 59)
      assert TOTP.verify(grouped, code, 59, nil) |> elem(0) == :ok
      assert TOTP.verify(lowercase, code, 59, nil) |> elem(0) == :ok
    end

    test "garbage codes are the uniform invalid_code (never a raise)" do
      for garbage <- ["", "abcdef", "12345", "1234567", "0o0o0o", nil, 42] do
        assert {:error, _} = TOTP.verify(@rfc_secret, garbage, 59, nil)
      end
    end

    test "an invalid secret is :invalid_secret, not a crash" do
      assert {:error, :invalid_secret} = TOTP.code_for("not!base32!", 59)
      assert {:error, :invalid_secret} = TOTP.verify("1", "287082", 59, nil)
    end

    test "otpauth_uri: the keychain-URI convention, params spelled out" do
      uri = TOTP.otpauth_uri("JBSWY3DPEHPK3PXP", "alice.example")

      assert uri =~ "otpauth://totp/Hrmny%3Aalice.example"
      assert uri =~ "issuer=Hrmny"
      assert uri =~ "algorithm=SHA1"
      assert uri =~ "digits=6"
      assert uri =~ "period=30"
    end
  end
end
