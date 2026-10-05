defmodule CytaleWeb.StaticAllowlistTest do
  @moduledoc """
  Every file the service worker pulls in with `importScripts` must be reachable
  through `Plug.Static`'s `only:` allowlist.

  WHY THIS EXISTS (2026-09-15 incident): `push-handler.js` lives in the SPA's
  `public/` and is imported by the generated worker. It was never added to the
  allowance, so the app served a 404 for it — a JSON error body carrying
  `X-Content-Type-Options: nosniff`, which the browser refuses as a script. The
  worker therefore could not finish installing, `navigator.serviceWorker.controller`
  was null, and **every push was delivered to a worker with no push handler and
  silently discarded.**

  The failure was invisible from every angle we looked from:

    * the server logged `push sent` — the push service accepted it;
    * the browser held a real subscription and the endpoint matched our row;
    * display worked when invoked directly from the console;
    * a page reload simply re-registered the same broken worker.

  Nothing pointed at a 404 for a file nobody thought to request. `Plug.Static`
  has no failure mode louder than "not found", so the only durable guard is a
  test that reads the worker's own imports and checks each one against the
  allowlist.
  """

  use ExUnit.Case, async: true

  # The allowance is a literal in the plug declaration; reading it from source
  # keeps this test honest about what the RUNNING config says rather than
  # restating it.
  @endpoint_source "lib/cytale_web/endpoint.ex"

  defp declared_static_entries do
    source = File.read!(@endpoint_source)

    # `only:` holds plain filenames or directories; `only_matching:` holds
    # prefixes. Collect both, since a match in either serves the file.
    plain =
      case Regex.run(~r/only:\s*\[(.*?)\]/s, source) do
        [_, body] -> Regex.scan(~r/"([^"]+)"/, body) |> List.flatten() |> Enum.drop_every(2)
        _ -> []
      end

    prefixes =
      case Regex.run(~r/only_matching:\s*\[(.*?)\]/s, source) do
        [_, body] -> Regex.scan(~r/"([^"]+)"/, body) |> List.flatten() |> Enum.drop_every(2)
        _ -> []
      end

    {plain, prefixes}
  end

  # The imports are declared by the BUILD CONFIG, which is what emits
  # `importScripts(...)` into the generated worker. Read from there rather than
  # from the built sw.js (a gitignored artifact, absent in a bare checkout) and
  # rather than from the handler itself (which imports nothing — it IS the
  # import).
  defp import_scripts_targets do
    case File.read("../web/vite.config.ts") do
      {:ok, source} ->
        Regex.scan(~r/importScripts:\s*\[([^\]]*)\]/s, source)
        |> Enum.map(fn [_, body] -> body end)
        |> Enum.flat_map(&Regex.scan(~r/['"]([^'"]+)['"]/, &1))
        |> List.flatten()
        |> Enum.drop_every(2)
        |> Enum.map(&Path.basename/1)

      {:error, _} ->
        []
    end
  end

  test "every importScripts target in the push handler is served by Plug.Static" do
    {plain, prefixes} = declared_static_entries()
    targets = import_scripts_targets()

    # A guard against the test silently passing because it found nothing to
    # check — which is exactly how the original omission went unnoticed.
    assert targets != [],
           "expected at least one workbox.importScripts entry in vite.config.ts; " <>
             "if the worker no longer imports anything, delete this test deliberately"

    for target <- targets do
      served? =
        Enum.any?(plain, fn entry -> entry == target or String.starts_with?(target, entry <> "/") end) or
          Enum.any?(prefixes, fn prefix -> String.starts_with?(target, prefix) end)

      assert served?,
             "#{target} is imported by the service worker but is NOT in Plug.Static's " <>
               "allowlist, so the app will 404 it and the worker will fail to install. " <>
               "Add it to the `only:` list in #{@endpoint_source}."
    end
  end

  test "the push handler is itself served (the exact file the incident 404d)" do
    {plain, prefixes} = declared_static_entries()

    assert "push-handler.js" in plain or
             Enum.any?(prefixes, &String.starts_with?("push-handler.js", &1)),
           "push-handler.js must be in the static allowlist — its absence breaks push entirely"
  end

  test "the release notes the version badge opens are served" do
    # scripts/release-notes.mjs writes it into the SPA's public/ at build time;
    # off the allowlist, the SPA fallback answers index.html and the notes
    # pane can only say the build has none.
    {plain, _prefixes} = declared_static_entries()
    assert "release-notes.json" in plain
  end
end
