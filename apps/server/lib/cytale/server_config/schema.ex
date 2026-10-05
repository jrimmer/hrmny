defmodule Cytale.ServerConfig.Schema do
  @moduledoc """
  The single validator for the server's JSON config file (#121).

  One module owns every editable key: its TYPE, its allowed values/ranges,
  its `scope` (`:boot` — a change needs a node restart — vs `:runtime` —
  hot-applied on save), whether the editor may write it at all, its JSON
  default, and WHERE the value lives in the `:cytale` application env (the
  storage location the boot load and the runtime save both write through, so
  `Cytale.Config` readers keep working unchanged).

  THE SAME validation serves every consumer:

    * the boot load (`Cytale.ServerConfig.boot!/0` — file > env > code default);
    * the editor save (`PUT /api/v1/admin/config`);
    * the tests (asserting on this module directly, never re-implementing).

  Secrets are NOT here as editable keys: they live in `secrets.json` (0600,
  never GET-served, never editor-editable) and are described by
  `secret_keys/0` — the same module still validates them, so the restore-mode
  writer a later ticket adds cannot materialize an invalid secrets file.

  Editing rules the editor UI can rely on:

    * only `editor: true` keys appear in `GET /admin/config` and may appear
      in `PUT`; the deployment-fact keys (`backups.enabled`, `backups.dir`)
      ride in the FILE but are refused by the editor surface — a save
      round-trip never silently rewrites a deployment fact;
    * unknown keys are REJECTED (a typo'd key must fail loudly, not vanish);
    * every validated value carries a specific, human error message.
  """

  defstruct [:path, :type, :scope, :default, :description, :storage, editor: true]

  @type scope :: :boot | :runtime

  @typedoc """
  Value shapes the validator understands. `:origin` is an absolute origin
  (scheme://host[:port], no path, never `*`); `:snowflake` strings are
  positive decimal ids (JSON cannot carry a 64-bit id as a number).
  """
  @type type ::
          :boolean
          | :string
          | :origin
          | {:nullable, :origin}
          | {:list, :string}
          | {:list, :snowflake}
          | {:pos_integer, pos_integer()}
          | {:enum, [String.t()]}
          | {:map_of, [atom()], :pos_integer}

  @type t :: %__MODULE__{
          path: String.t(),
          type: type(),
          scope: scope(),
          default: term(),
          description: String.t(),
          storage:
            {:top, atom()}
            | {:scope_key, atom(), atom()}
            | :mailer_adapter
            | :rate_limit_overrides,
          editor: boolean()
        }

  @typedoc "One secrets.json entry (validate + env fallback, never served)."
  @type secret :: %{
          required(:key) => String.t(),
          required(:type) => :string | :path,
          required(:env) => String.t(),
          required(:description) => String.t()
        }

  @native_buckets ~w(auth api client_errors)a

  # Keyword specs, not struct literals: Elixir 1.20 forbids %__MODULE__{}
  # inside the module that defstructs it (compile-time strictness), so the
  # structs are materialized at runtime in keys/0.
  @key_specs [
    [
      path: "operator_user_ids",
      type: {:list, :snowflake},
      scope: :runtime,
      default: [],
      storage: {:top, :operator_user_ids},
      description:
        "Platform operators (account ids, decimal strings) — the allowlist behind " <>
          "RequireOperator on /api/v1/admin/*. Fail-closed: an empty list denies everyone. " <>
          "Applies live."
    ],
    [
      path: "registration_open",
      type: :boolean,
      scope: :runtime,
      default: false,
      storage: {:top, :registration_open},
      description:
        "When false (the default), POST /api/v1/auth/register answers 403 registration_closed " <>
          "before any validation unless the body carries a valid invite_code, which registers " <>
          "the account and joins that workspace (invite-only instances). Applies live."
    ],
    [
      path: "require_verified_email",
      type: :boolean,
      scope: :runtime,
      default: true,
      storage: {:top, :require_verified_email},
      description:
        "The view-only gate on accounts with unverified emails. Turn off only for deploys " <>
          "with no working mailer. Applies live."
    ],
    [
      path: "mailer.adapter",
      type: {:enum, ["dev"]},
      scope: :runtime,
      default: "dev",
      storage: :mailer_adapter,
      description:
        "The mailer adapter choice. \"dev\" is the LOCAL-ONLY dev mailbox (tokens land in a " <>
          "local file; verification mail is never sent). A real adapter is configured in " <>
          "release config and stays out of this file. Applies live."
    ],
    [
      path: "cors.allowed_origins",
      type: {:list, :origin},
      scope: :runtime,
      default: ["tauri://localhost", "http://tauri.localhost"],
      storage: {:scope_key, :cors, :allowed_origins},
      description:
        "Exact-match origin allowlist for browser clients NOT served from this origin " <>
          "(the desktop shells). \"*\" is never honored. Applies live."
    ],
    [
      path: "external_base_url",
      type: {:nullable, :origin},
      scope: :runtime,
      default: nil,
      storage: {:top, :external_base_url},
      description:
        "The externally-visible origin (scheme + host + optional port, NO path) used for " <>
          "every externally-constructed URL (gateway resume, webhook URLs). null = derive " <>
          "from the request. Applies live."
    ],
    [
      path: "rate_limits.overrides",
      type: {:map_of, @native_buckets, :pos_integer},
      scope: :runtime,
      default: %{},
      storage: :rate_limit_overrides,
      description:
        "Per-bucket overrides for the native rate-limit buckets (auth, api, client_errors): " <>
          "requests per that bucket's window. Empty object = pipeline defaults. Applies live."
    ],
    [
      path: "backups.frequency",
      type: {:enum, ["hourly", "daily", "weekly"]},
      scope: :runtime,
      default: "daily",
      storage: {:scope_key, :backups, :frequency},
      description: "How often the backup job runs (the backup ticket's schedule). Enforced enum."
    ],
    [
      path: "backups.retention",
      type: {:pos_integer, 1},
      scope: :runtime,
      default: 7,
      storage: {:scope_key, :backups, :retention},
      description: "How many backups to keep. Minimum 1."
    ],
    [
      path: "backups.enabled",
      type: :boolean,
      scope: :runtime,
      default: true,
      storage: {:scope_key, :backups, :enabled},
      editor: false,
      description: "Deployment fact, not tuning: lives in the FILE, hidden from the editor."
    ],
    [
      path: "backups.dir",
      type: :string,
      scope: :runtime,
      default: "backups",
      storage: {:scope_key, :backups, :dir},
      editor: false,
      description: "Deployment fact, not tuning: lives in the FILE, hidden from the editor."
    ],
    [
      path: "media.enabled",
      type: :boolean,
      scope: :runtime,
      default: true,
      storage: {:scope_key, :media, :enabled},
      description:
        "The media-plane master switch (ticket #124): voice calls, video and screen " <>
          "share — one plane, one switch (splitting is a later decision). Default TRUE: " <>
          "the default deployment offers calls exactly as the product always has. FALSE " <>
          "refuses call start/join and the ICE/TURN mint for NEW media, while calls " <>
          "already in progress run out naturally (never killed mid-sentence; only NEW " <>
          "joins refuse). This is the INSTANCE-LEVEL switch ABOVE permissions — the " <>
          "start_call/send_video/share_screen bits stay the per-role story; with the " <>
          "plane off they decide nothing. TURN configured + media off is a valid state " <>
          "(the ICE mint refuses); media on + TURN unconfigured fails at call time as " <>
          "always. The gate reads the switch per request, so a flip applies live — no " <>
          "restart. Applies live."
    ],
    [
      path: "observability.error_alerts_enabled",
      type: :boolean,
      scope: :runtime,
      default: true,
      storage: {:scope_key, :observability, :error_alerts_enabled},
      description:
        "The client-error recurrence alerter (#138). Default ON — recurrence detection " <>
          "is a regular capability of the server, not a bespoke watcher. When ON, a " <>
          "periodic pass aggregates Cytale.Observability.ClientErrors over the alert " <>
          "window and DMs the configured operator(s) about fingerprints past " <>
          "observability.error_alert_threshold, at most once per window per " <>
          "fingerprint. OFF is the ticket's off switch: nothing is alerted, and the " <>
          "error store keeps recording either way. Applies live."
    ],
    [
      path: "observability.error_alert_interval_minutes",
      type: {:pos_integer, 1},
      scope: :runtime,
      default: 30,
      storage: {:scope_key, :observability, :error_alert_interval_minutes},
      description:
        "How often the alerter wakes to look, in minutes (minimum 1). One pass is " <>
          "cheap (a bounded aggregate read + at most a handful of DMs); the ledger " <>
          "caps any fingerprint at one DM per window no matter how short this is. " <>
          "Applies live."
    ],
    [
      path: "observability.error_alert_window_hours",
      type: {:pos_integer, 1},
      scope: :runtime,
      default: 24,
      storage: {:scope_key, :observability, :error_alert_window_hours},
      description:
        "The recurrence window in hours (minimum 1). The count is read at " <>
          "day-partition granularity — the store walks ceil(hours/24) day " <>
          "partitions — and the once-per-window dedupe buckets time into windows of " <>
          "this length. Changing the length re-buckets the ledger once (a " <>
          "currently-repeating fingerprint may alert one extra time). Applies live."
    ],
    [
      path: "observability.error_alert_threshold",
      type: {:pos_integer, 1},
      scope: :runtime,
      default: 3,
      storage: {:scope_key, :observability, :error_alert_threshold},
      description:
        "How many occurrences inside the window make a fingerprint alert-worthy " <>
          "(minimum 1). A single occurrence is noise; repetition is the signal. " <>
          "Applies live."
    ],
    [
      path: "ssh.enabled",
      type: :boolean,
      scope: :boot,
      default: false,
      storage: {:scope_key, :ssh, :enabled},
      description:
        "Whether this node issues SSH user certificates (the terminal surface). " <>
          "BOOT-scoped: takes effect on restart. Fails closed at boot when no CA key is " <>
          "reachable — losing only the terminal, never chat."
    ],
    [
      path: "auth.two_factor_enabled",
      type: :boolean,
      scope: :runtime,
      default: false,
      storage: {:scope_key, :auth, :two_factor_enabled},
      description:
        "The TOTP two-factor switch (ticket #127). OFF (default): the feature is fully " <>
          "absent — no enrollment surface, no prompts, login unchanged. ON: password-only " <>
          "accounts are FORCED to enroll during their next login (password verified is no " <>
          "longer enough — enrollment grant, then confirm), and enrolled accounts get a " <>
          "TOTP code challenge at every password login. Passkey and OIDC logins mint " <>
          "tokens directly: they are already multifactor. Enforcement reads the switch at " <>
          "login, so a flip applies to the NEXT login without a restart; live sessions are " <>
          "unaffected. Losing the authenticator is recoverable: a password reset clears " <>
          "the enrollment. Applies live."
    ],
    [
      path: "auth.passkeys_enabled",
      type: :boolean,
      scope: :runtime,
      default: true,
      storage: {:scope_key, :webauthn, :enabled},
      description:
        "The passkey (WebAuthn) sign-in switch (ticket #36). Default ON (owner, " <>
          "2026-09-14). The surface additionally requires a REAL RP ID: the explicit " <>
          "webauthn.rp_id override or a configured external_base_url to derive it from — " <>
          "a deploy with neither keeps passkeys hidden regardless, because credentials " <>
          "enrolled against the localhost fallback can never work on the production domain. " <>
          "Applies live."
    ],
    [
      path: "oidc.enabled",
      type: :boolean,
      scope: :runtime,
      default: false,
      storage: {:scope_key, :oidc, :enabled},
      description:
        "The instance-level OIDC federated sign-in switch (ticket #12). Turning it on is " <>
          "not enough by itself: issuer_url, client_id AND the client secret (a secrets.json " <>
          "key, env CYTALE_OIDC_CLIENT_SECRET) must all be present or the surface stays " <>
          "off (fail-closed, Cytale.OIDC.enabled?/0). Password login is never disabled by " <>
          "this. Applies live."
    ],
    [
      path: "oidc.issuer_url",
      type: :string,
      scope: :runtime,
      default: "",
      storage: {:scope_key, :oidc, :issuer_url},
      description:
        "The provider's issuer identifier (e.g. \"https://idp.example.com/realms/main\") — " <>
          "the base the server fetches {issuer}/.well-known/openid-configuration from, and " <>
          "the value every ID token's iss claim must equal. An issuer with a path is legal " <>
          "(that is why this is a string, not an origin). Applies live (discovery is " <>
          "cached per issuer with a TTL, so a change takes effect on the next ceremony)."
    ],
    [
      path: "oidc.client_id",
      type: :string,
      scope: :runtime,
      default: "",
      storage: {:scope_key, :oidc, :client_id},
      description:
        "The client id registered at the provider for THIS deployment. The callback's " <>
          "redirect_uri is <external origin>/auth/oidc/callback — register exactly that. " <>
          "Applies live."
    ],
    [
      path: "oidc.scopes",
      type: :string,
      scope: :runtime,
      default: "openid email profile",
      storage: {:scope_key, :oidc, :scopes},
      description:
        "Space-separated authorize-request scopes. `openid` is required; the identity " <>
          "resolution reads the email/email_verified/preferred_username claims, so the " <>
          "email scope is what makes sign-in work at all. Applies live."
    ],
    [
      path: "oidc.button_label",
      type: :string,
      scope: :runtime,
      default: "Sign in with SSO",
      storage: {:scope_key, :oidc, :button_label},
      description:
        "The sign-in screen's federated-login button text (advertised beside the label " <>
          "itself by GET /auth/methods only while the surface is enabled). Applies live."
    ]
  ]

  @secrets [
    %{
      key: "secret_key_base",
      type: :string,
      env: "SECRET_KEY_BASE",
      description:
        "The Phoenix endpoint secret (sessions, token signing, permalink-key derivation). " <>
          "Rides the backup archive so a restored instance keeps its sessions and derived " <>
          "keys (#120 — regenerating it would invalidate every login and copied link)."
    },
    %{
      key: "mailer_api_key",
      type: :string,
      env: "CYTALE_MAILER_API_KEY",
      description: "API credential for a real mailer adapter (the adapter reads it via ServerConfig.secret/1)."
    },
    %{
      key: "turn_secret",
      type: :string,
      env: "CYTALE_TURN_SECRET",
      description: "The eturnal REST-auth shared secret (ephemeral TURN credentials)."
    },
    %{
      key: "ssh_ca_key_path",
      type: :path,
      env: "CYTALE_SSH_CA_KEY_PATH",
      description: "PATH to the CA's ed25519 private key — the key file itself stays a file."
    },
    %{
      key: "session_bridge_credential",
      type: :string,
      env: "CYTALE_SESSION_BRIDGE_CREDENTIAL",
      description: "The SSH session-bridge credential (the value form; the PATH form stays env-driven)."
    },
    %{
      key: "oidc_client_secret",
      type: :string,
      env: "CYTALE_OIDC_CLIENT_SECRET",
      description:
        "The instance OIDC provider's client secret (ticket #12). Read at ceremony time via " <>
          "ServerConfig.secret/1, sent only server→provider during the code exchange; never " <>
          "editor-served, never logged. Rides the backup archive with the rest of secrets.json."
    }
  ]

  # -- Compile-time accessor generation (7.8) --------------------------------------
  #
  # WHICH public accessor reads each key, and WHERE it lives. The accessor
  # bodies are GENERATED (at compile time) from the spec above — storage,
  # default, description and type — by `readers/1`, consumed in the module
  # bodies of `Cytale.Config` and `Cytale.ServerConfig`. Before this, each
  # accessor restated its key's default and storage by hand: a third copy that
  # could (and did, in 1.6) drift from what the writer and the editor used.
  #
  #   * a bare atom             — plain read, `Cytale.Config`
  #   * `{:present, fun}`       — `Cytale.Config`, blank → nil
  #   * `{:server_config, fun}` — plain read, `Cytale.ServerConfig`
  #
  # Keys absent here have no generated reader: `operator_user_ids` (read by
  # RequireOperator/the alerter), `mailer.adapter` (by the mailer),
  # `rate_limits.overrides` (by the rate-limit plug), and `external_base_url`
  # (HAND-WRITTEN: it raises on a non-origin value instead of defaulting).
  @readers %{
    "registration_open" => :registration_open?,
    "require_verified_email" => :require_verified_email?,
    "cors.allowed_origins" => :cors_allowed_origins,
    "backups.frequency" => {:server_config, :backup_frequency},
    "backups.retention" => {:server_config, :backup_retention},
    "backups.enabled" => {:server_config, :backups_enabled?},
    "backups.dir" => {:server_config, :backup_dir},
    "media.enabled" => :media_enabled?,
    "observability.error_alerts_enabled" => {:server_config, :error_alerts_enabled?},
    "observability.error_alert_interval_minutes" => {:server_config, :error_alert_interval_minutes},
    "observability.error_alert_window_hours" => {:server_config, :error_alert_window_hours},
    "observability.error_alert_threshold" => {:server_config, :error_alert_threshold},
    "ssh.enabled" => :ssh_certificates_enabled?,
    "auth.two_factor_enabled" => :two_factor_enabled?,
    "auth.passkeys_enabled" => :webauthn_enabled?,
    "oidc.enabled" => :oidc_enabled_flag?,
    "oidc.issuer_url" => {:present, :oidc_issuer_url},
    "oidc.client_id" => {:present, :oidc_client_id},
    "oidc.scopes" => :oidc_scopes,
    "oidc.button_label" => :oidc_button_label
  }

  @doc "The readers a target module should generate (see `@readers`)."
  @spec readers(module()) :: [map()]
  def readers(module) do
    known = Map.new(keys(), &{&1.path, &1})

    for {path, reader} <- @readers,
        key = Map.fetch!(known, path),
        {target, transform, fun} = reader_spec(reader),
        target == module do
      {scope, scope_key} = storage(key)

      %{
        fun: fun,
        scope: scope,
        key: scope_key,
        default: key.default,
        transform: transform,
        spec: spec_for(key.type, transform),
        description: key.description
      }
    end
  end

  defp reader_spec({:server_config, fun}), do: {Cytale.ServerConfig, :plain, fun}
  defp reader_spec({:present, fun}), do: {Cytale.Config, :present, fun}
  defp reader_spec(fun) when is_atom(fun), do: {Cytale.Config, :plain, fun}

  # Only the two READ shapes are generatable; `:mailer_adapter` /
  # `:rate_limit_overrides` must fail the compile, never be read as a scope+key.
  defp storage(%__MODULE__{storage: {:top, key}}), do: {nil, key}
  defp storage(%__MODULE__{storage: {:scope_key, scope, key}}), do: {scope, key}

  defp storage(%__MODULE__{path: path, storage: storage}) do
    raise ArgumentError,
          "Schema.readers/1 cannot generate a reader for #{path}: storage " <>
            "#{inspect(storage)} is not a plain top/scope_key read"
  end

  # The generated `@spec`, from the validator's own type.
  defp spec_for(_type, :present), do: quote(do: String.t() | nil)
  defp spec_for(:boolean, _transform), do: quote(do: boolean())
  defp spec_for(:string, _transform), do: quote(do: String.t())
  defp spec_for(:origin, _transform), do: quote(do: String.t())
  defp spec_for({:nullable, :origin}, _transform), do: quote(do: String.t() | nil)
  defp spec_for({:list, _kind}, _transform), do: quote(do: [String.t()])
  defp spec_for({:pos_integer, _min}, _transform), do: quote(do: pos_integer())
  defp spec_for({:enum, _allowed}, _transform), do: quote(do: String.t())
  defp spec_for({:map_of, _buckets, _value}, _transform), do: quote(do: map())

  @doc "Every editable-file key, hidden ones included."
  @spec keys() :: [t()]
  def keys, do: Enum.map(@key_specs, &struct!(__MODULE__, &1))

  @doc "The keys the editor surface may see and write."
  @spec editor_keys() :: [t()]
  def editor_keys, do: Enum.filter(keys(), & &1.editor)

  @doc "Look one key up by dot path."
  @spec key(String.t()) :: t() | nil
  def key(path) when is_binary(path), do: Enum.find(keys(), &(&1.path == path))

  @doc "The secrets.json surface — validate + env fallback, never GET-served."
  @spec secret_keys() :: [secret()]
  def secret_keys, do: @secrets

  @doc "Look one secret entry up by key."
  @spec secret_key(String.t()) :: secret() | nil
  def secret_key(key) when is_binary(key), do: Enum.find(@secrets, &(&1.key == key))

  # -- Document validation ---------------------------------------------------------

  @doc """
  Validate a whole JSON document (string-keyed, nested maps) against every
  known key. Returns `:ok`, or `{:error, [{path, message}]}` with one SPECIFIC
  message per violation — unknown keys included.

  This is the FILE/boot validation, so editor-hidden deployment-fact keys
  (`backups.enabled`, `backups.dir`) are LEGITIMATE here — the file carries
  them. The editor surface rejects them separately (`ServerConfig.save/1`'s
  known-editable check) so a save round-trip can never rewrite one.
  """
  @spec validate_document(term()) :: :ok | {:error, [{String.t(), String.t()}]}
  def validate_document(doc)

  def validate_document(doc) when is_map(doc) do
    flattened = flatten(doc)
    known = Map.new(keys(), &{&1.path, &1})

    errors =
      Enum.flat_map(flattened, fn {path, value} ->
        case Map.fetch(known, path) do
          {:ok, key} -> validate_value(key, value)
          :error -> [{path, "unknown key (not in the schema)"}]
        end
      end)

    case errors do
      [] -> :ok
      errors -> {:error, Enum.sort(errors)}
    end
  end

  def validate_document(_other), do: {:error, [{"/", "the document must be a JSON object"}]}

  @doc "Validate ONE value against its key definition (used by save and tests)."
  @spec validate_value(t(), term()) :: [{String.t(), String.t()}]
  def validate_value(%__MODULE__{path: path, type: type}, value) do
    case check(type, value) do
      :ok -> []
      {:error, message} -> [{path, message}]
    end
  end

  defp check(:boolean, value) when is_boolean(value), do: :ok
  defp check(:boolean, value), do: {:error, "expected true or false, got: #{inspect(value)}"}

  defp check(:string, value) when is_binary(value), do: :ok
  defp check(:string, value), do: {:error, "expected a string, got: #{inspect(value)}"}

  defp check(:origin, value), do: origin_check(value)

  defp check({:nullable, :origin}, nil), do: :ok
  defp check({:nullable, :origin}, value), do: origin_check(value)

  defp check({:list, :string}, value) when is_list(value) do
    bad = Enum.find(value, &(not is_binary(&1)))
    if bad, do: {:error, "expected a list of strings, found non-string: #{inspect(bad)}"}, else: :ok
  end

  defp check({:list, :string}, value), do: {:error, "expected a list of strings, got: #{inspect(value)}"}

  defp check({:list, :origin}, value) when is_list(value) do
    value
    |> Enum.find_value(fn entry ->
      case origin_check(entry) do
        :ok -> nil
        {:error, message} -> {:error, "bad origin #{inspect(entry)}: #{message}"}
      end
    end)
    |> case do
      nil -> :ok
      {:error, message} -> {:error, message}
    end
  end

  defp check({:list, :origin}, value),
    do: {:error, "expected a list of origin strings, got: #{inspect(value)}"}

  defp check({:list, :snowflake}, value) when is_list(value) do
    bad =
      Enum.find(value, fn id ->
        not (is_binary(id) and match?({int, ""} when int > 0, Integer.parse(String.trim(id))))
      end)

    if bad,
      do: {:error, "expected decimal snowflake STRINGS (positive integers), found: #{inspect(bad)}"},
      else: :ok
  end

  defp check({:list, :snowflake}, value),
    do: {:error, "expected a list of snowflake strings, got: #{inspect(value)}"}

  defp check({:pos_integer, min}, value) when is_integer(value) and value >= min, do: :ok

  defp check({:pos_integer, min}, value),
    do: {:error, "expected an integer >= #{min}, got: #{inspect(value)}"}

  defp check({:enum, allowed}, value) when is_binary(value) do
    if Enum.member?(allowed, value),
      do: :ok,
      else: {:error, "expected one of #{Enum.map_join(allowed, " | ", &inspect/1)}, got: #{inspect(value)}"}
  end

  defp check({:enum, _allowed}, value),
    do: {:error, "expected one of the allowed strings, got: #{inspect(value)}"}

  defp check({:map_of, buckets, :pos_integer}, value) when is_map(value) do
    allowed = Enum.map(buckets, &Atom.to_string/1)

    bad =
      Enum.find(value, fn {k, v} ->
        k not in allowed or not (is_integer(v) and v > 0)
      end)

    cond do
      bad == nil ->
        :ok

      true ->
        {k, v} = bad

        if Enum.member?(allowed, k) do
          {:error, "bucket #{inspect(k)}: expected a positive integer, got: #{inspect(v)}"}
        else
          {:error, "unknown bucket #{inspect(k)} (allowed: #{Enum.join(allowed, ", ")})"}
        end
    end
  end

  defp check({:map_of, buckets, :pos_integer}, value) do
    allowed = Enum.map(buckets, &Atom.to_string/1)
    {:error, "expected an object with keys #{Enum.join(allowed, ", ")}, got: #{inspect(value)}"}
  end

  defp origin_check(value) when is_binary(value) do
    trimmed = String.trim(value)

    cond do
      trimmed == "" ->
        {:error, "expected an absolute origin (e.g. \"https://chat.example.com\"), got an empty string"}

      trimmed == "*" ->
        {:error, "\"*\" is never honored — name exact origins"}

      Regex.match?(~r/\s/, trimmed) ->
        {:error, "origins carry no whitespace, got: #{inspect(value)}"}

      not (String.contains?(trimmed, "://") and !String.contains?(strip_scheme(trimmed), "/")) ->
        {:error, "expected an absolute origin (scheme://host[:port], NO path), got: #{inspect(value)}"}

      true ->
        :ok
    end
  end

  defp origin_check(value), do: {:error, "expected an origin string, got: #{inspect(value)}"}

  defp strip_scheme(value) do
    case String.split(value, "://", parts: 2) do
      [_scheme, rest] -> rest
      [rest] -> rest
    end
  end

  # -- Secrets validation ----------------------------------------------------------

  @doc """
  Validate a parsed secrets.json map: every key known, every value a
  non-empty string (omitted keys are fine — the file may carry only what the
  deploy has). Returns `:ok` or `{:error, [{key, message}]}`.
  """
  @spec validate_secrets(term()) :: :ok | {:error, [{String.t(), String.t()}]}
  def validate_secrets(map) when is_map(map) do
    known = Map.new(@secrets, &{&1.key, &1})

    errors =
      Enum.flat_map(map, fn {key, value} ->
        cond do
          not Map.has_key?(known, key) ->
            [{key, "unknown secret key"}]

          not is_binary(value) or String.trim(value) == "" ->
            [{key, "expected a non-empty string"}]

          true ->
            []
        end
      end)

    case errors do
      [] -> :ok
      errors -> {:error, errors}
    end
  end

  def validate_secrets(_other), do: {:error, [{"secrets.json", "the document must be a JSON object"}]}

  # -- JSON <-> application-env value conversion ------------------------------------

  @doc """
  The JSON value's application-env equivalent, written through the key's
  storage location when a save hot-applies (or the boot load seeds):

    * snowflake strings → integer ids (`CytaleWeb.Plugs.RequireOperator` reads ints);
    * `mailer.adapter` `"dev"` → the adapter MODULE;
    * `rate_limits.overrides` object → keyword list (the plug reads keywords).
  """
  @spec to_env_value(t(), term()) :: term()
  def to_env_value(%__MODULE__{path: "operator_user_ids"}, ids) do
    Enum.map(ids, fn id -> id |> String.trim() |> String.to_integer() end)
  end

  def to_env_value(%__MODULE__{path: "mailer.adapter"}, "dev"), do: Cytale.Accounts.Mailer.Dev

  def to_env_value(%__MODULE__{path: "rate_limits.overrides"}, overrides) do
    Map.new(overrides, fn {k, v} -> {String.to_existing_atom(k), v} end)
    |> Map.to_list()
  end

  def to_env_value(%__MODULE__{}, value), do: value

  @doc """
  The key's CURRENT effective value as a JSON value, read from the `:cytale`
  application env (which the config chain has already collapsed from env +
  code default) — the migration source when a first boot generates the file,
  and the fallback a GET serves for keys the file omits.
  """
  @spec from_env(t()) :: term()
  def from_env(%__MODULE__{path: "operator_user_ids", storage: {:top, key}}) do
    key |> app_env([]) |> Enum.map(&Integer.to_string/1)
  end

  def from_env(%__MODULE__{path: "mailer.adapter", storage: :mailer_adapter}) do
    module = Cytale.Accounts.Mailer.adapter()

    if module == Cytale.Accounts.Mailer.Dev do
      "dev"
    else
      # A release-configured real adapter: OMIT the key from the generated
      # file (writing "dev" here would flip the adapter back on the next load).
      # Module form, not `%…{}`: the struct literal would be a COMPILE-time
      # dependency on `Cytale.ServerConfig`, which expands its readers from
      # this module — a cycle. `raise Module` carries the same default message.
      raise Cytale.ServerConfig.OmitKey
    end
  end

  def from_env(%__MODULE__{path: "rate_limits.overrides", storage: :rate_limit_overrides}) do
    case app_env(:rate_limit_overrides, []) do
      kw when is_list(kw) and kw != [] ->
        kw
        |> Map.new(fn {k, v} -> {Atom.to_string(k), v} end)

      _ ->
        %{}
    end
  end

  def from_env(%__MODULE__{storage: {:top, key}, default: default}) do
    app_env(key, default)
  end

  def from_env(%__MODULE__{storage: {:scope_key, scope, key}, default: default}) do
    scope
    |> app_env([])
    |> dig_scope_key(key, default)
  end

  defp dig_scope_key(scope_value, key, default) do
    cond do
      is_map(scope_value) -> Map.get(scope_value, key, default)
      is_list(scope_value) -> Keyword.get(scope_value, key, default)
      true -> default
    end
  end

  defp app_env(key, default) when is_atom(key) do
    Application.get_env(:cytale, key, default)
  end

  # -- Document (un)flattening ------------------------------------------------------

  @doc "Flatten a nested JSON document into `%{\"dot.path\" => leaf}`."
  @spec flatten(%{optional(String.t()) => term()}) :: %{optional(String.t()) => term()}
  def flatten(doc, prefix \\ "")

  def flatten(doc, prefix) when is_map(doc) do
    Enum.flat_map(doc, fn
      {k, v} when is_map(v) and v != %{} -> flatten(v, child(prefix, k))
      {_k, v} when is_map(v) -> []
      {k, v} -> [{child(prefix, k), v}]
    end)
    |> Map.new()
  end

  def flatten(_other, _prefix), do: %{}

  @doc "Read one dot path out of a nested document (`:missing` when absent)."
  @spec fetch_path(%{optional(String.t()) => term()}, String.t()) :: {:ok, term()} | :missing
  def fetch_path(doc, path) when is_map(doc) do
    segments = String.split(path, ".")

    walk =
      Enum.reduce_while(segments, doc, fn segment, node ->
        if is_map(node) and Map.has_key?(node, segment) do
          {:cont, Map.fetch!(node, segment)}
        else
          {:halt, :missing}
        end
      end)

    case walk do
      :missing -> :missing
      value -> {:ok, value}
    end
  end

  def fetch_path(_other, _path), do: :missing

  @doc "Put one dot path INTO a nested document, creating intermediate objects."
  @spec put_path(%{optional(String.t()) => term()}, String.t(), term()) ::
          %{optional(String.t()) => term()}
  def put_path(doc, path, value) when is_map(doc) do
    [head | rest] = String.split(path, ".")

    case rest do
      [] ->
        Map.put(doc, head, value)

      _ ->
        child = Map.get(doc, head, %{})
        Map.put(doc, head, put_path(child, Enum.join(rest, "."), value))
    end
  end

  @doc "Recursively merge `overlay` over `base` (string-keyed nested maps; leaves replace)."
  @spec deep_merge(%{optional(String.t()) => term()}, %{optional(String.t()) => term()}) ::
          %{optional(String.t()) => term()}
  def deep_merge(base, overlay) when is_map(base) and is_map(overlay) do
    Map.merge(base, overlay, fn
      _k, b, o when is_map(b) and is_map(o) -> deep_merge(b, o)
      _k, _b, o -> o
    end)
  end

  defp child("", k), do: k
  defp child(prefix, k), do: prefix <> "." <> k
end
