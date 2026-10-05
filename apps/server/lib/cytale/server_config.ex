defmodule Cytale.ServerConfig do
  @moduledoc """
  The ONE owner of the server's configuration load order (#121):

      boot-scoped key:  config.json > env > code default
      runtime-scoped:   the same, hot-re-applied on save

  Three layers, exactly:

    * `config.json` — the EDITABLE, non-secret runtime document (0640),
      served to the Server Settings editor and written back through
      `save/1` (validate → atomic write → keep `config.last-good.json`);
    * `secrets.json` — 0600, boot-read with PRECEDENCE OVER ENV, written
      only by first-boot migration (here) and by restore-mode (a later
      ticket, through `write_secrets/1`); NEVER GET-served, never
      editor-editable;
    * env — bootstrap (port, `SECRET_KEY_BASE`, `CYTALE_SCYLLA_NODES`) and
      the MIGRATION SOURCE: the first boot with no file generates one from
      the current env-derived values + schema defaults and logs that it did.

  Reads go through THIS module (`secret/1`, `backup_*` accessors) or keep
  flowing through the existing `Cytale.Config` accessors: migrated keys are
  written into their application-env storage locations at boot and on every
  runtime save (`Application.put_env`), so existing readers see file values
  without any call-site change. `Cytale.Config` is NOT ripped out — this
  module is its backing for the migrated keys.

  The boot (`boot!/0`, called first in `Cytale.Application.start/2`, BEFORE
  any child can read a migrated key) NEVER fails the node: a corrupt
  config.json falls back to `config.last-good.json`; with no last-good it
  regenerates from env; every fallback logs loudly. A boot can be slowed by
  this file, never wedged by it.
  """

  require Logger

  alias Cytale.ServerConfig.Schema

  defmodule OmitKey do
    @moduledoc false
    defexception message: "this key must be omitted from the generated document"
  end

  @config_mode 0o640
  @secrets_mode 0o600

  # -- Boot -----------------------------------------------------------------------

  @doc """
  The boot load. Runs FIRST in `Cytale.Application.start/2` and never raises:
  every failure path falls back and logs loudly instead. Steps:

    1. secrets.json — corrupt → loud log, env stays authoritative; valid →
       precedence over env (file values are written into the app-env homes
       the existing readers use, e.g. `Cytale.Config.ssh_ca_key_path/0`);
    2. no config.json → GENERATE from env-derived values + schema defaults
       (dev/prod; the hermetic test suite opts out) and log;
    3. config.json valid → file wins over env for every key it names;
    4. config.json corrupt → `config.last-good.json`; no last-good →
       regenerate from env. Both loud.
  """
  @spec boot!() :: :ok
  def boot! do
    boot_secrets()
    boot_config()
    :ok
  rescue
    e ->
      Logger.critical(
        "server config: boot load crashed (#{Exception.format(:error, e)}) — " <>
          "continuing on env/config defaults; the node must never loop-crash on a config file"
      )

      :ok
  catch
    _kind, reason ->
      Logger.critical("server config: boot load exited (#{inspect(reason)}) — continuing on env/config defaults")
      :ok
  end

  defp boot_secrets do
    path = secrets_path()

    if File.exists?(path) do
      case read_json(path) do
        {:ok, map} ->
          case Schema.validate_secrets(map) do
            :ok ->
              apply_secrets(map)

              Logger.info(
                "server config: secrets loaded from #{path} (#{map_size(map)} key(s), env overridden where present)"
              )

            {:error, errors} ->
              Logger.error(
                "server config: secrets file #{path} INVALID (#{format_errors(errors)}) — " <>
                  "IGNORING it; env stays authoritative. Fix or remove the file."
              )
          end

        {:error, reason} ->
          Logger.error(
            "server config: secrets file #{path} UNREADABLE (#{inspect(reason)}) — " <>
              "IGNORING it; env stays authoritative."
          )
      end
    else
      maybe_generate_secrets(path)
    end
  end

  defp maybe_generate_secrets(path) do
    if generate_on_boot?() do
      map =
        Schema.secret_keys()
        |> Enum.reduce(%{}, fn entry, acc ->
          case env_value(entry.env) do
            nil -> acc
            value -> Map.put(acc, entry.key, value)
          end
        end)

      case write_atomic(path, Jason.encode!(map, pretty: true), @secrets_mode) do
        :ok ->
          apply_secrets(map)

          Logger.warning(
            "server config: FIRST BOOT — generated secrets file at #{path} from current env " <>
              "(#{map_size(map)} key(s), 0600). The file now has precedence over env for its keys."
          )

        {:error, reason} ->
          Logger.error("server config: could not write generated secrets file #{path} (#{inspect(reason)})")
      end
    end
  end

  defp boot_config do
    path = config_path()

    cond do
      not File.exists?(path) ->
        maybe_generate_config(path)

      true ->
        case load_document(path) do
          {:ok, doc, flattened} ->
            apply_document(flattened)
            copy_to_last_good(path)
            Logger.info("server config: loaded #{path} (#{map_size(Schema.flatten(doc))} key(s)) — file overrides env")

          {:error, reason} ->
            boot_fallback(path, reason)
        end
    end
  end

  defp maybe_generate_config(path) do
    if generate_on_boot?() do
      case generate_document() |> write_document(path) do
        {:ok, flattened} ->
          # The generated values are the effective ones, so applying is a
          # no-op for keys with env homes — but keys with NO env (the backup
          # block) only exist here, and accessors read the app env.
          apply_document(flattened)
          copy_to_last_good(path)

          Logger.warning(
            "server config: FIRST BOOT — no config file, generated one at #{path} from current " <>
              "env + defaults (#{map_size(flattened)} key(s)). Edit it via the Server Settings " <>
              "surface or directly; the file now wins over env for every key it names."
          )

        error ->
          Logger.error("server config: first-boot generation FAILED (#{inspect(error)}) — env stays authoritative")
      end
    end
  end

  # Corrupt/invalid file: last-good boots; no last-good → regenerate from env.
  defp boot_fallback(path, reason) do
    last_good = last_good_path()

    if File.exists?(last_good) do
      case load_document(last_good) do
        {:ok, _doc, flattened} ->
          apply_document(flattened)

          Logger.error(
            "server config: #{path} FAILED TO LOAD (#{format_reason(reason)}) — booted from " <>
              "#{last_good} instead. Fix or remove the bad file; this node must never " <>
              "loop-crash on a config file."
          )

        {:error, lg_reason} ->
          regenerate_after_corruption(path, "last-good #{last_good} also unusable (#{format_reason(lg_reason)})")
      end
    else
      regenerate_after_corruption(path, format_reason(reason))
    end
  end

  defp regenerate_after_corruption(path, why) do
    if generate_on_boot?() do
      case generate_document() |> write_document(path) do
        {:ok, flattened} ->
          copy_to_last_good(path)

          Logger.error(
            "server config: #{path} UNUSABLE (#{why}) — REGENERATED it from env + defaults " <>
              "(#{map_size(flattened)} key(s)). Check what overwrote/invalidated the old file."
          )

        error ->
          Logger.error(
            "server config: #{path} UNUSABLE (#{why}) and regeneration FAILED " <>
              "(#{inspect(error)}) — env defaults boot"
          )
      end
    else
      Logger.error(
        "server config: #{path} UNUSABLE (#{why}) — no generation in this environment; " <>
          "env defaults boot"
      )
    end
  end

  # -- Paths ----------------------------------------------------------------------

  @doc "The editable config file's path (`CYTALE_SERVER_CONFIG_PATH`, dev/test: local tmp)."
  @spec config_path() :: String.t()
  def config_path do
    Application.get_env(:cytale, :server_config_path) ||
      if mix_prod?() do
        "/etc/cytale/config.json"
      else
        Path.join(File.cwd!(), "tmp/server-config.json")
      end
  end

  # Releases ship without Mix — guard the env probe the way the plan taught.
  defp mix_prod? do
    function_exported?(Mix, :env, 0) and Mix.env() == :prod
  end

  @doc "The secrets file — BESIDE the config file, `secrets.json` (0600)."
  @spec secrets_path() :: String.t()
  def secrets_path do
    Application.get_env(:cytale, :server_secrets_path) ||
      Path.join(Path.dirname(config_path()), "secrets.json")
  end

  @doc "The boot-fallback copy kept beside every successful load and save."
  @spec last_good_path() :: String.t()
  def last_good_path, do: Path.join(Path.dirname(config_path()), "config.last-good.json")

  defp generate_on_boot?, do: Application.get_env(:cytale, :server_config_generate, true)

  # -- Reading --------------------------------------------------------------------

  @doc """
  The EDITABLE document as it stands: the file's values for the keys it
  names, the current effective (env-derived/default) values for the keys it
  omits — editor-visible keys only, so the GET/PUT round-trip can never
  touch a secret or a hidden deployment fact. Used by `GET /admin/config`.
  """
  @spec effective_document() :: %{optional(String.t()) => term()}
  def effective_document do
    file = current_document()

    Schema.editor_keys()
    |> Enum.reduce(%{}, fn key, acc ->
      case Schema.fetch_path(file, key.path) do
        {:ok, value} -> Schema.put_path(acc, key.path, value)
        :missing -> effective_value(key, acc)
      end
    end)
  end

  defp effective_value(key, acc) do
    case env_value_for(key) do
      {:ok, value} -> Schema.put_path(acc, key.path, value)
      :omit -> acc
    end
  end

  # Schema.from_env/1 raises OmitKey when a key must NOT be materialized
  # (mailer.adapter with a real release-configured adapter).
  defp env_value_for(key) do
    {:ok, Schema.from_env(key)}
  rescue
    OmitKey -> :omit
  end

  @doc "Per-key editor metadata (type, scope, description, default, allowed) for help text."
  @spec metadata() :: %{optional(String.t()) => %{optional(String.t()) => term()}}
  def metadata do
    Map.new(Schema.editor_keys(), fn key ->
      base = %{
        "type" => type_label(key.type),
        "scope" => to_string(key.scope),
        "description" => key.description,
        "default" => key.default
      }

      base =
        case key.type do
          {:enum, allowed} -> Map.put(base, "allowed", allowed)
          {:map_of, buckets, _} -> Map.put(base, "allowed", Enum.map(buckets, &Atom.to_string/1))
          _ -> base
        end

      {key.path, base}
    end)
  end

  defp type_label(:boolean), do: "boolean"
  defp type_label(:string), do: "string"
  defp type_label(:origin), do: "origin"
  defp type_label({:nullable, inner}), do: type_label(inner) <> " | null"
  defp type_label({:list, :string}), do: "string[]"
  defp type_label({:list, :origin}), do: "origin[]"
  defp type_label({:list, :snowflake}), do: "id[]"
  defp type_label({:pos_integer, min}), do: "integer >= #{min}"

  defp type_label({:enum, allowed}), do: "enum(" <> Enum.join(allowed, " | ") <> ")"

  defp type_label({:map_of, buckets, _}),
    do: "map<" <> Enum.join(buckets, "|") <> ", integer>"

  @doc """
  One secret by key (`"mailer_api_key"`, `"turn_secret"`, `"ssh_ca_key_path"`,
  `"session_bridge_credential"`): the secrets.json value when present, the env
  fallback otherwise, nil when unset. This is the ONLY sanctioned read path —
  it is what restore-mode's writer pairs with, and what a real mailer adapter
  calls for its API key.
  """
  @spec secret(String.t()) :: String.t() | nil
  def secret(key) when is_binary(key) do
    case Map.get(secrets_map(), key) do
      value when is_binary(value) and value != "" ->
        value

      _ ->
        case Schema.secret_key(key) do
          %{env: env} -> env_value(env)
          nil -> nil
        end
    end
  end

  # -- Schema-generated accessors (7.8) --------------------------------------------
  #
  # The backup and client-error-alert accessors are GENERATED from the schema,
  # at compile time, exactly like the ones in `Cytale.Config`: scope+key and
  # default come from the one spec, so a reader cannot drift from what the
  # validator, the editor and the boot load believe. `save/1`'s hot-apply
  # writes the same homes these read, which is why a flip lands without a
  # restart.
  for %{
        fun: fun,
        scope: scope,
        key: key,
        default: default,
        spec: spec,
        description: description
      } <- Schema.readers(Cytale.ServerConfig) do
    @doc description
    @spec unquote(fun)() :: unquote(spec)
    def unquote(fun)(), do: read(unquote(scope), unquote(key), unquote(default))
  end

  # A scoped read matching the shapes the config chain writes: `Application
  # .get_env/2` may hold a keyword list (classic config) or a map (release
  # config provider, and this module's own `save/1` hot-apply).
  defp read(scope, key, default) do
    case Application.get_env(:cytale, scope) do
      value when is_map(value) ->
        Map.get(value, key, default)

      value when is_list(value) ->
        if Keyword.keyword?(value), do: Keyword.get(value, key, default), else: default

      _ ->
        default
    end
  end

  # `|| %{}` rather than a get-default: a peer's env cleanup that stores nil
  # must read as "no secrets", never as a map that crashes every secret read
  # (full-gate failure 2026-09-15: Map.get(nil, ...) inside secret/1).
  defp secrets_map, do: Application.get_env(:cytale, :server_secrets) || %{}

  # -- Saving (the editor write path) ----------------------------------------------

  @doc """
  Save an editor document (string-keyed nested JSON map):

    1. reject unknown and editor-hidden keys (specific errors);
    2. merge over the CURRENT file document (a save never rewrites a
       deployment fact it was never shown);
    3. validate the merged document against the schema — any violation
       refuses the save and leaves the file byte-identical;
    4. atomic write (temp → fsync → rename, 0640) + refresh last-good;
    5. hot-apply the changed RUNTIME-scoped keys into their application-env
       homes (readers see them immediately); BOOT-scoped changes are NOT
       applied — the response's `restart_required` says so.

  Returns `{:ok, %{changed: [paths], restart_required: boolean}}` or
  `{:error, term()}` (validation errors as `{:error, [{path, message}]}`).
  """
  @spec save(%{optional(String.t()) => term()}) ::
          {:ok, %{changed: [String.t()], restart_required: boolean()}}
          | {:error, term()}
  def save(put_doc) when is_map(put_doc) do
    current = current_document()

    with :ok <- check_known_editable(put_doc),
         merged = Schema.deep_merge(current, put_doc),
         :ok <- Schema.validate_document(merged) do
      changed = changed_paths(current, put_doc)
      boot_changed? = Enum.any?(changed, fn path -> Schema.key(path).scope == :boot end)

      case write_document(merged, config_path()) do
        {:ok, _flattened} ->
          copy_to_last_good(config_path())
          hot_apply_changes(current, put_doc, changed)
          {:ok, %{changed: Enum.sort(changed), restart_required: boot_changed?}}

        {:error, reason} ->
          {:error, {:io, reason}}
      end
    end
  end

  def save(_other), do: {:error, [{"/", "the document must be a JSON object"}]}

  defp check_known_editable(put_doc) do
    flattened = Schema.flatten(put_doc)

    errors =
      Enum.flat_map(flattened, fn {path, _value} ->
        case Schema.key(path) do
          nil -> [{path, "unknown key (not in the schema)"}]
          %{editor: false} -> [{path, "deployment fact, not editor-editable — edit the file on the server"}]
          _ -> []
        end
      end)

    case errors do
      [] -> :ok
      errors -> {:error, errors}
    end
  end

  defp changed_paths(current, put_doc) do
    flattened = Schema.flatten(put_doc)
    current_flat = Schema.flatten(current)

    flattened
    |> Enum.filter(fn {path, value} -> current_flat[path] != value end)
    |> Enum.map(&elem(&1, 0))
  end

  # Hot-apply ONLY the runtime-scoped changed keys — a boot-scoped edit must
  # not half-apply and then lie that it needs a restart.
  defp hot_apply_changes(current, put_doc, changed) do
    current_flat = Schema.flatten(current)
    put_flat = Schema.flatten(put_doc)

    Enum.each(changed, fn path ->
      key = Schema.key(path)

      if key != nil and key.scope == :runtime do
        value = Map.fetch!(put_flat, path)
        write_storage(key, Schema.to_env_value(key, value))
        Logger.info("server config: hot-applied #{path} (runtime scope)")
      else
        _ = current_flat
        Logger.info("server config: #{path} saved — takes effect on restart (boot scope)")
      end
    end)
  end

  # -- Secrets writing (restore-mode seam) ------------------------------------------

  @doc """
  Validate + atomically write a WHOLE secrets document (0600) and apply it —
  the seam restore-mode uses to materialize the secrets section of a backup
  archive. The write replaces the file; the map merges nothing.
  """
  @spec write_secrets(%{optional(String.t()) => String.t()}) ::
          :ok | {:error, term()}
  def write_secrets(map) when is_map(map) do
    with :ok <- Schema.validate_secrets(map),
         :ok <- write_atomic(secrets_path(), Jason.encode!(map, pretty: true), @secrets_mode) do
      apply_secrets(map)
      :ok
    end
  end

  def write_secrets(_other), do: {:error, :invalid}

  # -- The restart seam -------------------------------------------------------------

  @doc """
  Graceful self-restart, injectable for tests (`:server_restart_fn` app env;
  default `System.stop(0)` — the compose policy `restart: unless-stopped`, or
  the dev watchdog, brings the node back). The CALLER sends the HTTP response
  first; the stop runs off-process, after a short delay so the response is
  safely on the wire.
  """
  @spec initiate_restart() :: :ok
  def initiate_restart do
    Logger.warning("server config: RESTART requested by an operator — stopping gracefully (System.stop/1)")

    spawn(fn ->
      Process.sleep(300)
      restart_fn().()
    end)

    :ok
  end

  defp restart_fn, do: Application.get_env(:cytale, :server_restart_fn, fn -> System.stop(0) end)

  # -- Generation (first boot / regeneration) ----------------------------------------

  @doc """
  The migration source: every key's CURRENT effective value (env-derived or
  code default) as a JSON document. `mailer.adapter` is OMITTED when a real
  release-configured adapter is in place — writing "dev" would flip the
  adapter back on the next load.
  """
  @spec generate_document() :: %{optional(String.t()) => term()}
  def generate_document do
    Schema.keys()
    |> Enum.reduce(%{}, fn key, acc ->
      case env_value_for(key) do
        {:ok, value} -> Schema.put_path(acc, key.path, value)
        :omit -> acc
      end
    end)
  end

  # -- Atomic write ------------------------------------------------------------------

  @doc """
  Atomic file write: temp file in the SAME directory → write → chmod →
  fsync → rename over the target → best-effort directory fsync. A reader can
  observe the OLD file or the NEW file, never a partial one. Modes: 0640 for
  the config documents, 0600 for secrets.
  """
  @spec write_atomic(String.t(), iodata(), non_neg_integer()) :: :ok | {:error, term()}
  def write_atomic(path, data, mode) do
    dir = Path.dirname(path)
    tmp = Path.join(dir, "." <> Path.basename(path) <> ".tmp-#{System.unique_integer([:positive])}")

    with :ok <- File.mkdir_p(dir),
         :ok <- File.write(tmp, data),
         :ok <- File.chmod(tmp, mode),
         :ok <- sync_tmp(tmp) do
      case File.rename(tmp, path) do
        :ok ->
          # Best effort: flush the directory entry itself.
          case File.open(dir, [:raw, :read]) do
            {:ok, d} ->
              _ = :file.sync(d)
              File.close(d)

            _ ->
              :ok
          end

          :ok

        {:error, reason} ->
          File.rm(tmp)
          {:error, reason}
      end
    else
      {:error, reason} ->
        File.rm(tmp)
        {:error, reason}
    end
  end

  # fsync the temp file's bytes (raw+append does not truncate the data just
  # written); the fd is closed on every path.
  defp sync_tmp(tmp) do
    case File.open(tmp, [:raw, :append]) do
      {:ok, io} ->
        result = :file.sync(io)
        File.close(io)

        case result do
          :ok -> :ok
          {:error, reason} -> {:error, reason}
        end

      {:error, reason} ->
        {:error, reason}
    end
  end

  # -- Internals ---------------------------------------------------------------------

  # Read + fully validate a document file. ANY failure (unreadable, bad JSON,
  # schema violation) is an error — the caller owns the fallback story.
  @spec load_document(String.t()) ::
          {:ok, %{optional(String.t()) => term()}, %{optional(String.t()) => term()}}
          | {:error, term()}
  defp load_document(path) do
    with {:ok, raw} <- File.read(path),
         {:ok, doc} <- Jason.decode(raw),
         :ok <- Schema.validate_document(doc) do
      {:ok, doc, Schema.flatten(doc)}
    end
  end

  # Read + parse a JSON file (secrets): {:ok, map} | {:error, reason}.
  defp read_json(path) do
    with {:ok, raw} <- File.read(path),
         {:ok, map} <- Jason.decode(raw) do
      {:ok, map}
    end
  end

  # The current VALID file document; anything wrong reads as absent (the
  # boot fallbacks own the loud logging — this read is for GET/PUT, which
  # serve env-backed effective values when the file is not usable).
  defp current_document do
    path = config_path()

    case load_document(path) do
      {:ok, doc, _flat} -> doc
      {:error, _reason} -> %{}
    end
  end

  defp write_document(doc, path) do
    with :ok <- write_atomic(path, Jason.encode!(doc, pretty: true), @config_mode) do
      {:ok, Schema.flatten(doc)}
    end
  end

  defp copy_to_last_good(path) do
    case File.read(path) do
      {:ok, data} -> write_atomic(last_good_path(), data, @config_mode)
      {:error, reason} -> {:error, reason}
    end
  end

  # Boot: file values INTO the app-env homes. This is the precedence
  # mechanism — for every key the file names, the app env (already holding
  # env-or-default from the config chain) is overwritten with the file's
  # value; keys the file omits keep env > default.
  defp apply_document(flattened) do
    Enum.each(flattened, fn {path, json_value} ->
      case Schema.key(path) do
        nil -> Logger.warning("server config: ignoring unknown key #{path} while applying")
        key -> write_storage(key, Schema.to_env_value(key, json_value))
      end
    end)

    boot_guard_ssh()
  end

  defp write_storage(key, env_value) do
    case key.storage do
      {:top, atom_key} ->
        Application.put_env(:cytale, atom_key, env_value)

      {:scope_key, scope, scope_key} ->
        update_scope(scope, scope_key, env_value)

      :mailer_adapter ->
        current = mailer_config()
        Application.put_env(:cytale, Cytale.Accounts.Mailer, Keyword.put(current, :adapter, env_value))

      :rate_limit_overrides ->
        Application.put_env(:cytale, :rate_limit_overrides, env_value)
    end
  end

  # The scope value may be a keyword (classic config) or a map (release
  # config provider) — write back the SAME shape, or create a keyword.
  defp update_scope(scope, scope_key, value) do
    current = Application.get_env(:cytale, scope)

    cond do
      is_map(current) ->
        Application.put_env(:cytale, scope, Map.put(current, scope_key, value))

      is_list(current) and Keyword.keyword?(current) ->
        Application.put_env(:cytale, scope, Keyword.put(current, scope_key, value))

      true ->
        # NB: {scope_key, value} — the VARIABLE, not a [scope_key: ...] literal.
        Application.put_env(:cytale, scope, [{scope_key, value}])
    end
  end

  defp mailer_config do
    case Application.get_env(:cytale, Cytale.Accounts.Mailer) do
      kw when is_list(kw) ->
        if Keyword.keyword?(kw), do: kw, else: []

      _ ->
        []
    end
  end

  # The file can turn the SSH surface ON without the env-driven fail-fast in
  # runtime.exs ever running, so the same house posture is enforced here:
  # enabled with no reachable CA key loses only the TERMINAL (loud log,
  # fail-closed) — never a boot crash, never chat.
  defp boot_guard_ssh do
    enabled? = Cytale.Config.ssh_certificates_enabled?()
    ca_path = Cytale.Config.ssh_ca_key_path()

    if enabled? do
      cond do
        is_nil(ca_path) ->
          Application.put_env(:cytale, :ssh, Keyword.put(ssh_config(), :enabled, false))

          Logger.error(
            "server config: ssh.enabled=true but NO SSH CA key is configured " <>
              "(secrets.json key \"ssh_ca_key_path\" or env CYTALE_SSH_CA_KEY_PATH) — " <>
              "the certificate surface stays OFF (only the terminal is lost, never chat)"
          )

        not File.regular?(ca_path) ->
          Application.put_env(:cytale, :ssh, Keyword.put(ssh_config(), :enabled, false))

          Logger.error(
            "server config: ssh.enabled=true but no readable SSH CA key at #{ca_path} — " <>
              "the certificate surface stays OFF (only the terminal is lost, never chat)"
          )

        true ->
          :ok
      end
    end
  end

  defp ssh_config do
    case Application.get_env(:cytale, :ssh) do
      kw when is_list(kw) ->
        if Keyword.keyword?(kw), do: kw, else: []

      _ ->
        []
    end
  end

  # Boot: secrets precedence over env, written into the homes the existing
  # readers use — plus the `:server_secrets` map `secret/1` serves from.
  defp apply_secrets(map) do
    Application.put_env(:cytale, :server_secrets, map)

    if map["secret_key_base"] do
      apply_secret_key_base(map["secret_key_base"])
    end

    if map["ssh_ca_key_path"] do
      update_scope(:ssh, :ca_key_path, map["ssh_ca_key_path"])
    end

    if map["session_bridge_credential"] do
      update_scope(:session_bridge, :credential, map["session_bridge_credential"])
    end

    if map["turn_secret"] do
      apply_turn_secret(map["turn_secret"])
    end

    # "mailer_api_key" has no legacy home — consumers read it through
    # `secret/1` (a real mailer adapter's concern; see Schema.secret_keys/0).
    :ok
  end

  # #120: the restored/loaded secret_key_base takes the ENDPOINT's config home
  # — the same home runtime.exs seeds from SECRET_KEY_BASE — so sessions and
  # every key derived from it (permalinks) survive a restore. Runs in boot!(),
  # before the endpoint child starts; a secrets file that omits the key never
  # touches the endpoint config.
  defp apply_secret_key_base(value) do
    current =
      case Application.get_env(:cytale, CytaleWeb.Endpoint) do
        kw when is_list(kw) -> kw
        %{} = m -> Map.to_list(m)
        _ -> []
      end

    Application.put_env(:cytale, CytaleWeb.Endpoint, Keyword.put(current, :secret_key_base, value))
  end

  defp apply_turn_secret(secret) do
    turn = calls_config()[:turn]

    cond do
      is_map(turn) and is_binary(turn[:url]) ->
        update_scope(:calls, :turn, %{turn | secret: secret})

      is_binary(url = System.get_env("CYTALE_TURN_URL")) and url != "" ->
        update_scope(:calls, :turn, %{url: url, secret: secret})

      true ->
        Logger.error(
          "server config: secrets.json carries \"turn_secret\" but no TURN URL is configured " <>
            "(env CYTALE_TURN_URL) — the secret is stored but unused until a URL exists"
        )
    end
  end

  defp calls_config do
    case Application.get_env(:cytale, :calls) do
      kw when is_list(kw) ->
        if Keyword.keyword?(kw), do: Map.new(kw), else: %{}

      %{} = map ->
        map

      _ ->
        %{}
    end
  end

  defp env_value(env) do
    case System.get_env(env) do
      nil ->
        nil

      value ->
        case String.trim(value) do
          "" -> nil
          trimmed -> trimmed
        end
    end
  end

  defp format_errors(errors), do: Enum.map_join(errors, "; ", fn {p, m} -> "#{p}: #{m}" end)

  defp format_reason({:invalid, errors}), do: "schema violations: " <> format_errors(errors)
  defp format_reason(reason), do: inspect(reason)
end
