defmodule Cytale.Accounts.AuthTest do
  use ExUnit.Case, async: false

  # Reaches the database directly (no ScyllaCase) — excluded from a no-DB run.
  @moduletag :scylla

  @moduledoc """
  U8 auth primitives — pure-logic tests (argon2, JWT, single-use token
  signing). No ScyllaDB pool required; refresh-token storage paths live in
  token_store_test (integration).
  """

  setup do
    # Auth config comes from config/test.exs (static for the whole run).
    # Mutating + on_exit-deleting it here races every other module that reads
    # :cytale, :auth concurrently (observed: "auth secret missing" suite-wide).
    :ok
  end

  describe "password hashing (argon2id)" do
    test "hash → verify round-trips; wrong password fails" do
      hash = Cytale.Accounts.Auth.hash_password("correct horse battery staple")
      assert String.starts_with?(hash, "$argon2id$")
      assert Cytale.Accounts.Auth.valid_password?("correct horse battery staple", hash)
      refute Cytale.Accounts.Auth.valid_password?("wrong password", hash)
    end

    test "unique salts: same password hashes differently" do
      h1 = Cytale.Accounts.Auth.hash_password("same")
      h2 = Cytale.Accounts.Auth.hash_password("same")
      refute h1 == h2
    end

    test "invalid stored hash never raises — returns false" do
      refute Cytale.Accounts.Auth.valid_password?("pw", "not-a-hash")
      refute Cytale.Accounts.Auth.valid_password?(nil, "$argon2id$whatever")
    end
  end

  describe "access JWTs" do
    test "issue → verify round-trips the identity claims" do
      token = Cytale.Accounts.Auth.issue_access_token(123_456, "alice", true)
      assert {:ok, claims} = Cytale.Accounts.Auth.verify_access_token(token)
      assert claims.user_id == 123_456
      assert claims.username == "alice"
      assert claims.verified == true
    end

    test "tampered/garbage tokens → :invalid; non-binary → :malformed" do
      token = Cytale.Accounts.Auth.issue_access_token(1, "a", false)
      assert {:error, :invalid} = Cytale.Accounts.Auth.verify_access_token(token <> "x")
      assert {:error, :invalid} = Cytale.Accounts.Auth.verify_access_token("garbage")
      assert {:error, :malformed} = Cytale.Accounts.Auth.verify_access_token(nil)
    end

    test "expired token → :invalid (client refreshes)" do
      # Restore the FULL keyword list (a partial put drops :refresh_pepper
      # and breaks every other test in the run).
      Application.put_env(:cytale, :auth,
        jwt_secret: "test-only-jwt-secret-do-not-ship",
        refresh_pepper: "test-only-refresh-pepper-do-not-ship",
        access_token_ttl_ms: 1,
        refresh_token_ttl_ms: 2_592_000_000
      )

      try do
        token = Cytale.Accounts.Auth.issue_access_token(7, "bob", true)
        Process.sleep(5)
        assert {:error, :invalid} = Cytale.Accounts.Auth.verify_access_token(token)
      after
        Application.put_env(:cytale, :auth,
          jwt_secret: "test-only-jwt-secret-do-not-ship",
          refresh_pepper: "test-only-refresh-pepper-do-not-ship",
          access_token_ttl_ms: 900_000,
          refresh_token_ttl_ms: 2_592_000_000
        )
      end
    end
  end

  describe "single-use tokens (purpose-scoped)" do
    test "sign embeds purpose + exp; hash differs from raw (pure, no pool)" do
      assert {:ok, raw, hash, expires_at, "verify_email"} =
               Cytale.Accounts.Auth.sign_single_use_token(42, "verify_email")

      assert is_binary(raw) and String.length(hash) == 64
      refute String.contains?(raw, hash)
      assert DateTime.compare(expires_at, DateTime.utc_now()) == :gt

      assert {:ok, %{user_id: 42, purpose: "verify_email"}} =
               Cytale.Accounts.Auth.decode_single_use_token(raw, "verify_email")
    end

    test "purpose decode mismatch → :purpose_mismatch (pure)" do
      {:ok, raw, _hash, _exp, "verify_email"} = Cytale.Accounts.Auth.sign_single_use_token(44, "verify_email")
      assert {:error, :purpose_mismatch} = Cytale.Accounts.Auth.decode_single_use_token(raw, "password_reset")
    end

    test "verify_single_use_token: malformed input types → :malformed without touching storage" do
      # nil is not a binary → :malformed (decode never runs, no pool needed)
      assert {:error, :malformed} = Cytale.Accounts.Auth.verify_single_use_token(nil, "verify_email")
      # storage-touching failure paths (:consumed, signed-but-unissued) are
      # exercised in verification_test (pool-backed, per hermetic policy).
    end

    test "unknown purpose rejected at sign and issue" do
      assert {:error, :purpose} = Cytale.Accounts.Auth.sign_single_use_token(1, "magic_link")
    end
  end
end
