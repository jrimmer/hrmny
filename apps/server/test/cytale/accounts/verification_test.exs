defmodule Cytale.Accounts.VerificationTest do
  @moduledoc """
  U8 verification orchestration + refresh rotation — DB-backed integration
  tests against the per-run `cytale_test` keyspace (hermetic-test policy:
  module-owned pool, drop/reapply per test, exactly like repo_test).
  """

  use Cytale.ScyllaCase, async: false

  import ExUnit.CaptureLog

  @keyspace Cytale.Repo.keyspace()

  alias Cytale.Accounts.{Auth, User, Verification}

  # Run-scoped unique suffix for fixture identifiers: distinct per `mix test`
  # invocation, so a crashed/killed previous run can never collide (keyspace
  # is no longer dropped per module — the schema apply is too slow to repeat).
  defmodule RunNonce do
    def get,
      do: "r#{:erlang.phash2({node(), System.system_time()}, 99_999)}_#{unquote(:erlang.unique_integer([:positive]))}"
  end

  describe "email verification flow" do
    test "register → send_verification → complete → user is verified" do
      nonce = RunNonce.get()
      {:ok, user} = User.create("verifier1#{nonce}", "verifier1@example.com#{nonce}", "password123")
      assert is_nil(user.email_verified_at)

      token =
        capture_send(
          fn -> Verification.send_verification(user.user_id) end,
          "verify_email",
          "verifier1@example.com#{nonce}"
        )

      assert :ok = Verification.complete_email_verification(token)

      verified = User.get(user.user_id)
      refute is_nil(verified.email_verified_at)
    end

    test "resend invalidates the old token (old → consumed, new works)" do
      nonce = RunNonce.get()
      {:ok, user} = User.create("verifier2#{nonce}", "verifier2@example.com#{nonce}", "password123")

      send = fn -> Verification.send_verification(user.user_id) end
      old_token = capture_send(send, "verify_email", "verifier2@example.com#{nonce}")
      new_token = capture_send(send, "verify_email", "verifier2@example.com#{nonce}")

      # OLD token: signature valid but its row was deleted by the resend.
      assert {:error, :consumed_token} = Verification.complete_email_verification(old_token)
      # NEW token works.
      assert :ok = Verification.complete_email_verification(new_token)
    end

    test "consumed verification token → :consumed_token (single-use)" do
      nonce = RunNonce.get()
      {:ok, user} = User.create("verifier3#{nonce}", "verifier3@example.com#{nonce}", "password123")

      token =
        capture_send(
          fn -> Verification.send_verification(user.user_id) end,
          "verify_email",
          "verifier3@example.com#{nonce}"
        )

      assert :ok = Verification.complete_email_verification(token)
      assert {:error, :consumed_token} = Verification.complete_email_verification(token)
    end

    test "garbage token → :invalid_token" do
      nonce = RunNonce.get()
      assert {:error, :invalid_token} = Verification.complete_email_verification("not-a-token")
    end

    # The live-box regression (2026-09-10): the dev mailbox was unwritable
    # (read-only container rootfs), and the adapter's raise turned a register
    # that had already created the row into a 500. Delivery is best-effort —
    # the PENDING row is what makes the token real, so the caller succeeds and
    # a resend after the sink is fixed delivers a working token.
    test "an undeliverable mail does not fail the request; a resend recovers" do
      nonce = RunNonce.get()
      email = "verifier5@example.com#{nonce}"
      {:ok, user} = User.create("verifier5#{nonce}", email, "password123")

      blocker = Path.join(System.tmp_dir!(), "cytale-mailbox-blocker-#{nonce}")
      File.write!(blocker, "")
      previous = System.get_env("CYTALE_DEV_MAILBOX")
      System.put_env("CYTALE_DEV_MAILBOX", Path.join(blocker, "dev_mailbox.jsonl"))
      on_exit(fn -> restore_mailbox(previous) end)

      log = capture_log(fn -> assert :ok = Verification.send_verification(user.user_id) end)
      assert log =~ "delivery FAILED"
      assert is_nil(User.get(user.user_id).email_verified_at)

      # Sink fixed (the operator points CYTALE_DEV_MAILBOX at a volume):
      # resend invalidates the pending row and delivers a token that works.
      restore_mailbox(previous)

      token = capture_send(fn -> Verification.send_verification(user.user_id) end, "verify_email", email)
      assert :ok = Verification.complete_email_verification(token)
      refute is_nil(User.get(user.user_id).email_verified_at)
    end

    test "deleted (tombstoned) user cannot complete verification" do
      nonce = RunNonce.get()
      {:ok, user} = User.create("verifier4#{nonce}", "verifier4@example.com#{nonce}", "password123")

      token =
        capture_send(
          fn -> Verification.send_verification(user.user_id) end,
          "verify_email",
          "verifier4@example.com#{nonce}"
        )

      :ok = User.soft_delete!(user.user_id)
      assert {:error, :user_not_found} = Verification.complete_email_verification(token)
    end
  end

  describe "password reset flow" do
    test "request → complete → old sessions revoked → new password logs in" do
      nonce = RunNonce.get()
      {:ok, user} = User.create("resetter1#{nonce}", "resetter1@example.com#{nonce}", "password123")

      # Establish a live session (refresh token stored).
      {:ok, _access, refresh, _hash, expires_at} = issue_session(user.user_id)
      assert Auth.refresh_token_valid?(user.user_id, refresh)

      token =
        capture_send(
          fn -> Verification.request_password_reset("resetter1@example.com#{nonce}") end,
          "password_reset",
          "resetter1@example.com#{nonce}"
        )

      assert :ok = Verification.complete_password_reset(token, "brand-new-password-99")

      # Sessions revoked.
      refute Auth.refresh_token_valid?(user.user_id, refresh)
      # Old password dead, new password works.
      old = User.get(user.user_id)
      refute Auth.valid_password?("password123", old.password_hash)
      assert Auth.valid_password?("brand-new-password-99", old.password_hash)
    end

    test "reset completion rotates away ALL refresh tokens, not just one" do
      nonce = RunNonce.get()
      {:ok, user} = User.create("resetter2#{nonce}", "resetter2@example.com#{nonce}", "password123")
      {:ok, _a1, r1, _h1, _e1} = issue_session(user.user_id)
      {:ok, _a2, r2, _h2, _e2} = issue_session(user.user_id)

      token =
        capture_send(
          fn -> Verification.request_password_reset("resetter2@example.com#{nonce}") end,
          "password_reset",
          "resetter2@example.com#{nonce}"
        )

      assert :ok = Verification.complete_password_reset(token, "another-new-password-1")

      refute Auth.refresh_token_valid?(user.user_id, r1)
      refute Auth.refresh_token_valid?(user.user_id, r2)
    end

    # Password reset is the flow a LOCKED-OUT user is in: a mail failure must
    # still leave a usable state (the new token is issued on the next request),
    # never a failed request.
    test "an undeliverable reset mail does not fail the request; a resend recovers" do
      nonce = RunNonce.get()
      email = "resetter4@example.com#{nonce}"
      {:ok, user} = User.create("resetter4#{nonce}", email, "password123")

      blocker = Path.join(System.tmp_dir!(), "cytale-mailbox-blocker-#{nonce}")
      File.write!(blocker, "")
      previous = System.get_env("CYTALE_DEV_MAILBOX")
      System.put_env("CYTALE_DEV_MAILBOX", Path.join(blocker, "dev_mailbox.jsonl"))
      on_exit(fn -> restore_mailbox(previous) end)

      log = capture_log(fn -> assert :ok = Verification.request_password_reset(email) end)
      assert log =~ "delivery FAILED"

      restore_mailbox(previous)

      token = capture_send(fn -> Verification.request_password_reset(email) end, "password_reset", email)
      assert :ok = Verification.complete_password_reset(token, "brand-new-password-99")
      assert Auth.valid_password?("brand-new-password-99", User.get(user.user_id).password_hash)
    end

    test "request for unknown identifier is anti-enumeration :ok (no token mailed)" do
      nonce = RunNonce.get()

      log =
        capture_log(fn -> assert :ok = Verification.request_password_reset("nobody-here@example.com#{nonce}") end)

      refute log =~ "password_reset mail for", "no mail may go out for unknown identifiers"
    end

    test "wrong-purpose token → :invalid_token" do
      nonce = RunNonce.get()
      {:ok, user} = User.create("resetter3#{nonce}", "resetter3@example.com#{nonce}", "password123")

      verify_token =
        capture_send(
          fn -> Verification.send_verification(user.user_id) end,
          "verify_email",
          "resetter3@example.com#{nonce}"
        )

      assert {:error, :invalid_token} =
               Verification.complete_password_reset(verify_token, "irrelevant-password-1")

      assert is_nil(User.get(user.user_id).deleted_at)
    end

    test "short new password → :invalid_password" do
      nonce = RunNonce.get()
      {:ok, _user} = User.create("resetter4#{nonce}", "resetter4@example.com#{nonce}", "password123")

      token =
        capture_send(
          fn -> Verification.request_password_reset("resetter4@example.com#{nonce}") end,
          "password_reset",
          "resetter4@example.com#{nonce}"
        )

      assert {:error, :invalid_password} = Verification.complete_password_reset(token, "short")
    end
  end

  describe "refresh rotation (Auth + TokenStore)" do
    test "issue → valid; rotate → old revoked, new valid; replay → :revoked" do
      nonce = RunNonce.get()
      {:ok, user} = User.create("rotator1#{nonce}", "rotator1@example.com#{nonce}", "password123")
      {:ok, _access, refresh, _hash, expires_at} = issue_session(user.user_id)

      assert Auth.refresh_token_valid?(user.user_id, refresh)
      assert DateTime.compare(expires_at, DateTime.utc_now()) == :gt

      {:ok, new_refresh, _hash, _exp} = Auth.rotate_refresh_token(user.user_id, refresh)
      refute Auth.refresh_token_valid?(user.user_id, refresh), "old token dead after rotation"
      assert Auth.refresh_token_valid?(user.user_id, new_refresh)
      refute new_refresh == refresh

      # Replay the old one → :revoked.
      assert {:error, :revoked} = Auth.rotate_refresh_token(user.user_id, refresh)
    end

    test "tokens stored as SHA-256 hashes only — raw never lands in the table" do
      nonce = RunNonce.get()
      {:ok, user} = User.create("rotator2#{nonce}", "rotator2@example.com#{nonce}", "password123")
      {:ok, _access, raw, hash, _exp} = issue_session(user.user_id)

      stored = Cytale.Accounts.TokenStore.list(user.user_id)
      assert [%{token_hash: stored_hash}] = stored
      assert stored_hash == hash
      assert stored_hash != raw
      refute String.contains?(stored_hash, raw)
      assert String.length(stored_hash) == 64
    end

    test "revoke_all_sessions deletes every stored hash" do
      nonce = RunNonce.get()
      {:ok, user} = User.create("rotator3#{nonce}", "rotator3@example.com#{nonce}", "password123")
      {:ok, _a, r1, _h1, _e1} = issue_session(user.user_id)
      {:ok, _a, r2, _h2, _e2} = issue_session(user.user_id)

      :ok = Auth.revoke_all_sessions(user.user_id)
      assert Cytale.Accounts.TokenStore.list(user.user_id) == []
      refute Auth.refresh_token_valid?(user.user_id, r1)
      refute Auth.refresh_token_valid?(user.user_id, r2)
    end
  end

  describe "user creation + lookup (case-insensitive)" do
    test "create assigns Snowflake id; lookup by exact/case variants of username or email" do
      nonce = RunNonce.get()
      {:ok, user} = User.create("MixedCase#{nonce}", "Mixed@Example.COM#{nonce}", "password123")
      assert user.user_id > 0
      assert is_nil(user.deleted_at)

      assert %{user_id: id} = User.get_by_identifier("mixedcase#{nonce}")
      assert id == user.user_id
      assert %{user_id: ^id} = User.get_by_identifier("MIXEDCASE#{nonce}")
      assert %{user_id: ^id} = User.get_by_identifier("mixed@example.com#{nonce}")
      assert %{user_id: ^id} = User.get_by_identifier("MIXED@EXAMPLE.COM#{nonce}")
    end

    test "case-insensitive uniqueness: register Alice then ALICE → :username_taken" do
      nonce = RunNonce.get()

      {:ok, _u1} = User.create("alice_x#{nonce}", "alice_x@example.com#{nonce}", "password123")
      assert {:error, :username_taken} = User.create("ALICE_X#{nonce}", "other@example.com", "password123")
      assert {:error, :email_taken} = User.create("other_name#{nonce}", "ALICE_X@EXAMPLE.COM#{nonce}", "password123")
    end

    test "input validation: bad username/email/password" do
      nonce = RunNonce.get()
      assert {:error, :invalid_username} = User.create("a", "a@example.com", "password123")
      assert {:error, :invalid_username} = User.create("has@at", "hasat@example.com", "password123")
      assert {:error, :invalid_email} = User.create("valid_name#{nonce}", "not-an-email", "password123")
      assert {:error, :invalid_password} = User.create("valid_name#{nonce}", "valid@example.com", "short")
    end

    test "soft-delete tombstone sets deleted_at; handle stays non-reusable" do
      nonce = RunNonce.get()
      {:ok, user} = User.create("tombstone#{nonce}", "tombstone@example.com#{nonce}", "password123")
      :ok = User.soft_delete!(user.user_id)

      assert %DateTime{} = User.get(user.user_id).deleted_at
      # handle NOT freed
      assert {:error, :username_taken} = User.create("tombstone#{nonce}", "new@example.com", "password123")
      assert {:error, :email_taken} = User.create("brand_new", "tombstone@example.com#{nonce}", "password123")
    end
  end

  # -- helpers -----------------------------------------------------------------

  defp issue_session(user_id) do
    access = Auth.issue_access_token(user_id, "ignored", false)
    {:ok, refresh, hash, expires_at} = Auth.issue_refresh_token(user_id)
    {:ok, access, refresh, hash, expires_at}
  end

  # Pulls the raw token out of the Dev mailer's mailbox FILE (P0-3 moved the
  # token sink off the log line — the file IS the dev delivery channel now).
  defp capture_send(send_fun, kind, to) do
    Cytale.TestMailbox.capture(send_fun, kind, to)
  end

  # System.put_env/2 is VM-global, so the tests that point the dev mailbox at
  # an unwritable path capture the original value themselves and restore it
  # through here (async: false suite — no other module runs beside them).
  defp restore_mailbox(previous) do
    if previous do
      System.put_env("CYTALE_DEV_MAILBOX", previous)
    else
      System.delete_env("CYTALE_DEV_MAILBOX")
    end
  end
end
