defmodule Cytale.SSH.CertificateStoreTest do
  @moduledoc """
  U2 store-level coverage: the stored public keys, the issuance rows, the
  by-serial index the bridge resolves, and the account-deletion cascade's
  ASYMMETRY — certificate rows go, audit rows stay (de-identified).

  The issuance rows are built here rather than signed: `record_issuance/4`
  consumes the signer's `issued` map, and this suite is about what the store
  does with it. Signing is exercised end to end in
  `CytaleWeb.Controllers.SshCertificateControllerTest`.
  """

  use Cytale.ScyllaCase, async: false

  alias Cytale.Accounts.{Deletion, User}
  alias Cytale.SSH.{Audit, CertificateStore}

  setup do
    :ok = Cytale.Snowflake.ensure_init()
    {:ok, user} = User.create(unique("ssh_store"), unique("ssh_store") <> "@example.com", "password-123")
    {:ok, account_id: user.user_id, user: user}
  end

  describe "stored keys" do
    test "stores a key, returns it, and is idempotent for the same key", %{account_id: account_id} do
      blob = key_blob()
      key_id = CertificateStore.key_id(blob)
      fingerprint = CertificateStore.fingerprint(blob)

      assert {:ok, key} =
               CertificateStore.put_key(account_id,
                 key_id: key_id,
                 fingerprint: fingerprint,
                 public_key: line_for(blob)
               )

      assert key.key_id == key_id
      assert key.fingerprint == fingerprint
      assert CertificateStore.get_key(account_id, key_id).public_key == line_for(blob)

      # Submitting the same key again is not a second key: the row is the same,
      # which is what makes R6's re-issue path a re-issue rather than a new
      # credential.
      assert {:ok, again} =
               CertificateStore.put_key(account_id,
                 key_id: key_id,
                 fingerprint: fingerprint,
                 public_key: line_for(blob)
               )

      assert again.key_id == key_id
      assert length(CertificateStore.list_keys(account_id)) == 1
    end

    test "caps how many distinct keys one account may store", %{account_id: account_id} do
      cap = CertificateStore.max_keys_per_account()

      for _i <- 1..cap do
        blob = key_blob()

        assert {:ok, _key} =
                 CertificateStore.put_key(account_id,
                   key_id: CertificateStore.key_id(blob),
                   fingerprint: CertificateStore.fingerprint(blob),
                   public_key: line_for(blob)
                 )
      end

      assert length(CertificateStore.list_keys(account_id)) == cap

      over = key_blob()

      assert {:error, :key_limit_reached} =
               CertificateStore.put_key(account_id,
                 key_id: CertificateStore.key_id(over),
                 fingerprint: CertificateStore.fingerprint(over),
                 public_key: line_for(over)
               )
    end

    test "removing a key takes its certificates and the by-serial rows with it", %{
      account_id: account_id
    } do
      blob = key_blob()
      key_id = CertificateStore.key_id(blob)

      {:ok, _key} =
        CertificateStore.put_key(account_id,
          key_id: key_id,
          fingerprint: CertificateStore.fingerprint(blob),
          public_key: line_for(blob)
        )

      issued = issued_at(principal: "store-user")
      :ok = record(account_id, key_id, issued)

      assert [_] = CertificateStore.list_certificates(account_id)
      assert %{} = CertificateStore.get_by_serial(issued.serial)

      :ok = CertificateStore.remove_key(account_id, key_id)

      assert CertificateStore.list_keys(account_id) == []
      assert CertificateStore.list_certificates(account_id) == []
      assert CertificateStore.get_by_serial(issued.serial) == nil
    end
  end

  describe "issuance rows" do
    test "a re-issue supersedes the previous row rather than replacing it", %{account_id: account_id} do
      blob = key_blob()
      key_id = CertificateStore.key_id(blob)

      {:ok, _key} =
        CertificateStore.put_key(account_id,
          key_id: key_id,
          fingerprint: CertificateStore.fingerprint(blob),
          public_key: line_for(blob)
        )

      first = issued_at(principal: "store-user")
      second = issued_at(principal: "store-user")

      :ok = record(account_id, key_id, first)
      :ok = record(account_id, key_id, second)

      certificates = CertificateStore.list_certificates(account_id)

      assert length(certificates) == 2, "both rows stay listable (R5)"

      current = Enum.filter(certificates, & &1.is_current)

      assert [%{serial: serial}] = current
      assert serial == second.serial, "the newest issuance is the current one"

      superseded = Enum.reject(certificates, & &1.is_current)
      assert [%{serial: superseded_serial}] = superseded
      assert superseded_serial == first.serial

      # Both remain resolvable: superseded is not revoked (the certificate stays
      # valid until its own window closes).
      assert CertificateStore.get_by_serial(first.serial)
      assert CertificateStore.get_by_serial(second.serial)
    end

    test "a row aged out of retention is unresolvable while the key survives", %{
      account_id: account_id
    } do
      blob = key_blob()
      key_id = CertificateStore.key_id(blob)

      {:ok, _key} =
        CertificateStore.put_key(account_id,
          key_id: key_id,
          fingerprint: CertificateStore.fingerprint(blob),
          public_key: line_for(blob)
        )

      issued = issued_at(principal: "store-user")
      :ok = record(account_id, key_id, issued, retention_ms: 1)

      # The TTL is a second and Scylla expires whole seconds, so give the row
      # up to two of them to go before asserting on retention.
      Process.sleep(2_500)

      assert CertificateStore.get_by_serial(issued.serial) == nil,
             "an aged-out issuance row must not resolve on signature alone"

      assert [%{public_key: _}] = CertificateStore.list_keys(account_id),
             "the stored key must OUTLIVE its certificates — R6 re-issues against it"
    end
  end

  describe "the account-deletion cascade" do
    test "certificate rows cascade; audit rows do not (they are de-identified)", %{
      account_id: account_id,
      user: user
    } do
      blob = key_blob()
      key_id = CertificateStore.key_id(blob)

      {:ok, _key} =
        CertificateStore.put_key(account_id,
          key_id: key_id,
          fingerprint: CertificateStore.fingerprint(blob),
          public_key: line_for(blob)
        )

      issued = issued_at(principal: user.username)
      :ok = record(account_id, key_id, issued)

      :ok =
        Audit.record(%{
          account_id: account_id,
          action: :issued,
          outcome: :ok,
          serial: issued.serial,
          principal: user.username,
          fingerprint: CertificateStore.fingerprint(blob)
        })

      assert [_ | _] = Audit.list_for_account(account_id)

      :ok = Deletion.delete_account(account_id, sync: true)

      assert CertificateStore.list_keys(account_id) == []
      assert CertificateStore.list_certificates(account_id) == []
      assert CertificateStore.get_by_serial(issued.serial) == nil

      assert Audit.list_for_account(account_id) == [],
             "the deleted account's partition must hold nothing"

      orphaned =
        Audit.list_for_account(Audit.unknown_account_id(), 1_000)
        |> Enum.filter(&(&1.serial == issued.serial))

      assert [event] = orphaned,
             "the audit row must OUTLIVE the account (it is the detection path)"

      assert event.action == :issued
      assert event.outcome == :ok
      assert event.principal == nil, "the account reference is de-identified, not merely moved"
    end
  end

  # ---------------------------------------------------------------------------
  # fixtures
  # ---------------------------------------------------------------------------

  defp unique(base), do: base <> Cytale.TestNonce.get()

  # A real ed25519 public key BLOB built the way OpenSSH builds one:
  # string("ssh-ed25519") || string(32-byte point). Nothing here needs
  # ssh-keygen — the store only ever sees the blob, the line and the
  # fingerprint, all of which derive from these bytes.
  defp key_blob do
    {point, _private} = :crypto.generate_key(:eddsa, :ed25519)
    <<11::32, "ssh-ed25519", 32::32, point::binary>>
  end

  defp line_for(blob), do: "ssh-ed25519 " <> Base.encode64(blob) <> " cytale-store-test"

  defp issued_at(opts) do
    now = System.os_time(:second)
    serial = Cytale.Snowflake.next()

    %{
      line: "ssh-ed25519-cert-v01@openssh.com AAAA test\n",
      payload: <<>>,
      serial: serial,
      key_id: Integer.to_string(serial),
      principal: Keyword.fetch!(opts, :principal),
      valid_after: now,
      valid_before: now + 86_400,
      nonce: <<0::256>>,
      public_key_blob: <<>>
    }
  end

  defp record(account_id, key_id, issued, opts \\ []) do
    CertificateStore.record_issuance(
      account_id,
      key_id,
      issued,
      Keyword.merge(
        [
          # The row records the STORED key's fingerprint, exactly as the
          # controller passes it — one source, so the two cannot drift.
          fingerprint: CertificateStore.get_key(account_id, key_id).fingerprint,
          credential_epoch: 0
        ],
        opts
      )
    )
  end
end
