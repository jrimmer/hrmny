defmodule Cytale.Notifications.PushMetricsTest do
  @moduledoc """
  7.12 — web push is OFF unless BOTH VAPID halves are configured, and the only
  signal used to be silence (`Delivery.Log` sends nothing). The
  `cytale_push_enabled` gauge makes that state readable. This pins that it
  reflects the CONFIGURED sender, is always present (0 included — an absent 0
  must not be confusable with a failed scrape), and reaches the real scrape
  surface.
  """

  # async: false — the test writes the global `Delivery` implementation.
  use ExUnit.Case, async: false

  alias Cytale.Notifications.Delivery
  alias Cytale.Notifications.PushMetrics

  setup do
    original = Application.get_env(:cytale, Delivery)
    on_exit(fn -> restore(original) end)
    :ok
  end

  test "1 with the push sender configured, 0 when notifications are only logged" do
    Application.put_env(:cytale, Delivery, Delivery.Push)
    assert PushMetrics.enabled?()
    assert PushMetrics.exposition() =~ "# TYPE cytale_push_enabled gauge"
    assert PushMetrics.exposition() =~ ~r/^cytale_push_enabled 1$/m

    Application.put_env(:cytale, Delivery, Delivery.Log)
    refute PushMetrics.enabled?()
    assert PushMetrics.exposition() =~ ~r/^cytale_push_enabled 0$/m
  end

  test "the family reaches the real /metrics exposition (0 rendered, not omitted)" do
    Application.put_env(:cytale, Delivery, Delivery.Log)

    body = CytaleWeb.MetricsController.exposition()

    assert body =~ "# HELP cytale_push_enabled"
    assert body =~ ~r/^cytale_push_enabled 0$/m
  end

  test "the same exposition reads 1 once the real sender is configured" do
    Application.put_env(:cytale, Delivery, Delivery.Push)

    assert CytaleWeb.MetricsController.exposition() =~ ~r/^cytale_push_enabled 1$/m
  end

  defp restore(nil), do: Application.delete_env(:cytale, Delivery)
  defp restore(value), do: Application.put_env(:cytale, Delivery, value)
end
