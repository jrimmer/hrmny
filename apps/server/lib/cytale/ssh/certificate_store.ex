defmodule Cytale.SSH.CertificateStore do
  @moduledoc """
  Storage for the SSH certificate surface (U2, R5/R5a/R6/R7/R8): the public
  keys a member has submitted, the certificates this server issued for them,
  and the by-serial index the session bridge resolves an asserted serial
  against.

  Three row shapes, three jobs:

    * **`ssh_keys`** — the STORED PUBLIC KEY. Long-lived and TTL-free on
      purpose: the certificate lasts 24 hours and the member re-issues against
      the stored key (R6), so a key that aged out with its certificate would
      break the recurring path this whole surface exists for. Removing a key
      (R5a) deletes it, and with it every certificate and by-serial row the key
      produced — which is what makes "removed" mean *further issuance and
      further mints are impossible* rather than *hidden from the list*.
    * **`ssh_certificates`** — the issuance rows, per account and key.
      Certificates are SUPERSEDED rather than revoked: `is_current` marks the
      newest issuance for a key, older rows stay listable (R5), and every row
      carries a retention TTL. A superseded row is bounded retention, not a
      revoked credential: the certificate itself stays valid until its own
      `valid_before`, which is what "superseded rather than revoked" means.
    * **`ssh_certificates_by_serial`** — the bridge's point lookup (R7/R8). A
      serial is globally unique, so the bridge resolves an asserted serial to
      the issuance it made without knowing which account it is asking about.
      The serial is the request's LOOKUP key, never its replay key (see
      `Cytale.SessionBridge`).

  ## Identity values

  A public key has two derived names, and both live here because both are the
  identity of the row:

    * `key_id` — `base64url(SHA-256(key blob))`, URL-safe and unpadded, so it
      can address a route (`/users/@me/ssh/certificates/:key_id`) without an
      escaping hazard. The OpenSSH fingerprint contains `/`, `+` and `=`, which
      is exactly what a path segment cannot carry.
    * `fingerprint` — the OpenSSH-shaped `SHA256:<base64-unpadded>` a member
      reads (R5) and a session host asserts (R8). `normalize_fingerprint/1`
      accepts the padded form and the bare body too, because the bridge's input
      comes from another language's standard library.

  ## The per-account cap

  `max_keys_per_account/0` bounds how many stored keys one account may hold.
  That is the issuance cap in practice — a certificate cannot be issued for a
  key the account never stored — and it is the bound that actually matters for
  growth, because re-issuing the same key is bounded by the issuance rows'
  TTL. The check is a read-then-insert on one partition; two simultaneous
  submissions of two DIFFERENT keys can overshoot by one rather than
  over-counting, which is the right failure direction for a resource bound
  (never refuse a legitimate single request for it).

  All queries use typed Xandra param tuples (`{"bigint", ...}`, `{"text", ...}`,
  `{"timestamp", ...}`, `{"boolean", ...}`, `{"int", ...}`) — bare values raise
  FunctionClauseError in Xandra 0.20.
  """

  alias Cytale.Repo

  # Bounded by design: this is a per-member credential store, not a keyring.
  # Ten covers "laptop, desktop, phone, a rebuilt laptop, a work machine" with
  # room to spare.
  @max_keys_per_account 10

  # The issuance rows' retention bound: a certificate lives 24 hours, so a
  # superseded row is only useful for the member's own list and for the
  # bridge's window. Fourteen days keeps the "superseded" marker and the
  # aged-out-by-TTL test meaningful while bounding the table.
  @retention_ms 14 * 24 * 60 * 60 * 1000

  @typedoc "A stored public key (the long-lived half of the pair)."
  @type key_row :: %{
          account_id: integer(),
          key_id: String.t(),
          fingerprint: String.t(),
          public_key: String.t(),
          comment: String.t() | nil,
          created_at: DateTime.t()
        }

  @typedoc "One issuance row: a certificate this server signed."
  @type certificate_row :: %{
          serial: integer(),
          key_id: String.t(),
          principal: String.t(),
          credential_epoch: integer(),
          issued_at: DateTime.t(),
          valid_after: DateTime.t(),
          valid_before: DateTime.t(),
          is_current: boolean()
        }

  @typedoc "What the bridge resolves a serial to (no account knowledge needed)."
  @type issuance_row :: %{
          serial: integer(),
          account_id: integer(),
          key_id: String.t(),
          fingerprint: String.t(),
          principal: String.t(),
          credential_epoch: integer(),
          valid_after: DateTime.t(),
          valid_before: DateTime.t()
        }

  @doc "How many stored keys one account may hold (the issuance cap)."
  @spec max_keys_per_account() :: pos_integer()
  def max_keys_per_account, do: @max_keys_per_account

  @doc "How long an issuance row is retained before its TTL evicts it."
  @spec retention_ms() :: pos_integer()
  def retention_ms, do: @retention_ms

  # ---------------------------------------------------------------------------
  # Identity values
  # ---------------------------------------------------------------------------

  @doc "The route-addressable id of a key blob: base64url(SHA-256(blob))."
  @spec key_id(binary()) :: String.t()
  def key_id(blob) when is_binary(blob), do: Base.url_encode64(sha256(blob), padding: false)

  @doc """
  The OpenSSH fingerprint of a key blob: `SHA256:<base64-unpadded>`. This is
  the identical string `ssh-keygen -lf` prints, which is what makes R5's
  "a fingerprint identifying which public key each belongs to" checkable by
  the member against the key on their disk.
  """
  @spec fingerprint(binary()) :: String.t()
  def fingerprint(blob) when is_binary(blob) do
    "SHA256:" <> Base.encode64(sha256(blob), padding: false)
  end

  @doc """
  Normalize a fingerprint for comparison: the `SHA256:` prefix and any base64
  padding are both optional, so `SHA256:abc=`, `SHA256:abc`, `abc=` and `abc`
  all compare equal. A session host computes this string with its own SSH
  library, so accepting one spelling only would refuse correct hosts.
  """
  @spec normalize_fingerprint(String.t() | nil) :: String.t() | nil
  def normalize_fingerprint(nil), do: nil

  def normalize_fingerprint(value) when is_binary(value) do
    value
    |> String.trim()
    |> String.replace_prefix("SHA256:", "")
    |> String.trim_trailing("=")
  end

  @doc "True when two fingerprint spellings name the same key."
  @spec fingerprint_match?(String.t() | nil, String.t() | nil) :: boolean()
  def fingerprint_match?(a, b) do
    a = normalize_fingerprint(a)
    b = normalize_fingerprint(b)

    is_binary(a) and a != "" and a == b
  end

  # ---------------------------------------------------------------------------
  # Stored keys
  # ---------------------------------------------------------------------------

  @doc """
  Store a member's public key, or return the row that is already stored for it.

  Options:

    * `:fingerprint` (required) — the OpenSSH fingerprint of the submitted blob.
    * `:public_key` (required) — the key LINE as submitted, kept verbatim so a
      re-issue (R6) never needs the member to paste it again.
    * `:comment` — the trailing comment of the submitted line, for display and
      for the re-issued certificate's comment.

  Returns `{:error, :key_limit_reached}` when the account already holds
  `max_keys_per_account/0` DISTINCT keys. Re-submitting an already stored key
  is not a new key: it refreshes the row and issues another certificate, which
  is R6's path expressed with the key in hand.
  """
  @spec put_key(integer(), keyword()) :: {:ok, key_row()} | {:error, :key_limit_reached}
  def put_key(account_id, opts) when is_integer(account_id) do
    key_id = Keyword.fetch!(opts, :key_id)
    fingerprint = Keyword.fetch!(opts, :fingerprint)
    public_key = Keyword.fetch!(opts, :public_key)
    comment = Keyword.get(opts, :comment)
    now = DateTime.utc_now() |> DateTime.truncate(:millisecond)

    case get_key(account_id, key_id) do
      %{} = existing ->
        # Already stored: keep the ORIGINAL created_at (the member's key did not
        # change) but refresh the fingerprint spelling, so an older row written
        # before a normalization change stays comparable.
        :ok =
          write_key_row(
            account_id,
            key_id,
            fingerprint,
            existing.public_key,
            existing.comment || comment,
            existing.created_at
          )

        {:ok, get_key(account_id, key_id)}

      nil ->
        if stored_key_count(account_id) >= @max_keys_per_account do
          {:error, :key_limit_reached}
        else
          :ok = write_key_row(account_id, key_id, fingerprint, public_key, comment, now)
          {:ok, get_key(account_id, key_id)}
        end
    end
  end

  @doc "One stored key by id, or nil."
  @spec get_key(integer(), String.t()) :: key_row() | nil
  def get_key(account_id, key_id) when is_integer(account_id) and is_binary(key_id) do
    case rows(
           "SELECT account_id, key_id, fingerprint, public_key, comment, created_at FROM {{K}}.ssh_keys WHERE account_id = ? AND key_id = ?",
           [{"bigint", account_id}, {"text", key_id}]
         ) do
      [row] -> row_to_key(row)
      _ -> nil
    end
  end

  @doc "Every stored key for an account, newest first."
  @spec list_keys(integer()) :: [key_row()]
  def list_keys(account_id) when is_integer(account_id) do
    rows(
      "SELECT account_id, key_id, fingerprint, public_key, comment, created_at FROM {{K}}.ssh_keys WHERE account_id = ?",
      [{"bigint", account_id}]
    )
    |> Enum.map(&row_to_key/1)
    |> Enum.sort_by(& &1.created_at, {:desc, DateTime})
  end

  @doc """
  Remove a stored key (R5a): the key row, every certificate row it produced,
  and every by-serial row those certificates populated. Idempotent — removing
  an absent key is a no-op, and a partially failed removal is completed by
  re-running it.
  """
  @spec remove_key(integer(), String.t()) :: :ok
  def remove_key(account_id, key_id) when is_integer(account_id) and is_binary(key_id) do
    account_id
    |> certificates_for(key_id)
    |> Enum.each(fn cert ->
      :ok = delete_issuance_row(account_id, key_id, cert.serial)
      :ok = delete_by_serial(cert.serial)
    end)

    execute!(
      "DELETE FROM {{K}}.ssh_keys WHERE account_id = ? AND key_id = ?",
      [{"bigint", account_id}, {"text", key_id}]
    )

    :ok
  end

  @doc """
  Every certificate an account owns, newest serial first within each key.

  Includes superseded rows on purpose (R5 lists them with their superseded
  marker) and rows whose key was removed would be gone already — removal
  deletes them, so a stale "removed but still listed" state cannot exist.
  """
  @spec list_certificates(integer()) :: [certificate_row()]
  def list_certificates(account_id) when is_integer(account_id) do
    rows(
      "SELECT serial, key_id, principal, credential_epoch, issued_at, valid_after, valid_before, is_current FROM {{K}}.ssh_certificates WHERE account_id = ?",
      [{"bigint", account_id}]
    )
    |> Enum.reject(&ghost?/1)
    |> Enum.map(&row_to_certificate/1)
    |> Enum.sort_by(&{&1.key_id, -&1.serial})
  end

  # ---------------------------------------------------------------------------
  # Issuance
  # ---------------------------------------------------------------------------

  @doc """
  Record one issuance: the certificate row (marked current, previous rows for
  the key unmarked) and the by-serial row the bridge resolves.

  `issued` is `Cytale.SSH.Certificate.issued()` — the shape the signer already
  returns, so nothing re-derives the serial, window or principal here.

  Options:

    * `:fingerprint` (required) — the OpenSSH fingerprint of the key blob.
    * `:credential_epoch` (required) — the account's epoch AT ISSUANCE. This is
      what makes a credential reset end a live SSH session (R13a): the bridge
      compares it against the account's current epoch before every mint.
    * `:retention_ms` — override the row's TTL (tests drive it to observe the
      aged-out path, which production reaches by waiting).

  Returns `:ok`. A failed audit write is reported, never silent, by
  `Cytale.SSH.Audit.record/1` — this function only owns the rows.
  """
  @spec record_issuance(integer(), String.t(), Cytale.SSH.Certificate.issued(), keyword()) :: :ok
  def record_issuance(account_id, key_id, issued, opts)
      when is_integer(account_id) and is_binary(key_id) do
    fingerprint = Keyword.fetch!(opts, :fingerprint)
    epoch = Keyword.fetch!(opts, :credential_epoch)
    retention_ms = Keyword.get(opts, :retention_ms, @retention_ms)
    ttl_seconds = ttl_seconds(retention_ms)

    # Supersede first: the previous rows for this key stop being current. The
    # write carries the row's own remaining retention — a column written with no
    # TTL is permanent, and a permanent cell would keep a key-only GHOST row
    # alive long after every TTL'd column of that row expired.
    superseded =
      account_id
      |> certificates_for(key_id)
      |> Enum.reject(&(&1.serial == issued.serial))
      |> Enum.filter(& &1.is_current)

    Enum.each(superseded, fn cert ->
      execute!(
        "UPDATE {{K}}.ssh_certificates USING TTL ? SET is_current = ? WHERE account_id = ? AND key_id = ? AND serial = ?",
        [
          {"int", remaining_ttl_seconds(cert, retention_ms)},
          {"boolean", false},
          {"bigint", account_id},
          {"text", key_id},
          {"bigint", cert.serial}
        ]
      )
    end)

    execute!(
      "INSERT INTO {{K}}.ssh_certificates (account_id, key_id, serial, principal, credential_epoch, issued_at, valid_after, valid_before, is_current) " <>
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) USING TTL ?",
      [
        {"bigint", account_id},
        {"text", key_id},
        {"bigint", issued.serial},
        {"text", issued.principal},
        {"int", epoch},
        # issued_at IS the window's start: the signer stamps valid_after at
        # the moment it signs, so the row cannot disagree with the certificate.
        {"timestamp", to_datetime(issued.valid_after)},
        {"timestamp", to_datetime(issued.valid_after)},
        {"timestamp", to_datetime(issued.valid_before)},
        {"boolean", true},
        {"int", ttl_seconds}
      ]
    )

    execute!(
      "INSERT INTO {{K}}.ssh_certificates_by_serial (serial, account_id, key_id, fingerprint, principal, credential_epoch, valid_after, valid_before) " <>
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?) USING TTL ?",
      [
        {"bigint", issued.serial},
        {"bigint", account_id},
        {"text", key_id},
        {"text", fingerprint},
        {"text", issued.principal},
        {"int", epoch},
        {"timestamp", to_datetime(issued.valid_after)},
        {"timestamp", to_datetime(issued.valid_before)},
        {"int", ttl_seconds}
      ]
    )

    :ok
  end

  @doc """
  Resolve an asserted serial to the issuance this server recorded for it
  (R7/R8). `nil` for a serial this server never issued, or whose row has aged
  out — the bridge must refuse both rather than trusting a signature alone.
  """
  @spec get_by_serial(integer()) :: issuance_row() | nil
  def get_by_serial(serial) when is_integer(serial) do
    case rows(
           "SELECT serial, account_id, key_id, fingerprint, principal, credential_epoch, valid_after, valid_before FROM {{K}}.ssh_certificates_by_serial WHERE serial = ?",
           [{"bigint", serial}]
         ) do
      [row] -> row_to_issuance(row)
      _ -> nil
    end
  end

  # ---------------------------------------------------------------------------
  # Account-deletion cascade
  # ---------------------------------------------------------------------------

  @doc """
  Delete every certificate-surface row for an account: the included half of the
  deletion cascade. The audit rows are deliberately NOT here — the audit trail
  outlives the account and is de-identified instead
  (`Cytale.SSH.Audit.deidentify_account/1`), because it is the detection path
  for a compromise this product cannot prevent.
  """
  @spec delete_all_for_account(integer()) :: :ok
  def delete_all_for_account(account_id) when is_integer(account_id) do
    key_ids = account_id |> list_keys() |> Enum.map(& &1.key_id)

    certs =
      rows(
        "SELECT serial, key_id FROM {{K}}.ssh_certificates WHERE account_id = ?",
        [{"bigint", account_id}]
      )
      |> Enum.reject(&ghost?/1)

    Enum.each(certs, fn %{"key_id" => key_id, "serial" => serial} ->
      :ok = delete_issuance_row(account_id, key_id, serial)
      :ok = delete_by_serial(serial)
    end)

    Enum.each(key_ids, fn key_id ->
      execute!(
        "DELETE FROM {{K}}.ssh_keys WHERE account_id = ? AND key_id = ?",
        [{"bigint", account_id}, {"text", key_id}]
      )
    end)

    :ok
  end

  # ---------------------------------------------------------------------------
  # internals
  # ---------------------------------------------------------------------------

  defp certificates_for(account_id, key_id) do
    rows(
      "SELECT serial, key_id, principal, credential_epoch, issued_at, valid_after, valid_before, is_current FROM {{K}}.ssh_certificates WHERE account_id = ? AND key_id = ?",
      [{"bigint", account_id}, {"text", key_id}]
    )
    |> Enum.reject(&ghost?/1)
    |> Enum.map(&row_to_certificate/1)
  end

  # A partition read can still return a row whose TTL'd columns have expired
  # while another cell is live (a row superseded by an older write, an
  # interrupted update). Such a row is not an issuance: no serial, no principal,
  # no window — and every caller here would mishandle it (a nil serial cannot be
  # deleted by primary key or ordered). Dropped at the mapping boundary, which
  # is the one place every read passes through.
  defp ghost?(%{"serial" => nil}), do: true
  defp ghost?(%{"key_id" => nil}), do: true
  defp ghost?(_row), do: false

  defp stored_key_count(account_id) do
    rows("SELECT key_id FROM {{K}}.ssh_keys WHERE account_id = ?", [{"bigint", account_id}])
    |> length()
  end

  defp write_key_row(account_id, key_id, fingerprint, public_key, comment, created_at) do
    execute!(
      "INSERT INTO {{K}}.ssh_keys (account_id, key_id, fingerprint, public_key, comment, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      [
        {"bigint", account_id},
        {"text", key_id},
        {"text", fingerprint},
        {"text", public_key},
        {"text", comment},
        {"timestamp", created_at}
      ]
    )
  end

  defp delete_issuance_row(account_id, key_id, serial) do
    execute!(
      "DELETE FROM {{K}}.ssh_certificates WHERE account_id = ? AND key_id = ? AND serial = ?",
      [{"bigint", account_id}, {"text", key_id}, {"bigint", serial}]
    )
  end

  defp delete_by_serial(serial) do
    execute!(
      "DELETE FROM {{K}}.ssh_certificates_by_serial WHERE serial = ?",
      [{"bigint", serial}]
    )
  end

  defp row_to_key(row) do
    %{
      account_id: row["account_id"],
      key_id: row["key_id"],
      fingerprint: row["fingerprint"],
      public_key: row["public_key"],
      comment: row["comment"],
      created_at: row["created_at"]
    }
  end

  defp row_to_certificate(row) do
    %{
      serial: row["serial"],
      key_id: row["key_id"],
      principal: row["principal"],
      credential_epoch: row["credential_epoch"] || 0,
      issued_at: row["issued_at"] || row["valid_after"],
      valid_after: row["valid_after"],
      valid_before: row["valid_before"],
      is_current: row["is_current"] == true
    }
  end

  defp row_to_issuance(row) do
    %{
      serial: row["serial"],
      account_id: row["account_id"],
      key_id: row["key_id"],
      fingerprint: row["fingerprint"],
      principal: row["principal"],
      credential_epoch: row["credential_epoch"] || 0,
      valid_after: row["valid_after"],
      valid_before: row["valid_before"]
    }
  end

  defp ttl_seconds(ms) when is_integer(ms) and ms > 0, do: max(1, div(ms, 1000))
  defp ttl_seconds(_ms), do: ttl_seconds(@retention_ms)

  # How long a superseded row has left, from its own window start and the
  # retention this write uses. At least a second, so a row already past its
  # nominal life is cleaned up on the next supersede rather than kept forever.
  defp remaining_ttl_seconds(cert, retention_ms) do
    reference = cert.issued_at || cert.valid_after

    case reference do
      %DateTime{} = issued_at ->
        expires_at = DateTime.add(issued_at, div(retention_ms, 1000), :second)
        max(1, DateTime.diff(expires_at, DateTime.utc_now(), :second))

      _other ->
        ttl_seconds(retention_ms)
    end
  end

  # A certificate's window is measured in unix seconds; the row keeps a
  # DateTime so Scylla renders a real `timestamp` (a bare integer would be
  # read back as a relative-since-epoch duration, not a date).
  defp to_datetime(unix_seconds) when is_integer(unix_seconds) do
    unix_seconds |> DateTime.from_unix!() |> DateTime.truncate(:millisecond)
  end

  defp sha256(bin), do: :crypto.hash(:sha256, bin)

  defp rows(stmt, params) do
    Repo.execute!(stmt, params) |> Enum.to_list()
  end

  defp execute!(stmt, params) do
    Repo.execute!(stmt, params)
    :ok
  end
end
