defmodule CytaleWeb.Controllers.AuthTokenHardeningTest do
  @moduledoc """
  Tier 3 (B) findings 1 and 6: token typing and the refresh flow.

    * a single-use verify/reset token is never an access token (Bearer or
      the refresh path's identity token) — the `typ` claim keeps them apart,
      while access tokens minted before the claim still verify;
    * refresh tokens are random bytes stored as HMAC(pepper, raw) — no pepper
      on the wire — and pre-HMAC tokens keep rotating;
    * only the replay of a ROTATED token revokes the family; an unknown token
      is merely refused.
  """

  use Cytale.ScyllaCase, async: false

  import ExUnit.CaptureLog

  alias Cytale.Accounts.{Auth, TokenStore, User}

  @endpoint CytaleWeb.Endpoint

  defp uniq(base), do: base <> "th" <> Cytale.TestNonce.get() <> Integer.to_string(System.unique_integer([:positive]))

  defp create_user do
    name = uniq("u")
    {:ok, user} = User.create(name, name <> "@example.com", "password-123")
    user
  end

  defp json_conn do
    build_conn()
    |> put_req_header("accept", "application/json")
    |> put_req_header("content-type", "application/json")
  end

  defp bearer(token), do: put_req_header(json_conn(), "authorization", "Bearer " <> token)

  defp signer do
    Joken.Signer.create("HS256", Keyword.fetch!(Application.get_env(:cytale, :auth), :jwt_secret))
  end

  defp pepper, do: Keyword.fetch!(Application.get_env(:cytale, :auth), :refresh_pepper)

  describe "token typing (finding 1)" do
    test "a password-reset or verify-email token used as a Bearer is 401" do
      user = create_user()

      for purpose <- ["password_reset", "verify_email"] do
        {:ok, raw, _hash} = Auth.issue_single_use_token(user.user_id, purpose)
        assert {:error, :invalid} = Auth.verify_access_token(raw)
        assert get(bearer(raw), "/api/v1/users/@me").status == 401, "#{purpose} token passed as a Bearer"
      end

      assert get(bearer(Auth.issue_access_token(user.user_id, user.username, true)), "/api/v1/users/@me").status ==
               200
    end

    test "a single-use token cannot stand in for the refresh path's identity token" do
      user = create_user()
      {:ok, refresh, _hash, _exp} = Auth.issue_refresh_token(user.user_id)
      {:ok, reset, _hash} = Auth.issue_single_use_token(user.user_id, "password_reset")

      resp = post(bearer(reset), "/api/v1/auth/refresh", %{"refresh_token" => refresh})
      assert resp.status == 401
      assert Auth.refresh_token_valid?(user.user_id, refresh)
    end

    test "a hand-rolled token with a foreign typ, or a purpose claim, is refused" do
      user = create_user()
      exp = System.system_time(:second) + 600
      base = %{"sub" => Integer.to_string(user.user_id), "username" => user.username, "verified" => true, "exp" => exp}

      {:ok, typed, _} = Joken.encode_and_sign(Map.put(base, "typ", "password_reset"), signer())
      {:ok, purposed, _} = Joken.encode_and_sign(Map.merge(base, %{"typ" => "access", "purpose" => "x"}), signer())

      assert {:error, :invalid} = Auth.verify_access_token(typed)
      assert {:error, :invalid} = Auth.verify_access_token(purposed)
    end

    test "an access token minted before the typ claim (no typ, no purpose) still verifies" do
      user = create_user()
      exp = System.system_time(:second) + 600

      {:ok, legacy, _} =
        Joken.encode_and_sign(
          %{"sub" => Integer.to_string(user.user_id), "username" => user.username, "verified" => true, "exp" => exp},
          signer()
        )

      assert {:ok, %{user_id: id}} = Auth.verify_access_token(legacy)
      assert id == user.user_id
      assert get(bearer(legacy), "/api/v1/users/@me").status == 200
    end

    test "a new single-use token still works for its own purpose" do
      user = create_user()
      {:ok, raw, _hash} = Auth.issue_single_use_token(user.user_id, "verify_email")
      assert {:error, :purpose_mismatch} = Auth.decode_single_use_token(raw, "password_reset")
      assert {:ok, _} = Auth.decode_single_use_token(raw, "verify_email")
    end
  end

  describe "refresh token storage (finding 6a)" do
    test "the raw token carries no pepper and is stored as HMAC(pepper, raw)" do
      user = create_user()
      {:ok, raw, hash, _exp} = Auth.issue_refresh_token(user.user_id)

      refute String.contains?(raw, pepper())
      refute String.contains?(raw, ":")
      assert hash == Base.encode16(:crypto.mac(:hmac, :sha256, pepper(), raw), case: :lower)
      assert [%{token_hash: ^hash}] = TokenStore.list(user.user_id)
    end

    test "a pre-HMAC token (pepper:random, stored as SHA-256) keeps working and rotates onto the new scheme" do
      user = create_user()
      legacy_raw = pepper() <> ":" <> Base.url_encode64(:crypto.strong_rand_bytes(32), padding: false)
      legacy_hash = Base.encode16(:crypto.hash(:sha256, legacy_raw), case: :lower)
      :ok = TokenStore.put(user.user_id, legacy_hash, DateTime.add(DateTime.utc_now(), 3600, :second))

      assert Auth.refresh_token_valid?(user.user_id, legacy_raw)

      access = Auth.issue_access_token(user.user_id, user.username, true)
      resp = post(bearer(access), "/api/v1/auth/refresh", %{"refresh_token" => legacy_raw})
      assert %{"refresh_token" => new_raw} = json_response(resp, 200)

      refute Auth.refresh_token_valid?(user.user_id, legacy_raw)
      assert Auth.refresh_token_valid?(user.user_id, new_raw)
      refute String.contains?(new_raw, pepper())
    end

    test "logout revokes a pre-HMAC token too" do
      user = create_user()
      legacy_raw = pepper() <> ":" <> Base.url_encode64(:crypto.strong_rand_bytes(32), padding: false)
      legacy_hash = Base.encode16(:crypto.hash(:sha256, legacy_raw), case: :lower)
      :ok = TokenStore.put(user.user_id, legacy_hash, DateTime.add(DateTime.utc_now(), 3600, :second))

      access = Auth.issue_access_token(user.user_id, user.username, true)
      assert post(bearer(access), "/api/v1/auth/logout", %{"refresh_token" => legacy_raw}).status == 200
      refute Auth.refresh_token_valid?(user.user_id, legacy_raw)
    end
  end

  describe "replay detection (finding 6b)" do
    test "a garbage refresh token plus a valid (even expired) access token revokes nothing" do
      user = create_user()
      {:ok, keep, _hash, _exp} = Auth.issue_refresh_token(user.user_id)
      epoch_before = Auth.credential_epoch(user.user_id)

      # An EXPIRED but signature-valid access token for the victim.
      {:ok, expired, _} =
        Joken.encode_and_sign(
          %{
            "typ" => "access",
            "sub" => Integer.to_string(user.user_id),
            "username" => user.username,
            "verified" => true,
            "exp" => System.system_time(:second) - 60
          },
          signer()
        )

      log =
        capture_log(fn ->
          resp = post(bearer(expired), "/api/v1/auth/refresh", %{"refresh_token" => "garbage-token"})
          assert resp.status == 401
          assert %{"error" => %{"key" => "refresh_revoked"}} = json_response(resp, 401)
        end)

      refute log =~ "replay detected"
      assert Auth.refresh_token_valid?(user.user_id, keep), "an unknown token must not revoke the family"
      assert Auth.credential_epoch(user.user_id) == epoch_before
    end

    test "the replay of a rotated token still revokes the family" do
      user = create_user()
      {:ok, a, _hash, _exp} = Auth.issue_refresh_token(user.user_id)
      {:ok, b, _hash2, _exp2} = Auth.rotate_refresh_token(user.user_id, a)

      capture_log(fn -> assert {:error, :revoked} = Auth.rotate_refresh_token(user.user_id, a) end)

      refute Auth.refresh_token_valid?(user.user_id, b)
      assert TokenStore.list(user.user_id) == []
    end
  end
end
