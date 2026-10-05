defmodule Cytale.Calls.MediaKillSwitchTest do
  @moduledoc """
  Ticket #124 — the media-plane master switch (`media.enabled`), context
  level: the server is the authority, so `Cytale.Calls.start_call/join_call`
  refuse with `{:error, :media_disabled}` when the switch is off — above any
  permission consult — while a call already in progress runs out naturally
  (never torn down by the flip; only NEW joins refuse, an existing
  participant's re-bind keeps working).

  Also pins the config round trip: the editor-visible schema entry, the
  non-boolean validation refusal, and the save path's hot-apply (a flip is
  read per request — `Cytale.Config.media_enabled?/0` — so it applies with
  no restart; re-enabling in the same VM is proven here by the flip-back
  tests, which is the whole runtime-scope argument).
  """

  use Cytale.ScyllaCase, async: false

  alias Cytale.Calls
  alias Cytale.Config
  alias Cytale.ServerConfig

  setup do
    # The switch lives in the runtime-scoped `:media` scope (the same app-env
    # home the editor's hot-apply writes). Save + restore around every test —
    # absent reads as the default TRUE, so cleanup restores today's behavior.
    saved = Application.get_env(:cytale, :media)

    on_exit(fn ->
      case saved do
        nil -> Application.delete_env(:cytale, :media)
        value -> Application.put_env(:cytale, :media, value)
      end
    end)

    :ok
  end

  defp spawn_session do
    spawn(fn ->
      receive do
        :stop -> :ok
      end
    end)
  end

  defp set_media(enabled?) do
    Application.put_env(:cytale, :media, enabled: enabled?)
  end

  # -- default (true): everything behaves exactly as today (regression pin) ----

  test "default (flag unset): start and join behave exactly as today" do
    assert Config.media_enabled?() == true

    channel_id = Cytale.Snowflake.next()
    starter = Cytale.Snowflake.next()
    joiner = Cytale.Snowflake.next()
    session = spawn_session()
    joiner_session = spawn_session()

    assert {:ok, %{action: :started, call_id: call_id}} =
             Calls.start_call(channel_id, starter, session)

    assert {:ok, %{call_id: ^call_id}} = Calls.join_call(channel_id, joiner, joiner_session)

    assert %{participants: participants} = Calls.live_call(channel_id)
    assert length(participants) == 2
  end

  test "explicitly enabled reads the same as unset" do
    set_media(true)
    assert Config.media_enabled?() == true
  end

  # -- false: the gates ----------------------------------------------------------

  test "disabled: start_call refuses with :media_disabled, before permissions" do
    set_media(false)

    channel_id = Cytale.Snowflake.next()
    session = spawn_session()

    assert {:error, :media_disabled} = Calls.start_call(channel_id, Cytale.Snowflake.next(), session)
    # No room materialized, no calls row opened — the refusal is total.
    assert is_nil(Calls.room_pid(channel_id))
  end

  test "disabled: a NEW join refuses, but an in-progress call is NOT torn down and its participant re-binds" do
    channel_id = Cytale.Snowflake.next()
    starter = Cytale.Snowflake.next()
    late = Cytale.Snowflake.next()
    session = spawn_session()
    late_session = spawn_session()

    {:ok, %{call_id: call_id}} = Calls.start_call(channel_id, starter, session)

    # The flip lands mid-call (the standing-call edge is exactly this).
    set_media(false)

    # A NEW join refuses with the specific reason...
    assert {:error, :media_disabled} = Calls.join_call(channel_id, late, late_session)

    # ...the live room is untouched (run out naturally — never killed
    # mid-sentence), and the existing participant's re-bind still works
    # (a Resume must not cost them the leg the flip promised to keep).
    assert %{call_id: ^call_id, participants: [p]} = Calls.live_call(channel_id)
    assert p.user_id == starter
    assert {:ok, %{call_id: ^call_id}} = Calls.join_call(channel_id, starter, session)

    # A start on ANOTHER channel refuses too — the flip is instance-wide.
    assert {:error, :media_disabled} =
             Calls.start_call(Cytale.Snowflake.next(), Cytale.Snowflake.next(), spawn_session())
  end

  # -- runtime flip: applies live, no restart --------------------------------------

  test "flip at runtime applies immediately — refuse, re-enable, works again (no restart)" do
    channel_id = Cytale.Snowflake.next()
    user = Cytale.Snowflake.next()
    session = spawn_session()

    {:ok, %{call_id: call_id}} = Calls.start_call(channel_id, user, session)

    set_media(false)
    # The very next request sees the flip — same VM, same processes.
    assert {:error, :media_disabled} =
             Calls.start_call(Cytale.Snowflake.next(), Cytale.Snowflake.next(), session)

    # The pre-existing call is still live through the flip...
    assert %{call_id: ^call_id} = Calls.live_call(channel_id)

    # ...and re-enabling (the editor writes back through the same hot-apply)
    # restores service without any restart.
    set_media(true)

    assert {:ok, %{action: :started}} =
             Calls.start_call(Cytale.Snowflake.next(), Cytale.Snowflake.next(), session)
  end

  # -- config round trip (#121 editor surface) --------------------------------------

  test "the editor document carries media.enabled — editor-visible, runtime-scoped, default true" do
    key = Cytale.ServerConfig.Schema.key("media.enabled")
    assert %Cytale.ServerConfig.Schema{} = key
    assert key.type == :boolean and key.scope == :runtime and key.editor and key.default == true

    # The generated/effective document (what GET /admin/config serves and what
    # a first boot writes) includes the key.
    doc = ServerConfig.generate_document()
    assert %{"media" => %{"enabled" => true}} = doc
  end

  test "schema validation catches a non-boolean media.enabled" do
    assert {:error, [{"media.enabled", message}]} =
             Cytale.ServerConfig.Schema.validate_document(%{"media" => %{"enabled" => "yes"}})

    assert message =~ "expected true or false"
  end

  test "the editor save path hot-applies the flip (restart_required stays false)" do
    dir = Path.join(System.tmp_dir!(), "cytale-media-#{System.unique_integer([:positive])}")
    File.mkdir_p!(dir)
    config_path = Path.join(dir, "config.json")

    saved_path = Application.get_env(:cytale, :server_config_path)
    saved_generate = Application.get_env(:cytale, :server_config_generate)
    Application.put_env(:cytale, :server_config_path, config_path)
    Application.put_env(:cytale, :server_config_generate, false)

    on_exit(fn ->
      Application.put_env(:cytale, :server_config_path, saved_path)
      Application.put_env(:cytale, :server_config_generate, saved_generate)
      File.rm_rf!(dir)
    end)

    assert {:ok, %{changed: changed, restart_required: false}} =
             ServerConfig.save(%{"media" => %{"enabled" => false}})

    assert "media.enabled" in changed
    # The hot-apply wrote the app env the per-request gate reads...
    assert Config.media_enabled?() == false
    # ...and the file round-trips (the editor GET shows the saved value).
    assert %{"media" => %{"enabled" => false}} = ServerConfig.effective_document()

    assert {:ok, %{changed: changed, restart_required: false}} =
             ServerConfig.save(%{"media" => %{"enabled" => true}})

    assert "media.enabled" in changed
    assert Config.media_enabled?() == true
  end
end
