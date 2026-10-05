defmodule Cytale.Accounts.WebAuthn.Credential do
  @moduledoc """
  One enrolled WebAuthn credential (ticket #36) — the owner-list row shape
  (`webauthn_credentials`; the login lookup table is a denormalized subset).

  `credential_id` is base64url (route-addressable, byte-exact after decode);
  `public_key_b64` is base64 of `:erlang.term_to_binary/1` over the wax COSE
  key map (wax's own storage recommendation). Nothing here is derived — every
  field is recorded at attestation or last use.
  """

  @enforce_keys [:user_id, :credential_id, :public_key_b64, :sign_count, :created_at]

  defstruct [
    :user_id,
    :credential_id,
    :public_key_b64,
    :sign_count,
    :backup_eligible,
    :backup_state,
    :name,
    :created_at,
    :last_used_at
  ]

  @type t :: %__MODULE__{
          user_id: integer(),
          credential_id: String.t(),
          public_key_b64: String.t(),
          sign_count: non_neg_integer(),
          backup_eligible: boolean() | nil,
          backup_state: boolean() | nil,
          name: String.t() | nil,
          created_at: DateTime.t(),
          last_used_at: DateTime.t() | nil
        }

  @doc "Build from an attestation result (the enrollment write)."
  @spec new(keyword()) :: t()
  def new(opts) do
    struct!(__MODULE__, Keyword.put_new(opts, :created_at, DateTime.utc_now()))
  end

  @doc false
  def from_row(row) when is_map(row) do
    %__MODULE__{
      user_id: row["user_id"],
      credential_id: row["credential_id"],
      public_key_b64: row["public_key"],
      sign_count: row["sign_count"] || 0,
      backup_eligible: row["backup_eligible"],
      backup_state: row["backup_state"],
      name: row["name"],
      created_at: row["created_at"],
      last_used_at: row["last_used_at"]
    }
  end
end
