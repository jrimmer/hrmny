defmodule Cytale.Accounts.Principals do
  @moduledoc """
  Machine-principal storage (bots-plan U1): every actor is a principal (R1),
  and machine principals (:bot | :agent | :webhook) are `users` rows plus
  provenance side tables (KTD1) —

    * `users` — null email/password_hash, NO `users_by_username`/`users_by_email`
      rows (login can never resolve a machine principal), label in
      `display_name`. Every existing users-reader (roster resolution, author
      locator, profile) keeps working unchanged.
    * `principals` — provenance: kind, parent (always a human — depth is 1),
      restrictions policy (JSON text).
    * `subs_by_parent` — per-parent sub-identity index (roster synthesis +
      cascade fan-out).
    * `bot_tokens` — credential: SHA-256 hash at rest (token_store pattern),
      plaintext returned exactly once, from `mint/4` only. `get`/`list`/
      `get_by_token` return metadata only.
    * `bot_tokens_by_principal` — the per-principal credential index
      (hardening PERF-8): one row per minted token, maintained at mint and
      revoke, so revocation never scans `bot_tokens` with ALLOW FILTERING.
      Credentials minted before the index existed are self-healed on the
      first revoke of their principal (see `revoke/1`).

  Kinds are ints in storage (`0 human, 1 bot, 2 webhook, 3 agent`) and atoms
  everywhere else; this module is the mapping boundary. Humans carry no
  `principals` row — a missing row with an existing user means `:human`.

  Restrictions semantics: `nil` (or fully-empty lists) = unrestricted.
  `actions` is a subset of `["read", "post"]` masking what the principal may
  do; `channels` is an allowlist of channel-id strings where an EMPTY list
  means ALL channels (R1: effective rights = parent's current rights ∩
  restrictions, evaluated at check time by the U3 resolver).
  """

  alias Cytale.Accounts.User
  alias Cytale.Repo

  @typedoc "Principal kinds (R1). :human is the users root, never minted here."
  @type kind :: :human | :bot | :agent | :webhook

  @typedoc "A machine principal as returned by get/list — no token material."
  @type t :: %{
          user_id: integer(),
          kind: kind(),
          parent_user_id: integer(),
          label: String.t() | nil,
          restrictions: map() | nil,
          created_at: DateTime.t()
        }

  @typedoc "The mint result: the principal map plus the one-time plaintext token."
  @type minted :: t() | %{token: String.t()}

  @kind_codes %{human: 0, bot: 1, webhook: 2, agent: 3}
  @code_kinds Map.new(@kind_codes, fn {k, c} -> {c, k} end)
  @machine_kinds ~w(bot webhook agent)a
  @valid_actions ~w(read post)
  @channel_id_re ~r/^\d{1,20}$/
  @token_prefix "cytbot_"

  # B6g: a parent's sub-identity budget (all machine kinds combined) —
  # bounds credential sprawl and the roster-synthesis fan-out per human.
  @principal_cap 50

  # ---------------------------------------------------------------------------
  # Mint
  # ---------------------------------------------------------------------------

  @doc """
  Mint a machine principal under `parent_user_id` (which must be an existing,
  non-deleted human user — depth is 1, and only :human principals may mint
  sub-identities). Writes the `users` row (label in display_name, no login
  identifiers), the provenance rows, and one `cytbot_` credential whose
  SHA-256 hash is stored — the plaintext token is returned here, exactly
  once.

  `restrictions` is nil or a map with `:actions` (subset of `["read",
  "post"]`) and/or `:channels` (channel-id strings; empty = all channels).

  Returns `{:ok, principal_and_token}` or `{:error, reason}` with reason ∈
  `:invalid_kind | :invalid_label | :invalid_restrictions | :unknown_parent |
  :invalid_parent | :principal_cap` (B6g: a parent holds at most
  `principal_cap/0` machine principals across all kinds).
  """
  @spec mint(integer(), kind(), String.t(), map() | nil) ::
          {:ok, minted()} | {:error, atom()}
  def mint(parent_user_id, kind, label, restrictions \\ nil)

  def mint(parent_user_id, kind, label, restrictions) when is_binary(label) do
    mint(parent_user_id, kind, label, restrictions, nil)
  end

  def mint(_parent_user_id, _kind, _label, _restrictions), do: {:error, :invalid_label}

  @doc """
  Mint with an explicit `username` — the credential's TAG, unique per server.

  A machine credential is a USER for every purpose (one permission system, one
  identity system), so it carries a username like any account: 2–32 chars of
  `[a-zA-Z0-9_.-]`, unique case-insensitively against every other user. `nil`
  derives one from the label (slugified, suffixed while taken); an explicit
  value is honored or refused, never silently altered.
  """
  @spec mint(integer(), atom(), String.t(), term(), String.t() | nil) ::
          {:ok, map()} | {:error, term()}
  def mint(parent_user_id, kind, label, restrictions, username) when is_binary(label) do
    with :ok <- validate_kind(kind),
         :ok <- validate_label(label),
         {:ok, canonical} <- validate_restrictions(restrictions),
         :ok <- ensure_valid_parent(parent_user_id),
         :ok <- ensure_under_parent_cap(parent_user_id),
         label = String.trim(label),
         {:ok, username} <- resolve_username(kind, username, label) do
      user_id = Cytale.Snowflake.next()
      now = DateTime.utc_now() |> DateTime.truncate(:millisecond)
      kind_code = @kind_codes[kind]

      insert_principal_user(user_id, username, label, now)

      # One identity space: the tag is reserved against every human handle.
      # Webhooks have no tag, so nothing to reserve.
      if username, do: User.reserve_username!(user_id, username)
      insert_principal_row(user_id, kind_code, parent_user_id, canonical, now)

      Repo.execute!(
        "INSERT INTO {{K}}.subs_by_parent (parent_user_id, principal_id, kind) VALUES (?, ?, ?)",
        [{"bigint", parent_user_id}, {"bigint", user_id}, {"int", kind_code}]
      )

      token = mint_credential(user_id, now)

      {:ok,
       %{
         user_id: user_id,
         kind: kind,
         parent_user_id: parent_user_id,
         label: label,
         username: username,
         restrictions: canonical,
         # A fresh principal holds NO access (agent model, R6): the mint return
         # value mirrors the row, so callers see the same document the resolver
         # will read — the all-none default until someone grants.
         access: Cytale.Access.default(),
         created_at: now,
         token: token
       }}
    else
      {:error, _} = err -> err
    end
  end

  # ---------------------------------------------------------------------------
  # Reads
  # ---------------------------------------------------------------------------

  @doc """
  Which of the given ids currently have a principal row (liveness check —
  one batched read; used by the interactions liveness filter). Returns the
  subset of ids that exist.
  """
  @spec exists_many?([integer()]) :: [integer()]
  def exists_many?(ids) when is_list(ids) do
    ids = ids |> Enum.uniq() |> Enum.reject(&(&1 <= 0))

    if ids == [] do
      []
    else
      Repo.execute!(
        "SELECT user_id FROM {{K}}.principals WHERE user_id IN ?",
        [{"list<bigint>", ids}]
      )
      |> Enum.to_list()
      |> Enum.map(& &1["user_id"])
    end
  end

  @doc """
  Fetch a machine principal by user id (metadata only — never token
  material). nil for humans and unknown ids.
  """
  @spec get(integer()) :: t() | nil
  def get(user_id) when is_integer(user_id) do
    rows =
      Repo.execute!(
        "SELECT user_id, kind, parent_user_id, restrictions, access, created_at FROM {{K}}.principals WHERE user_id = ?",
        [{"bigint", user_id}]
      )
      |> Enum.to_list()

    case rows do
      [row] -> row_to_principal(row)
      [] -> nil
    end
  end

  @doc """
  Batched `get/1`: `%{user_id => principal}` for the ids that ARE machine
  principals (humans and unknown ids are simply absent). One `principals IN ?`
  read plus one `users IN ?` for the labels.
  """
  @spec get_many([integer()]) :: %{optional(integer()) => t()}
  def get_many([]), do: %{}
  def get_many(user_ids) when is_list(user_ids), do: user_ids |> Enum.uniq() |> principals_by_id()

  @doc """
  The PRINCIPAL KIND of a user id across both tables (B-1's DM kind guard):
  `:bot`/`:agent`/`:webhook` for machine principals, `:human` for user rows,
  nil for unknown ids. ONE definition — the DM open/authorization paths and
  any future kind-gated surface consume this, never ad-hoc
  Principals.get-then-User.get chains.
  """
  @spec kind_of(integer()) :: :bot | :agent | :webhook | :human | nil
  def kind_of(user_id) when is_integer(user_id) do
    case get(user_id) do
      %{kind: kind} when kind in @machine_kinds -> kind
      _ -> if Cytale.Accounts.User.get(user_id), do: :human, else: nil
    end
  end

  @doc """
  Resolve a plaintext `cytbot_` token to its principal (metadata only) — the
  authenticate-path read of `bot_tokens` (U2). nil for unknown, malformed, or
  revoked tokens.
  """
  @spec get_by_token(String.t()) :: t() | nil
  def get_by_token(token) when is_binary(token) and token != "" do
    rows =
      Repo.execute!(
        "SELECT principal_id FROM {{K}}.bot_tokens WHERE token_hash = ?",
        [{"text", hash_token(token)}]
      )
      |> Enum.to_list()

    case rows do
      [%{"principal_id" => principal_id}] -> get(principal_id)
      [] -> nil
    end
  end

  def get_by_token(_), do: nil

  @doc """
  A parent's machine principals, principal_id ascending (roster synthesis).
  Batched: one index read plus one `IN` query over `principals` and one over
  `users` (labels), preserving the index's id order.
  """
  @spec list_by_parent(integer()) :: [t()]
  def list_by_parent(parent_user_id) when is_integer(parent_user_id) do
    ids =
      Repo.execute!(
        "SELECT principal_id FROM {{K}}.subs_by_parent WHERE parent_user_id = ?",
        [{"bigint", parent_user_id}]
      )
      |> Enum.to_list()
      |> Enum.map(& &1["principal_id"])

    if ids == [] do
      []
    else
      by_id = principals_by_id(ids)
      ids |> Enum.map(&Map.get(by_id, &1)) |> Enum.reject(&is_nil/1)
    end
  end

  @doc """
  Page-level batch of `list_by_parent/1` (PERF-5, B5 — roster synthesis):
  ONE `subs_by_parent IN ?` index read over the page's parent ids (an IN
  over partition keys), ONE `principals IN ?`, ONE `users IN ?` for labels.
  Returns `%{parent_user_id => [t()]}` with each parent's list
  principal_id ascending — the identical per-parent result
  `list_by_parent/1` yields, minus the per-parent query cost.
  """
  @spec list_by_parents([integer()]) :: %{optional(integer()) => [t()]}
  def list_by_parents(parent_ids) when is_list(parent_ids) do
    parent_ids = Enum.uniq(parent_ids)

    if parent_ids == [] do
      %{}
    else
      ids_by_parent =
        Repo.execute!(
          "SELECT parent_user_id, principal_id FROM {{K}}.subs_by_parent WHERE parent_user_id IN ?",
          [{"list<bigint>", parent_ids}]
        )
        |> Enum.to_list()
        |> Enum.group_by(& &1["parent_user_id"], & &1["principal_id"])
        |> Map.new(fn {parent, ids} -> {parent, Enum.sort(ids)} end)

      all_ids = ids_by_parent |> Map.values() |> List.flatten()

      if all_ids == [] do
        %{}
      else
        by_id = principals_by_id(all_ids)

        Map.new(ids_by_parent, fn {parent, ids} ->
          {parent, ids |> Enum.map(&Map.get(by_id, &1)) |> Enum.reject(&is_nil/1)}
        end)
      end
    end
  end

  @doc """
  Display name of a principal: its label, falling back to the kind name (the
  shared fallback behind machine claims, the gateway identity's username, and
  the compat author object).
  """
  @spec display_name(t()) :: String.t()
  def display_name(principal), do: principal.label || Atom.to_string(principal.kind)

  @doc """
  The handle a reader sees for a machine principal: its TAG (the users-row
  username, unique per server), falling back to the label for rows minted
  before tags existed — and a webhook has no tag (it is a capability URL, not
  an identity), so it falls back too.

  One handle everywhere: the roster, the REST row and the gateway identity all
  read through this, so a credential cannot be "@mia" in one surface and
  "Max" in another.
  """
  @spec machine_handle(t()) :: String.t()
  def machine_handle(principal) do
    case User.get(principal.user_id) do
      %{username: username} when is_binary(username) -> username
      _ -> display_name(principal)
    end
  end

  @doc """
  The REST machine-claims map for a principal (R2 — ONE claims shape across
  surfaces): `%{user_id, username: display_name, verified: true, kind,
  parent_user_id, restrictions}`. `verified: true` because machine principals
  have no email to verify.
  """
  @spec claims(t()) :: map()
  def claims(principal) do
    %{
      user_id: principal.user_id,
      username: machine_handle(principal),
      verified: true,
      kind: principal.kind,
      parent_user_id: principal.parent_user_id,
      # LEGACY: retained for readers that still display it; the RESOLVER no
      # longer consults it for machine principals (the access document below is
      # what decides their bits).
      restrictions: principal.restrictions,
      # The agent access document — what the resolver actually reads for a
      # machine principal. Fail-closed by construction: `Access.effective/1`
      # already turned a missing/corrupt column into the all-none document.
      access: principal.access
    }
  end

  # ---------------------------------------------------------------------------
  # Revocation
  # ---------------------------------------------------------------------------

  @doc """
  Revoke a principal's credentials: delete every `bot_tokens` row for it.
  Provenance (principals/subs_by_parent/users rows) survives — only the
  credential dies, so attribution and rosters stay intact. Idempotent:
  revoking an already-revoked (or unknown) principal is a no-op `:ok`.

  The credential set resolves through `bot_tokens_by_principal` (hardening
  PERF-8) — a partition read, no ALLOW FILTERING. SELF-HEALING BACKFILL: a
  credential minted before the index table existed has `bot_tokens` rows but
  no index rows (there is no data-migration framework to backfill them), so
  an EMPTY index partition falls back to the old page-complete
  `principal_id = ? ALLOW FILTERING` scan ONCE, populates the index with
  what it finds, and proceeds. After that first revoke the principal's index
  partition is authoritative — mint and revoke maintain it from then on. A
  principal whose index is empty because it truly holds no credentials pays
  one bounded scan per revoke; revoke is a rare admin action, not a
  read-pattern hop.

  The deletes run as ONE unlogged batch (a fan of token-row + index-row
  deletes): a round-trip win, not atomicity — `Repo.batch!/2`'s contract.

  Interaction tokens (bots plan U8) are DERIVATIVE credentials of the
  principal — `Cytale.Interactions.TokenStore.revoke_principal/1` purges
  them here, so a bot revoked between invocation and callback answers 401
  (never posts through a dead credential).
  """
  @spec revoke(integer()) :: :ok
  def revoke(principal_id) when is_integer(principal_id) do
    hashes = indexed_hashes(principal_id)

    hashes =
      if hashes == [] do
        # Legacy backfill (see the doc): the index partition is empty, so it
        # cannot prove the principal has no credential — ask the credential
        # table itself, once, and make the index authoritative for next time.
        legacy = scanned_hashes(principal_id)

        unless legacy == [] do
          Repo.batch!(Enum.map(legacy, &index_row_insert(principal_id, &1)))
        end

        legacy
      else
        hashes
      end

    unless hashes == [] do
      Repo.batch!(
        Enum.flat_map(hashes, fn token_hash ->
          [
            credential_delete(token_hash),
            index_row_delete(principal_id, token_hash)
          ]
        end)
      )
    end

    # Derivative credentials die with the primary (U8).
    Cytale.Interactions.TokenStore.revoke_principal(principal_id)

    :ok
  end

  # The index partition read (the fast path — no filtering).
  defp indexed_hashes(principal_id) do
    "SELECT token_hash FROM {{K}}.bot_tokens_by_principal WHERE principal_id = ?"
    |> Repo.execute!([{"bigint", principal_id}])
    |> Enum.map(& &1["token_hash"])
  end

  # The legacy scan. Reads through EVERY page (`Repo.stream_rows!`): a single
  # execute returns only the first 10k-row Xandra page, and once the table
  # grew past one page the truncated scan silently LEFT REVOKED TOKENS VALID
  # (observed as a flaky "revoked credential still 200s").
  defp scanned_hashes(principal_id) do
    "SELECT token_hash FROM {{K}}.bot_tokens WHERE principal_id = ? ALLOW FILTERING"
    |> Repo.stream_rows!([{"bigint", principal_id}])
    |> Enum.map(& &1["token_hash"])
  end

  defp credential_delete(token_hash) do
    {"DELETE FROM {{K}}.bot_tokens WHERE token_hash = ?", [{"text", token_hash}]}
  end

  defp index_row_insert(principal_id, token_hash) do
    {"INSERT INTO {{K}}.bot_tokens_by_principal (principal_id, token_hash) VALUES (?, ?)",
     [{"bigint", principal_id}, {"text", token_hash}]}
  end

  defp index_row_delete(principal_id, token_hash) do
    {"DELETE FROM {{K}}.bot_tokens_by_principal WHERE principal_id = ? AND token_hash = ?",
     [{"bigint", principal_id}, {"text", token_hash}]}
  end

  @doc """
  DELETE semantics for a machine principal: revoke its credential, remove
  its principal + subs_by_parent rows (it vanishes from rosters and from
  command liveness — dead applications' commands are hidden and
  uninvokable), and KEEP its users row so historical message attribution
  still resolves. Idempotent on an already-deleted principal.
  """
  @spec delete_machine_principal!(integer()) :: :ok
  def delete_machine_principal!(principal_id) when is_integer(principal_id) do
    parent_user_id =
      case get(principal_id) do
        %{parent_user_id: parent} -> parent
        nil -> nil
      end

    :ok = revoke(principal_id)

    # The TAG returns to the pool: mint → revoke → re-mint with the same tag
    # is the normal credential loop, so revocation releases its reservation.
    # The users row itself stays for attribution (it keeps username, but no
    # lookup row — only the reservation, not the history, is freed).
    case User.get(principal_id) do
      %{username: username} when is_binary(username) -> User.release_username!(username)
      _ -> :ok
    end

    Repo.execute!(
      "DELETE FROM {{K}}.principals WHERE user_id = ?",
      [{"bigint", principal_id}]
    )

    if parent_user_id do
      Repo.execute!(
        "DELETE FROM {{K}}.subs_by_parent WHERE parent_user_id = ? AND principal_id = ?",
        [{"bigint", parent_user_id}, {"bigint", principal_id}]
      )
    end

    :ok
  end

  # ---------------------------------------------------------------------------
  # Restrictions parse/validate
  # ---------------------------------------------------------------------------

  @doc """
  Overwrite a principal's stored restrictions policy (canonical map or nil =
  unrestricted) — the ONE write beside the read path (`get/1` parses the
  JSON text back). Formerly the bot controller's direct table UPDATE (B6b).
  """
  @spec update_restrictions(integer(), map() | nil) :: :ok
  def update_restrictions(principal_id, nil) when is_integer(principal_id) do
    Repo.execute!(
      "UPDATE {{K}}.principals SET restrictions = NULL WHERE user_id = ?",
      [{"bigint", principal_id}]
    )

    :ok
  end

  def update_restrictions(principal_id, canonical) when is_integer(principal_id) and is_map(canonical) do
    Repo.execute!(
      "UPDATE {{K}}.principals SET restrictions = ? WHERE user_id = ?",
      [{"text", Jason.encode!(canonical)}, {"bigint", principal_id}]
    )

    :ok
  end

  @doc """
  Validate a restrictions input: nil, or a map whose keys are a subset of
  `:actions`/`:channels` (string keys accepted). `:actions` items must be in
  `["read", "post"]`; `:channels` items must be decimal id strings. Empty
  lists and the empty map normalize to nil (unrestricted). Returns
  `{:ok, canonical_map | nil}` or `{:error, :invalid_restrictions}`.
  """
  @spec validate_restrictions(term()) :: {:ok, map() | nil} | {:error, :invalid_restrictions}
  def validate_restrictions(nil), do: {:ok, nil}

  def validate_restrictions(restrictions) when is_map(restrictions) do
    actions = map_value(restrictions, :actions)
    channels = map_value(restrictions, :channels)

    with :ok <- validate_actions(actions),
         :ok <- validate_channels(channels),
         :ok <- reject_unknown_keys(restrictions) do
      canonical =
        %{}
        |> maybe_put("actions", actions)
        |> maybe_put("channels", channels)

      {:ok, canonicalize(canonical)}
    else
      {:error, _} = err -> err
    end
  end

  def validate_restrictions(_), do: {:error, :invalid_restrictions}

  @doc """
  Parse a stored restrictions JSON text back to its map (nil for nil/blank/
  corrupt rows). Written values were validated at mint, so this is a decode.
  """
  @spec parse_restrictions(String.t() | nil) :: map() | nil
  def parse_restrictions(nil), do: nil

  def parse_restrictions(text) when is_binary(text) do
    case Jason.decode(text) do
      {:ok, map} when is_map(map) -> canonicalize(map)
      _ -> nil
    end
  end

  @doc """
  Replace a principal's agent access document (the whole tree, one write — the
  grant UI has one save path). The document is validated BEFORE it is stored, so
  a malformed payload cannot become a row that reads as no-access by accident;
  `nil` clears it back to no access.
  """
  @spec update_access(integer(), map() | nil) :: :ok | {:error, term()}
  def update_access(principal_id, nil) when is_integer(principal_id) do
    Repo.execute!(
      "UPDATE {{K}}.principals SET access = null WHERE user_id = ?",
      [{"bigint", principal_id}]
    )

    :ok
  end

  def update_access(principal_id, %{} = document) when is_integer(principal_id) do
    case Cytale.Access.parse(document) do
      {:ok, parsed} ->
        Repo.execute!(
          "UPDATE {{K}}.principals SET access = ? WHERE user_id = ?",
          [{"text", Cytale.Access.encode(parsed)}, {"bigint", principal_id}]
        )

        :ok

      {:error, reason} ->
        {:error, reason}
    end
  end

  # ---------------------------------------------------------------------------
  # Internals
  # ---------------------------------------------------------------------------

  defp validate_kind(kind) when kind in @machine_kinds, do: :ok
  defp validate_kind(_), do: {:error, :invalid_kind}

  @doc """
  Per-parent machine-principal cap (B6g, all kinds combined — default 50).
  """
  @spec principal_cap :: pos_integer()
  def principal_cap, do: @principal_cap

  defp ensure_under_parent_cap(parent_user_id) do
    count =
      Repo.execute!(
        "SELECT principal_id FROM {{K}}.subs_by_parent WHERE parent_user_id = ?",
        [{"bigint", parent_user_id}]
      )
      |> Enum.count()

    if count >= @principal_cap, do: {:error, :principal_cap}, else: :ok
  end

  @doc """
  Validate a label (name): trimmed length 1–100. Public since U9's
  bot/agent PATCH delegates here — the mint and rename surfaces share the
  ONE rule (no forked validation).
  """
  @spec validate_label(String.t()) :: :ok | {:error, :invalid_label}
  def validate_label(label) do
    trimmed = String.trim(label)

    if String.length(trimmed) >= 1 and String.length(trimmed) <= 100,
      do: :ok,
      else: {:error, :invalid_label}
  end

  defp validate_actions(nil), do: :ok

  defp validate_actions(actions) when is_list(actions) do
    if Enum.all?(actions, &(&1 in @valid_actions)),
      do: :ok,
      else: {:error, :invalid_restrictions}
  end

  defp validate_actions(_), do: {:error, :invalid_restrictions}

  defp validate_channels(nil), do: :ok

  defp validate_channels(channels) when is_list(channels) do
    if Enum.all?(channels, &(is_binary(&1) and Regex.match?(@channel_id_re, &1))),
      do: :ok,
      else: {:error, :invalid_restrictions}
  end

  defp validate_channels(_), do: {:error, :invalid_restrictions}

  defp reject_unknown_keys(restrictions) do
    known = ~w(actions channels)

    if Enum.all?(Map.keys(restrictions), fn
         k when is_atom(k) -> Atom.to_string(k) in known
         k when is_binary(k) -> k in known
         _ -> false
       end),
       do: :ok,
       else: {:error, :invalid_restrictions}
  end

  defp map_value(restrictions, key) do
    case Map.fetch(restrictions, key) do
      {:ok, value} -> value
      :error -> Map.get(restrictions, Atom.to_string(key))
    end
  end

  defp maybe_put(map, _key, nil), do: map
  defp maybe_put(map, _key, []), do: map
  defp maybe_put(map, key, value), do: Map.put(map, key, value)

  # Empty means unrestricted on every axis (nil policy).
  defp canonicalize(map) when map_size(map) == 0, do: nil

  defp canonicalize(map) do
    map
    |> maybe_put("actions", list_of(map, "actions") |> Enum.uniq())
    |> maybe_put("channels", list_of(map, "channels") |> Enum.uniq())
    |> case do
      m when map_size(m) == 0 -> nil
      m -> m
    end
  end

  defp list_of(map, key), do: Map.get(map, key) || []

  defp ensure_valid_parent(parent_user_id) do
    case User.get(parent_user_id) do
      nil ->
        {:error, :unknown_parent}

      %{deleted_at: nil} = parent ->
        if get(parent.user_id),
          do: {:error, :invalid_parent},
          else: :ok

      %{deleted_at: %DateTime{}} ->
        {:error, :invalid_parent}
    end
  end

  # The users row for a machine principal: null username/email/password_hash
  # and, critically, NO users_by_username/users_by_email rows — login can
  # never resolve it (KTD1).
  # The tag: bots carry one (a credential is a user), webhooks do NOT — a
  # webhook is a channel-scoped capability URL, not an identity, and its name
  # may repeat freely across channels. An explicit bot tag is validated and
  # refused on collision; an absent one is DERIVED and refused if taken —
  # NEVER silently suffixed (owner rule 2026-09-13: a mint must not rename
  # your credential without permission; the caller picks a different name or
  # sets a tag).
  defp resolve_username(:webhook, _username, _label), do: {:ok, nil}

  defp resolve_username(_kind, nil, label), do: derive_username(label)

  defp resolve_username(_kind, username, _label) when is_binary(username) do
    trimmed = String.trim(username)

    cond do
      trimmed == "" -> {:error, :invalid_username}
      User.username_taken?(trimmed) -> {:error, :username_taken}
      not valid_username?(trimmed) -> {:error, :invalid_username}
      true -> {:ok, trimmed}
    end
  end

  defp resolve_username(_kind, _other, _label), do: {:error, :invalid_username}

  defp derive_username(label) do
    base = slugify(label)

    cond do
      not valid_username?(base) -> {:error, :invalid_username}
      User.username_taken?(base) -> {:error, :username_taken}
      true -> {:ok, base}
    end
  end

  # "Helper - Mia" → "helper-mia": the same shape a human would have picked,
  # and short enough for the 32-char limit after a collision suffix.
  defp slugify(label) do
    slug =
      label
      |> String.downcase()
      |> String.replace(~r/[^a-z0-9_.-]+/, "-")
      |> String.replace(~r/-{2,}/, "-")
      |> String.trim("-")
      |> String.slice(0, 28)

    if String.length(slug) >= 2, do: slug, else: "bot-#{slug}" |> String.trim("-")
  end

  # The SAME rule registration enforces (User.validate_username/1): one
  # identity rule for humans and machine credentials alike. `@` is refused
  # because it would forge a mention.
  defp valid_username?(u) do
    String.length(u) >= 2 and String.length(u) <= 32 and
      String.match?(u, ~r/^[a-zA-Z0-9_.-]+$/) and not String.contains?(u, "@")
  end

  defp insert_principal_user(user_id, username, label, now) do
    Repo.execute!(
      "INSERT INTO {{K}}.users (user_id, username, email, email_verified_at, password_hash, display_name, avatar_url, created_at, deleted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [
        {"bigint", user_id},
        {"text", username},
        {"text", nil},
        {"timestamp", nil},
        {"text", nil},
        {"text", label},
        {"text", nil},
        {"timestamp", now},
        {"timestamp", nil}
      ]
    )

    :ok
  end

  defp insert_principal_row(user_id, kind_code, parent_user_id, restrictions, now) do
    Repo.execute!(
      "INSERT INTO {{K}}.principals (user_id, kind, parent_user_id, restrictions, created_at) VALUES (?, ?, ?, ?, ?)",
      [
        {"bigint", user_id},
        {"int", kind_code},
        {"bigint", parent_user_id},
        {"text", encode_restrictions(restrictions)},
        {"timestamp", now}
      ]
    )

    :ok
  end

  # `cytbot_<url-safe random>`: secret-scanner-friendly prefix, 32 bytes of
  # strong randomness (43+ base64url chars). Only the SHA-256 hex lands in
  # bot_tokens; the plaintext is returned to the mint caller exactly once.
  # Public since U9's regenerate path delegates here — tokens escape only
  # through mint and rotation, and both call sites now share this ONE
  # function (the invariant's single choke point).
  @doc """
  Mint a fresh `cytbot_` credential for `principal_id`, stamped `now`.
  The plaintext is returned exactly once; only its SHA-256 hex is stored.

  Writes the credential row AND its `bot_tokens_by_principal` index row
  (hardening PERF-8) as ONE unlogged batch, so a minted credential is
  revocable through the index from birth and the two rows can never drift
  by an ordering accident.
  """
  @spec mint_credential(integer(), DateTime.t()) :: String.t()
  def mint_credential(principal_id, now) do
    token = @token_prefix <> Base.url_encode64(:crypto.strong_rand_bytes(32), padding: false)
    token_hash = hash_token(token)

    Repo.batch!([
      {"INSERT INTO {{K}}.bot_tokens (token_hash, principal_id, created_at) VALUES (?, ?, ?)",
       [{"text", token_hash}, {"bigint", principal_id}, {"timestamp", now}]},
      {"INSERT INTO {{K}}.bot_tokens_by_principal (principal_id, token_hash) VALUES (?, ?)",
       [{"bigint", principal_id}, {"text", token_hash}]}
    ])

    token
  end

  defp hash_token(token), do: Base.encode16(:crypto.hash(:sha256, token), case: :lower)

  defp encode_restrictions(nil), do: nil
  defp encode_restrictions(map), do: Jason.encode!(map)

  defp row_to_principal(row), do: row_to_principal(row, label_for(row["user_id"]))

  defp row_to_principal(row, label) do
    %{
      user_id: row["user_id"],
      kind: @code_kinds[row["kind"]] || :unknown,
      parent_user_id: row["parent_user_id"],
      label: label,
      restrictions: parse_restrictions(row["restrictions"]),
      # The agent access document (plan U1): `effective/1` never widens — an
      # absent/corrupt column is the all-none document, not the legacy policy.
      access: Cytale.Access.effective(row["access"]),
      created_at: row["created_at"]
    }
  end

  # Batch reads behind list_by_parent: one `IN` query over principals and one
  # over users (labels) — the messages.ex embed-join precedent. Ids absent
  # from a result map simply resolve to nil (row gone), matching the
  # point-read behavior.
  defp principals_by_id(ids) do
    rows =
      Repo.execute!(
        "SELECT user_id, kind, parent_user_id, restrictions, access, created_at FROM {{K}}.principals WHERE user_id IN ?",
        [{"list<bigint>", ids}]
      )
      |> Enum.to_list()

    labels = labels_by_user(ids)

    Map.new(rows, fn row ->
      {row["user_id"], row_to_principal(row, Map.get(labels, row["user_id"]))}
    end)
  end

  defp labels_by_user(ids) do
    Repo.execute!(
      "SELECT user_id, display_name FROM {{K}}.users WHERE user_id IN ?",
      [{"list<bigint>", ids}]
    )
    |> Enum.to_list()
    |> Map.new(fn row -> {row["user_id"], row["display_name"]} end)
  end

  defp label_for(user_id) do
    rows =
      Repo.execute!(
        "SELECT display_name FROM {{K}}.users WHERE user_id = ?",
        [{"bigint", user_id}]
      )
      |> Enum.to_list()

    case rows do
      [%{"display_name" => label}] -> label
      [] -> nil
    end
  end
end
