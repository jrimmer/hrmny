defmodule Cytale.ServerConfigTest do
  @moduledoc """
  #121 — the config file's load order, generation, fallback chain, the
  atomic-write helper, and the editor save path — against REAL temp files.

  Every test drives `Cytale.ServerConfig.boot!/0` / `save/1` directly with its
  own temp `server_config_path` (the hermetic suite never generates a file of
  its own — `server_config_generate` is false in :test — so a boot write can
  never collide with a parallel agent's run). Global app-env keys the module
  writes are saved and restored around each test.
  """

  use ExUnit.Case, async: false

  import ExUnit.CaptureLog

  alias Cytale.ServerConfig
  alias Cytale.ServerConfig.Schema

  @env_keys [
    :operator_user_ids,
    :registration_open,
    :require_verified_email,
    :cors,
    :external_base_url,
    :rate_limit_overrides,
    :backups,
    :ssh,
    :session_bridge,
    :calls,
    :server_secrets,
    :server_config_path,
    :server_secrets_path,
    :server_config_generate,
    Cytale.Accounts.Mailer
  ]

  setup do
    saved = Map.new(@env_keys, fn k -> {k, Application.get_env(:cytale, k)} end)

    dir = Path.join(System.tmp_dir!(), "cytale-srvcfg-#{System.unique_integer([:positive])}")
    File.mkdir_p!(dir)
    config_path = Path.join(dir, "config.json")

    Application.put_env(:cytale, :server_config_path, config_path)
    Application.delete_env(:cytale, :server_secrets_path)
    Application.put_env(:cytale, :server_config_generate, true)

    on_exit(fn ->
      Enum.each(@env_keys, fn k ->
        case Map.fetch(saved, k) do
          {:ok, nil} -> Application.delete_env(:cytale, k)
          {:ok, value} -> Application.put_env(:cytale, k, value)
        end
      end)

      File.rm_rf!(dir)
    end)

    %{dir: dir, config_path: config_path}
  end

  # -- First boot: generation ------------------------------------------------------

  test "first boot with no file generates one from the current (env-derived) values, logged", %{
    config_path: config_path
  } do
    # PIN the env this test asserts against: generation reads the live
    # Application env, and a peer suite's on_exit (which restores its own
    # config values) can race this boot in full-suite ordering — the leaked
    # values then masquerade as "defaults" (full-gate finding, 2026-09-15).
    Application.put_env(:cytale, :backups,
      frequency: "daily",
      retention: 7,
      enabled: true,
      dir: "backups"
    )

    Application.put_env(:cytale, :registration_open, false)
    Application.put_env(:cytale, :operator_user_ids, [42, 1042])

    log =
      capture_log(fn ->
        assert :ok = ServerConfig.boot!()
      end)

    assert File.exists?(config_path)
    assert File.stat!(config_path).mode == 0o100640
    assert File.exists?(ServerConfig.last_good_path())

    doc = read_json(config_path)
    # Values PRESERVED: env-derived values land in the file...
    assert doc["registration_open"] == false
    assert doc["operator_user_ids"] == ["42", "1042"]
    # ...and code defaults fill the keys env never touched.
    assert doc["backups"] == %{"frequency" => "daily", "retention" => 7, "enabled" => true, "dir" => "backups"}
    # Secrets beside it, 0600 (empty here — no secret env vars in the run).
    assert File.exists?(ServerConfig.secrets_path())
    assert File.stat!(ServerConfig.secrets_path()).mode == 0o100600
    assert log =~ "generated"
    assert log =~ "config.json" or log =~ "FIRST BOOT"
  end

  test "a real release-configured mailer adapter is OMITTED from the generated file", %{
    config_path: config_path
  } do
    Application.put_env(:cytale, Cytale.Accounts.Mailer, adapter: Some.RealAdapter)

    capture_log(fn -> ServerConfig.boot!() end)

    doc = read_json(config_path)
    refute Map.has_key?(doc, "mailer")
    # ...and the adapter is untouched by the load.
    assert Cytale.Accounts.Mailer.adapter() == Some.RealAdapter
  end

  # -- Precedence: file > env > default ---------------------------------------------

  test "the file overrides env for every key it names", %{config_path: config_path} do
    Application.put_env(:cytale, :registration_open, false)
    Application.put_env(:cytale, :cors, allowed_origins: ["https://env-origin.example"])

    File.write!(
      config_path,
      Jason.encode!(%{
        "registration_open" => true,
        "cors" => %{"allowed_origins" => ["https://file-origin.example"]},
        "external_base_url" => "https://chat.example.com"
      })
    )

    capture_log(fn -> ServerConfig.boot!() end)

    assert Application.get_env(:cytale, :registration_open) == true
    assert Cytale.Config.cors_allowed_origins() == ["https://file-origin.example"]
    assert Cytale.Config.external_base_url() == "https://chat.example.com"
  end

  test "a key the file omits falls back (env-derived value kept, not clobbered)", %{
    config_path: config_path
  } do
    # The env chain has already collapsed "env or code default" into app env;
    # a file that omits the key must leave that value standing.
    Application.put_env(:cytale, :registration_open, false)

    File.write!(config_path, Jason.encode!(%{"require_verified_email" => true}))

    capture_log(fn -> ServerConfig.boot!() end)

    assert Application.get_env(:cytale, :registration_open) == false
    assert Application.get_env(:cytale, :require_verified_email) == true
  end

  # -- Boot fallback chain ------------------------------------------------------------

  test "corrupt file at boot: last-good boots + loud log", %{config_path: config_path} do
    File.write!(config_path, Jason.encode!(%{"registration_open" => true, "backups" => %{"retention" => 9}}))
    capture_log(fn -> ServerConfig.boot!() end)
    assert Application.get_env(:cytale, :registration_open) == true

    # Now corrupt the live file AND flip an env value that last-good must override.
    File.write!(config_path, "{not json at all")
    Application.put_env(:cytale, :registration_open, false)

    log =
      capture_log(fn ->
        assert :ok = ServerConfig.boot!()
      end)

    assert Application.get_env(:cytale, :registration_open) == true
    # The corrupt file is NOT silently rewritten over (the operator sees it).
    assert File.read!(config_path) =~ "not json"
    assert log =~ "last-good"
  end

  test "corrupt file AND no last-good: regenerated from env, loudly; the boot never crashes", %{
    config_path: config_path
  } do
    File.write!(config_path, "{{{")
    File.rm(ServerConfig.last_good_path())
    Application.put_env(:cytale, :registration_open, false)

    log =
      capture_log(fn ->
        assert :ok = ServerConfig.boot!()
      end)

    assert Application.get_env(:cytale, :registration_open) == false
    # Self-healed: a fresh (default-valued) file exists, loudly announced.
    assert read_json(config_path)["registration_open"] == false
    assert log =~ "REGENERATED" or log =~ "UNUSABLE"
  end

  test "a schema-violating (well-formed JSON) file with no last-good regenerates from env", %{
    config_path: config_path
  } do
    # retention 0: parses fine, violates the schema.
    File.write!(config_path, Jason.encode!(%{"backups" => %{"retention" => 0}}))
    File.rm(ServerConfig.last_good_path())
    Application.put_env(:cytale, :backups, frequency: "weekly", retention: 4)

    log =
      capture_log(fn ->
        assert :ok = ServerConfig.boot!()
      end)

    # The regeneration source is the env-derived value, not the invalid file.
    doc = read_json(config_path)
    assert doc["backups"]["retention"] == 4
    assert doc["backups"]["frequency"] == "weekly"
    assert log =~ "UNUSABLE" or log =~ "REGENERATED"
  end

  # -- Secrets -------------------------------------------------------------------------

  test "first boot generates secrets.json (0600) from env, and the file takes precedence", %{
    config_path: _config_path
  } do
    ca = Path.join(System.tmp_dir!(), "cytale-fake-ca-#{System.unique_integer([:positive])}")
    File.write!(ca, "fake-key-bytes")
    System.put_env("CYTALE_SSH_CA_KEY_PATH", ca)
    System.put_env("CYTALE_TURN_URL", "turn:turn.example:3478")

    on_exit(fn ->
      System.delete_env("CYTALE_SSH_CA_KEY_PATH")
      System.delete_env("CYTALE_TURN_URL")
      File.rm(ca)
    end)

    capture_log(fn -> ServerConfig.boot!() end)

    secrets_path = ServerConfig.secrets_path()
    assert File.stat!(secrets_path).mode == 0o100600

    # Precedence: the FILE value (same as env here) is what readers see...
    assert ServerConfig.secret("ssh_ca_key_path") == ca
    assert Cytale.Config.ssh_ca_key_path() == ca
    # ...and once the file carries a DIFFERENT value, the file wins over env.
    File.write!(secrets_path, Jason.encode!(%{"ssh_ca_key_path" => "/elsewhere/ca", "turn_secret" => "s3cr3t"}))
    capture_log(fn -> ServerConfig.boot!() end)

    assert ServerConfig.secret("ssh_ca_key_path") == "/elsewhere/ca"
    assert ServerConfig.secret("turn_secret") == "s3cr3t"
    # The TURN secret is applied into the home the ICE mint reads.
    %{turn: %{url: url, secret: secret}} = calls_scope()
    assert url == "turn:turn.example:3478"
    assert secret == "s3cr3t"
    refute ServerConfig.secret("mailer_api_key")
  end

  test "an INVALID secrets file is ignored (env stays authoritative) with a loud log", %{
    config_path: _config_path
  } do
    File.write!(ServerConfig.secrets_path(), Jason.encode!(%{"not_a_secret" => "x"}))

    log =
      capture_log(fn ->
        assert :ok = ServerConfig.boot!()
      end)

    assert ServerConfig.secret("turn_secret") == nil
    assert log =~ "IGNORING"
  end

  test "write_secrets/1 (restore-mode seam) validates, writes 0600, and applies", %{
    config_path: _config_path
  } do
    assert {:error, [_]} = ServerConfig.write_secrets(%{"unknown" => "x"})

    assert :ok =
             ServerConfig.write_secrets(%{"session_bridge_credential" => "bridge-secret"})

    assert File.stat!(ServerConfig.secrets_path()).mode == 0o100600
    assert ServerConfig.secret("session_bridge_credential") == "bridge-secret"
    assert bridge_credential() == "bridge-secret"
  end

  # -- The atomic write helper -----------------------------------------------------------

  test "write_atomic/3: temp+rename — content lands, mode set, no temp litter", %{dir: dir} do
    target = Path.join(dir, "atomic.json")

    assert :ok = ServerConfig.write_atomic(target, Jason.encode!(%{"a" => 1}), 0o640)

    assert File.read!(target) == Jason.encode!(%{"a" => 1})
    assert File.stat!(target).mode == 0o100640
    # No partial/temp files ever observable in the directory.
    assert [] = File.ls!(dir) -- ["atomic.json"]

    # Overwrite is the same story.
    assert :ok = ServerConfig.write_atomic(target, "second", 0o600)
    assert File.read!(target) == "second"
    assert File.stat!(target).mode == 0o100600
    assert [] = File.ls!(dir) -- ["atomic.json"]
  end

  test "write_atomic/3 reports the failure and leaves no temp file when the target is unusable", %{
    dir: dir
  } do
    # A DIRECTORY as the rename target: write of the temp file succeeds, the
    # rename fails, the helper cleans up after itself.
    target_dir = Path.join(dir, "adir")
    File.mkdir_p!(target_dir)

    assert {:error, _} = ServerConfig.write_atomic(target_dir, "x", 0o640)
    assert File.dir?(target_dir)
    assert [] = File.ls!(dir) -- ["adir"]
  end

  # -- The editor save path ------------------------------------------------------------

  test "save/1: a runtime-scoped change hot-applies (a Cytale.Config read reflects it) and lands in the file", %{
    config_path: config_path
  } do
    capture_log(fn -> ServerConfig.boot!() end)

    assert {:ok, %{changed: changed, restart_required: false}} =
             ServerConfig.save(%{
               "cors" => %{"allowed_origins" => ["https://hot.example"]},
               "backups" => %{"retention" => 3}
             })

    assert changed == ["backups.retention", "cors.allowed_origins"]
    # LIVE: the existing reader sees the new value with no restart.
    assert Cytale.Config.cors_allowed_origins() == ["https://hot.example"]
    assert ServerConfig.backup_retention() == 3
    assert read_json(config_path)["cors"]["allowed_origins"] == ["https://hot.example"]
    # Last-good tracks the save.
    assert read_json(ServerConfig.last_good_path())["backups"]["retention"] == 3
  end

  test "save/1: a boot-scoped change answers restart_required: true and does NOT hot-apply", %{
    config_path: _config_path
  } do
    capture_log(fn -> ServerConfig.boot!() end)
    assert Cytale.Config.ssh_certificates_enabled?() == false

    capture_log(fn ->
      assert {:ok, %{changed: ["ssh.enabled"], restart_required: true}} =
               ServerConfig.save(%{"ssh" => %{"enabled" => true}})
    end)

    # NOT applied — the running node keeps its boot-time value.
    assert Cytale.Config.ssh_certificates_enabled?() == false
  end

  test "save/1 merges over the file, preserving hidden deployment facts", %{config_path: config_path} do
    File.write!(
      config_path,
      Jason.encode!(%{
        "backups" => %{"enabled" => false, "dir" => "/var/backups", "retention" => 7, "frequency" => "daily"}
      })
    )

    capture_log(fn -> ServerConfig.boot!() end)

    assert {:ok, _} = ServerConfig.save(%{"backups" => %{"retention" => 12}})

    doc = read_json(config_path)
    assert doc["backups"]["retention"] == 12
    # Deployment facts the editor never saw are untouched.
    assert doc["backups"]["enabled"] == false
    assert doc["backups"]["dir"] == "/var/backups"
  end

  test "save/1 refuses invalid documents with SPECIFIC errors and the file is untouched", %{
    config_path: config_path
  } do
    File.write!(config_path, Jason.encode!(%{"backups" => %{"retention" => 7}}))
    original = File.read!(config_path)

    capture_log(fn -> ServerConfig.boot!() end)

    bad_docs = [
      {%{"backups" => %{"frequency" => "monthly"}}, "backups.frequency", "expected one of"},
      {%{"backups" => %{"retention" => 0}}, "backups.retention", "integer >= 1"},
      {%{"backups" => %{"retention" => "seven"}}, "backups.retention", "expected an integer"},
      {%{"registration_open" => "yes"}, "registration_open", "expected true or false"},
      {%{"cors" => %{"allowed_origins" => ["*"]}}, "cors.allowed_origins", "never honored"},
      {%{"no_such_key" => 1}, "no_such_key", "unknown key"},
      {%{"backups" => %{"dir" => "/tmp/x"}}, "backups.dir", "not editor-editable"}
    ]

    for {doc, path, message} <- bad_docs do
      assert {:error, errors} = ServerConfig.save(doc)
      assert {^path, error_message} = Enum.find(errors, fn {p, _} -> p == path end)
      assert error_message =~ message, "unexpected error for #{path}: #{error_message}"
    end

    # Every refusal left the file byte-identical AND hot state untouched.
    assert File.read!(config_path) == original
    assert ServerConfig.backup_retention() == 7
  end

  # -- The boot guard: ssh.enabled=true without a reachable CA key fails CLOSED -----

  test "file-driven ssh.enabled=true with no CA key stays off (loud), never crashes boot", %{
    config_path: config_path
  } do
    File.write!(config_path, Jason.encode!(%{"ssh" => %{"enabled" => true}}))

    log =
      capture_log(fn ->
        assert :ok = ServerConfig.boot!()
      end)

    assert Cytale.Config.ssh_certificates_enabled?() == false
    assert log =~ "stays OFF"
  end

  # -- Schema sanity -------------------------------------------------------------------

  test "the schema validates flatten/put_path round-trips and deep_merge", %{config_path: _} do
    doc = %{"backups" => %{"frequency" => "daily"}, "operator_user_ids" => ["1"]}
    flat = Schema.flatten(doc)
    assert flat == %{"backups.frequency" => "daily", "operator_user_ids" => ["1"]}

    rebuilt = Schema.put_path(Schema.put_path(%{}, "backups.frequency", "daily"), "operator_user_ids", ["1"])
    assert Schema.flatten(rebuilt) == flat

    merged =
      Schema.deep_merge(%{"backups" => %{"frequency" => "daily", "retention" => 7}}, %{
        "backups" => %{"retention" => 3}
      })

    assert merged == %{"backups" => %{"frequency" => "daily", "retention" => 3}}
  end

  test "effective_document/0: file values win, omitted keys read their effective values", %{
    config_path: config_path
  } do
    Application.put_env(:cytale, :registration_open, false)
    File.write!(config_path, Jason.encode!(%{"require_verified_email" => false}))
    capture_log(fn -> ServerConfig.boot!() end)

    doc = ServerConfig.effective_document()

    assert doc["require_verified_email"] == false
    assert doc["registration_open"] == false
    # Hidden deployment facts never appear; the document is editor-complete.
    refute Map.has_key?(Schema.flatten(doc), "backups.enabled")

    for key <- Schema.editor_keys() do
      assert {:ok, _} = Schema.fetch_path(doc, key.path)
    end
  end

  # -- helpers ---------------------------------------------------------------------------

  defp read_json(path) do
    path |> File.read!() |> Jason.decode!()
  end

  defp calls_scope do
    case Application.get_env(:cytale, :calls) do
      kw when is_list(kw) -> Map.new(kw)
      %{} = map -> map
    end
  end

  defp bridge_credential do
    case Application.get_env(:cytale, :session_bridge, []) do
      kw when is_list(kw) -> Keyword.get(kw, :credential)
      %{} = map -> Map.get(map, :credential)
    end
  end
end
