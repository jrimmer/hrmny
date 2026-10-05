defmodule Cytale.ConfigOwnershipTest do
  @moduledoc """
  7.9 — `config/runtime.exs` runs LAST, in every environment, and writes some
  paths UNCONDITIONALLY. A default for one of those paths in
  `config/config.exs` is therefore silently discarded: editing config.exs has
  zero effect, which is a trap, not a configuration. The dead copies were
  deleted and the defaults now live once, in the runtime env read. This gate
  keeps that true in BOTH directions:

    * a runtime-owned path must not reappear in config.exs (otherwise it is
      dead config again);
    * a config-owned path must stay out of runtime.exs (otherwise a new
      unconditional write silently kills a live default).

  Textual, like the 1.6 wiring gate next door: the effective app env of a test
  VM cannot show what a file-level overwrite discarded. Comments are stripped,
  so a path named only to document the split does not count as a statement of
  it.
  """

  use ExUnit.Case, async: true

  @config_path "config/config.exs"
  @runtime_path "config/runtime.exs"

  # App-env paths `config/runtime.exs` writes in EVERY env: the literal default
  # on its env read IS the one stated default. Keep in step with the block
  # comment at the top of config/config.exs.
  @runtime_owned [
    "external_base_url",
    "resume_window_target_ms",
    "resume_window_floor_ms",
    "access_token_ttl_ms",
    "refresh_token_ttl_ms",
    "search_index_root",
    "search_commit_interval_ms",
    ":ssh",
    "session_bridge"
  ]

  # App-env paths config.exs owns because runtime.exs never writes them.
  @config_owned [
    "fan_out_shed_threshold",
    "attempt_guard_max_failures",
    "attempt_guard_window_ms",
    "attempt_guard_lock_ms",
    "attempt_guard_identifier_max_failures",
    "attempt_guard_known_ip_ttl_ms",
    "search_rebuild_page_size",
    "search_drift_sample_limit",
    "search_drift_content_limit",
    "rate_limit_ip_ceilings"
  ]

  setup_all do
    %{
      config: code_only(File.read!(@config_path)),
      runtime: code_only(File.read!(@runtime_path))
    }
  end

  test "runtime-owned paths are stated once — in runtime.exs, never in config.exs", %{
    config: config,
    runtime: runtime
  } do
    for token <- @runtime_owned do
      assert runtime =~ token,
             "#{@runtime_path} no longer writes `#{token}`, so this ownership list is " <>
               "stale — update it (and the config.exs header) before trusting the split"

      refute config =~ token,
             "#{@config_path} states `#{token}`, but config/runtime.exs writes that path " <>
               "UNCONDITIONALLY in every env, so the config.exs value is discarded and " <>
               "editing config.exs has zero effect. Delete the config.exs copy (keep the " <>
               "single default in runtime.exs) or make the runtime write conditional."
    end
  end

  test "config-owned defaults are not silently overwritten by runtime.exs", %{
    config: config,
    runtime: runtime
  } do
    for token <- @config_owned do
      assert config =~ token,
             "#{@config_path} no longer states `#{token}` — the config-owned list is stale"

      refute runtime =~ token,
             "config/runtime.exs now writes `#{token}`, which config.exs also states: the " <>
               "runtime write wins and the config.exs default is dead. Move the default to " <>
               "runtime.exs (or delete it there)."
    end
  end

  # A line's CODE only: a `#` outside a double-quoted string starts a comment.
  # Small hand scanner rather than a Regex so an interpolated string
  # (`import_config "#{config_env()}.exs"`) is not truncated.
  defp code_only(source) do
    source
    |> String.split("\n")
    |> Enum.map_join("\n", &strip_comment/1)
  end

  defp strip_comment(line), do: strip_comment(line, "", false)

  defp strip_comment(<<>>, acc, _in_string), do: acc

  defp strip_comment(<<?\\, rest::binary>>, acc, true) do
    case rest do
      <<char, tail::binary>> -> strip_comment(tail, acc <> "\\" <> <<char>>, true)
      _ -> acc
    end
  end

  defp strip_comment(<<?", rest::binary>>, acc, in_string),
    do: strip_comment(rest, acc <> "\"", not in_string)

  defp strip_comment(<<?#, _rest::binary>>, acc, false), do: acc

  defp strip_comment(<<char, rest::binary>>, acc, in_string),
    do: strip_comment(rest, acc <> <<char>>, in_string)
end
