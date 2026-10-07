defmodule Cytale.AttachmentsRootTest do
  @moduledoc """
  The attachment blob root is configurable so container deploys can point it at
  the mounted volume. Getting this wrong is silent data loss: the release's own
  `priv/` is the container's writable layer, so uploads vanish on every
  `docker compose up -d` while the DB keeps returning the hash (404 on GET).
  """

  use ExUnit.Case, async: false

  alias Cytale.Attachments.Store
  alias Cytale.Config

  setup do
    previous = Application.get_env(:cytale, :attachments_root)

    on_exit(fn ->
      if previous,
        do: Application.put_env(:cytale, :attachments_root, previous),
        else: Application.delete_env(:cytale, :attachments_root)
    end)

    :ok
  end

  test "unset keeps the release's own priv/attachments" do
    Application.delete_env(:cytale, :attachments_root)
    expected = Path.join(Application.app_dir(:cytale, "priv"), "attachments")

    assert Config.attachments_root() == expected
    assert Store.root() == expected
  end

  test "a configured root wins — this is the container volume" do
    Application.put_env(:cytale, :attachments_root, "/app/priv/attachments")

    assert Config.attachments_root() == "/app/priv/attachments"
    assert Store.root() == "/app/priv/attachments"
  end

  test "a blank value falls back to the default (unset env var)" do
    Application.put_env(:cytale, :attachments_root, "")

    assert Config.attachments_root() ==
             Path.join(Application.app_dir(:cytale, "priv"), "attachments")
  end

  describe "the boot check" do
    import ExUnit.CaptureLog

    @tag :tmp_dir
    test "a writable root passes and leaves no probe behind", %{tmp_dir: tmp} do
      dir = Path.join(tmp, "attachments")
      Application.put_env(:cytale, :attachments_root, dir)

      assert Store.probe_writable(dir) == :ok
      assert File.ls!(dir) == []
      refute capture_log(fn -> assert Store.log_root_status() == :ok end) =~ "not writable"
    end

    # Under a regular file, so it fails even as root (CI and the dev VMs run
    # as root, where a chmod-ed directory would still be writable).
    @tag :tmp_dir
    test "an unwritable root is logged as an error, never raised", %{tmp_dir: tmp} do
      file = Path.join(tmp, "not-a-dir")
      File.write!(file, "")
      dir = Path.join(file, "attachments")
      Application.put_env(:cytale, :attachments_root, dir)

      assert {:error, _reason} = Store.probe_writable(dir)

      log = capture_log(fn -> assert Store.log_root_status() == :ok end)
      assert log =~ "attachment storage is not writable at #{dir}"
      assert log =~ "CYTALE_ATTACHMENTS_ROOT"
    end
  end

  test "blob paths ride the configured root" do
    Application.put_env(:cytale, :attachments_root, "/data/attachments")

    assert Store.path("abc") == "/data/attachments/abc"
  end
end
