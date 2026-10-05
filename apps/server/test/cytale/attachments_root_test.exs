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

  test "blob paths ride the configured root" do
    Application.put_env(:cytale, :attachments_root, "/data/attachments")

    assert Store.path("abc") == "/data/attachments/abc"
  end
end
