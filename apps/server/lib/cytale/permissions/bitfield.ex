defmodule Cytale.Permissions.Bitfield do
  @moduledoc """
  Cytale permission bitfield (U7) — bitflag definitions and bitwise helpers.

  Bit positions are the SHARED CONTRACT with the client
  (`packages/domain/src/permissions.ts`, U16): identical names, identical
  positions. Serialized over REST and gateway events as a DECIMAL STRING
  (preserves bits above 2^53 for JS); this module works in integers.

  ADMINISTRATOR is the bypass flag: resolution short-circuits to
  `all/0` when any held role carries it (Discord semantics), but it does
  NOT bypass role hierarchy (see `Cytale.Permissions.Behaviour`).
  """

  @permissions %{
    view_channel: 1,
    send_messages: 2,
    read_message_history: 4,
    manage_channels: 8,
    manage_roles: 16,
    manage_workspace: 32,
    manage_messages: 64,
    mention_everyone: 128,
    create_invites: 256,
    kick_members: 512,
    ban_members: 1024,
    administrator: 2048,
    create_threads: 4096,
    manage_threads: 8192,
    upload_attachments: 16_384,
    add_reactions: 32_768,
    start_call: 65_536,
    # Calls V2 plan U2 (R13/VM7): 1 <<< 17 and 1 <<< 18 were free — START_CALL
    # (1 <<< 16) topped the bitfield before these landed. Bound (SEC-2): the
    # bits gate the DECLARED source kind at the op, not capture provenance —
    # enforceable against the shipped client only.
    send_video: 131_072,
    share_screen: 262_144,
    # Nicknames (#169): 1 <<< 19 and 1 <<< 20, the next free positions.
    # CHANGE_NICKNAME sets your OWN workspace nickname (in the @everyone base);
    # MANAGE_NICKNAMES sets anyone's below you in the role hierarchy.
    change_nickname: 524_288,
    manage_nicknames: 1_048_576
  }

  @names Map.keys(@permissions)
  @all Enum.reduce(Map.values(@permissions), 0, &Bitwise.bor/2)

  @typedoc "A permission name (atoms mirror the client's SCREAMING_SNAKE names)."
  @type name :: unquote(Enum.reduce(@names, &{:|, [], [&1, &2]}))

  @typedoc "A permission bitfield (integer; wire form is a decimal string)."
  @type t :: non_neg_integer()

  @doc "Bit value for a permission name (the client-contract constant)."
  @spec bit(name()) :: pos_integer()
  for {name, value} <- @permissions do
    def bit(unquote(name)), do: unquote(value)
  end

  @doc "Every defined permission name."
  @spec names() :: [name()]
  def names, do: @names

  @doc "The fully-populated bitfield (OR of every defined bit)."
  @spec all() :: t()
  def all, do: @all

  @doc "The administrator bypass flag (1 <<< 11 — client contract)."
  @spec administrator() :: t()
  def administrator, do: @permissions.administrator

  @doc "True iff `bits` contains `permission`."
  @spec has?(t(), name()) :: boolean()
  def has?(bits, permission) when is_integer(bits) and bits >= 0 do
    Bitwise.band(bits, bit(permission)) == bit(permission)
  end

  @doc """
  The permission GATE: `:ok` when `bits` carries `permission`, else a refusal.

  One tag for every surface (hardening plan 3.11). Five controllers had this as a
  private helper — two named `require_bit/2`, two `require_manage/1`, one
  `require_manage_channels/1` — and they disagreed on the refusal tag
  (`:missing_permissions` on the compat surface, `:forbidden` on the native one)
  for the same condition. The tag is now shared; each caller still renders its own
  wire error from it, which is where the surfaces legitimately differ (Discord's
  bare `{code, message}` vs the native `{error: {…}}` envelope).
  """
  @spec require_bit(t(), name()) :: :ok | {:error, :missing_permissions}
  def require_bit(bits, permission) do
    if has?(bits, permission), do: :ok, else: {:error, :missing_permissions}
  end

  @doc "Set of permission names contained in `bits`."
  @spec to_list(t()) :: [name()]
  def to_list(bits) when is_integer(bits) and bits >= 0 do
    @names |> Enum.filter(&has?(bits, &1))
  end

  @doc "Union of two bitfields (grant)."
  @spec bor(t(), t()) :: t()
  def bor(a, b), do: Bitwise.bor(a, b)

  @doc "Clear from `bits` every bit set in `mask` (deny)."
  @spec band_not(t(), t()) :: t()
  def band_not(bits, mask), do: Bitwise.band(bits, Bitwise.bnot(mask))
end
