defmodule Cytale.Accounts.TOTP do
  @moduledoc """
  RFC 6238 TOTP over the account's base32 secret (ticket #127) — the
  authenticator-app defaults: HMAC-SHA1, 30-second steps, 6 digits.

  Hand-rolled rather than a Hex dep, deliberately. `nimble_totp` is the
  maintained candidate (Dashbit), but the repo pins ALL server dependencies
  wholesale in U4's mix.exs so `mix.lock` never churns across units
  (AGENTS.md hard rule #7) — adding a package for what is ~25 lines of
  `:crypto.mac/4` buys a dependency for no capability. The correctness risk
  of hand-rolling is retired by the RFC's own official SHA-1 test vectors
  (`totp_test.exs` asserts them verbatim) plus the ±1-window and
  step-monotonicity policy tests.

  The clock is a PARAMETER, not ambient: every function takes `now`
  (DateTime or unix seconds), so the suite moves time without mocks.

  Step arithmetic: `step = floor(unix / 30)` (T0 = 0, X = 30 — the RFC's
  defaults, and what every authenticator app ships). HOTP (RFC 4226) is the
  8-byte big-endian counter fed to HMAC-SHA1; the 6-digit code is the
  dynamic-truncation of that MAC mod 10^6, zero-padded.
  """

  @step_seconds 30
  @digits 6
  # The ±1-step acceptance window (ticket): a clock drifted by up to one
  # step (30s) in either direction still verifies.
  @window_steps 1
  # 20 random bytes = 160 bits — the RFC 4226 minimum-adequate secret, and
  # what every authenticator app expects.
  @secret_bytes 20

  @typedoc "The accepted code's position: `step` matched at offset `drift` ∈ -1..+1."
  @type match :: %{step: integer(), drift: integer()}

  # ---------------------------------------------------------------------------
  # Secrets
  # ---------------------------------------------------------------------------

  @doc """
  A fresh secret: 20 random bytes, base32 (RFC 4648, unpadded, uppercase) —
  the exact string the QR and the manual-entry field carry.
  """
  @spec generate_secret() :: String.t()
  def generate_secret do
    @secret_bytes
    |> :crypto.strong_rand_bytes()
    |> Base.encode32(padding: false)
  end

  @doc """
  The otpauth:// URI the client renders as a QR (the server never renders
  pixels — the ticket is explicit). Label is `Issuer:Account` per the
  keychain-URI convention; algorithm/digits/period are spelled out because
  the app defaults are exactly these and being explicit is free.
  """
  @spec otpauth_uri(String.t(), String.t()) :: String.t()
  def otpauth_uri(secret_b32, username) when is_binary(secret_b32) and is_binary(username) do
    label = URI.encode_www_form("Hrmny:#{username}")
    issuer = URI.encode_www_form("Hrmny")

    "otpauth://totp/#{label}?secret=#{secret_b32}&issuer=#{issuer}" <>
      "&algorithm=SHA1&digits=#{@digits}&period=#{@step_seconds}"
  end

  # ---------------------------------------------------------------------------
  # Code computation (the fixtures' half — what an authenticator app does)
  # ---------------------------------------------------------------------------

  @doc "The code `secret_b32` shows at `now` (a DateTime or unix seconds)."
  @spec code_for(String.t(), DateTime.t() | integer()) :: {:ok, String.t()} | {:error, :invalid_secret}
  def code_for(secret_b32, now) when is_binary(secret_b32) do
    case secret_bytes(secret_b32) do
      {:ok, key} -> {:ok, hotp(key, step_of(now))}
      :error -> {:error, :invalid_secret}
    end
  end

  def code_for(_, _), do: {:error, :invalid_secret}

  # ---------------------------------------------------------------------------
  # Verification (the server's half)
  # ---------------------------------------------------------------------------

  @doc """
  Verify `code` for `secret_b32` at time `now`. Accepts the current step or
  its ±1 neighbours (the window); the FIRST matching step wins (current, then
  +1, then -1 — a deterministic scan so a code valid at two window positions
  always records the same one).

  `min_step` is the replay floor: a matching step at or BELOW it is refused
  (already used — a code can never be accepted twice, ticket #127). Pass the
  account's `last_used_step` (`nil` = no prior use).

  Returns `{:ok, %{step: step, drift: drift}}` on acceptance, or
  `{:error, :invalid_code | :invalid_secret}` — the CALLER renders one
  uniform refusal for both (no oracle).
  """
  @spec verify(String.t(), String.t(), DateTime.t() | integer(), integer() | nil) ::
          {:ok, match()} | {:error, :invalid_code | :invalid_secret}
  def verify(secret_b32, code, now, min_step \\ nil)

  def verify(secret_b32, code, now, min_step) when is_binary(secret_b32) and is_binary(code) do
    case secret_bytes(secret_b32) do
      {:ok, key} -> try_steps(key, code, step_of(now), min_step)
      :error -> {:error, :invalid_secret}
    end
  end

  def verify(_, _, _, _), do: {:error, :invalid_code}

  # The scan is over [0, +1, -1] by offset: current step first, then the
  # future neighbour (the common clock-drift direction for a fast device),
  # then the past one. Each offset maps to exactly one step, so the scan
  # order never changes WHICH step a given code matches.
  defp try_steps(key, code, current, min_step) do
    normalized = normalize_code(code)
    floor = min_step || -1

    [0, @window_steps, -@window_steps]
    |> Enum.map(&(current + &1))
    |> Enum.filter(&(&1 > floor))
    |> Enum.find_value({:error, :invalid_code}, fn step ->
      if hotp(key, step) == normalized, do: {:ok, %{step: step, drift: step - current}}
    end)
  end

  @doc "The RFC 6238 time-step containing `now` (DateTime or unix seconds)."
  @spec step_of(DateTime.t() | integer()) :: integer()
  def step_of(%DateTime{} = now), do: div(DateTime.to_unix(now), @step_seconds)
  def step_of(unix) when is_integer(unix), do: div(unix, @step_seconds)

  # ---------------------------------------------------------------------------
  # Internals — RFC 4226 HOTP
  # ---------------------------------------------------------------------------

  # HMAC-SHA1 over the 8-byte big-endian step, then the RFC 4226 dynamic
  # truncation: low 4 bits pick the offset byte, 31 bits from there (masking
  # the top bit), mod 10^6, zero-padded to 6.
  defp hotp(key, step) do
    mac = :crypto.mac(:hmac, :sha, key, <<step::unsigned-big-integer-size(64)>>)
    <<_::binary-size(19), last>> = mac
    offset = Bitwise.band(last, 0x0F)
    <<p0, p1, p2, p3>> = :binary.part(mac, offset, 4)

    code =
      Bitwise.band(p0, 0x7F) * 16_777_216 + p1 * 65_536 + p2 * 256 + p3

    code |> rem(1_000_000) |> Integer.to_string() |> String.pad_leading(@digits, "0")
  end

  # Whitespace-tolerant base32: authenticator apps print secrets in groups,
  # and a user typing one in with the group spacing should not fail. Decode
  # is case-auto, padding optional.
  defp secret_bytes(secret_b32) do
    secret_b32
    |> String.replace(~r/\s+/, "")
    |> Base.decode32(case: :mixed, padding: false)
    |> case do
      {:ok, key} when byte_size(key) > 0 -> {:ok, key}
      _ -> :error
    end
  end

  # The presented code: digits only, spaces stripped. A non-6-digit remnant
  # simply fails the string compare in try_steps — no error channel, the same
  # refusal as a wrong code.
  defp normalize_code(code), do: String.replace(code, ~r/\s+/, "")
end
