defmodule Cytale.ConfigAccessorsTest do
  @moduledoc """
  7.8 — the config accessor surface for schema-backed keys is GENERATED from
  `Cytale.ServerConfig.Schema` at compile time, so nothing re-states a key's
  storage location or default by hand. This gate proves the generated half and
  the schema half cannot diverge:

    * every `Cytale.Config.x` / `Cytale.ServerConfig.x` a CALL SITE names must
      be exported — dropping a schema `reader`, or calling an accessor that was
      never generated, fails here instead of at runtime;
    * every reader the schema DECLARES must be exported at arity 0 by its
      module, and the declared set must not shrink silently;
    * each declared reader must actually READ the key's storage location and
      fall back to the key's schema default — the drift shape behind 1.6 (an
      accessor reading a different scope AND key than the writer) fails here.

  The call-site scan parses the AST, resolving `alias Cytale.Config` under any
  local name, and understands a literal `apply(Cytale.Config, :fun, [])`, so
  both spellings are checked.
  """

  # async: false — the storage-location test writes global `:cytale` app env
  # (the whole point: it proves the reader reads THAT location), and app env is
  # VM-global. Same posture as server_config_test.
  use ExUnit.Case, async: false

  alias Cytale.ServerConfig.Schema

  @modules [Cytale.Config, Cytale.ServerConfig]

  @source_globs ["lib/**/*.ex", "test/**/*.exs", "test/**/*.ex", "config/*.exs"]

  test "every accessor a call site names is exported (spec/call-site divergence fails)" do
    calls = call_sites()

    assert calls != [],
           "the AST scan found no `Cytale.Config.…` / `Cytale.ServerConfig.…` call sites at " <>
             "all — the source globs are wrong and this gate would pass vacuously"

    missing =
      calls
      |> Enum.uniq()
      |> Enum.reject(fn {module, fun, arity} -> exported?(module, fun, arity) end)

    assert missing == [],
           "call sites name accessors that are not exported — a schema `reader` and its " <>
             "call site have diverged:\n" <> inspect(Enum.sort(missing), pretty: true)
  end

  test "every reader the schema declares is generated at arity 0" do
    declared =
      for module <- @modules, reader <- Schema.readers(module), do: {module, reader.fun}

    assert length(declared) >= 20,
           "the schema reader table unexpectedly shrank to #{length(declared)} entries: " <>
             inspect(declared)

    missing = Enum.reject(declared, fn {module, fun} -> exported?(module, fun, 0) end)

    assert missing == [],
           "the schema declares readers that were not generated:\n" <>
             inspect(Enum.sort(missing), pretty: true)
  end

  test "each generated reader reads the key's own storage location and default" do
    readers = for module <- @modules, reader <- Schema.readers(module), do: {module, reader}

    for {module, reader} <- readers do
      Code.ensure_loaded?(module)
      slot = reader.scope || reader.key
      original = Application.fetch_env(:cytale, slot)

      # The sentinel is visible ONLY if the reader reads the declared location.
      sentinel = sentinel(reader)
      put_location(reader, sentinel)

      assert apply(module, reader.fun, []) == sentinel,
             "#{inspect(module)}.#{reader.fun}() did not read #{inspect(slot)} — it reads a " <>
               "different scope/key than the schema declares"

      # With the location unset, the reader must fall back to the schema default.
      clear_location(reader)

      assert apply(module, reader.fun, []) == expected_default(reader),
             "#{inspect(module)}.#{reader.fun}() did not fall back to the schema default " <>
               "#{inspect(reader.default)}"

      restore(slot, original)
    end
  end

  # -- call-site scan ---------------------------------------------------------------

  defp call_sites do
    @source_globs
    |> Enum.flat_map(&Path.wildcard/1)
    |> Enum.flat_map(&file_calls/1)
  end

  defp file_calls(path) do
    case Code.string_to_quoted(File.read!(path), file: path) do
      {:ok, ast} ->
        aliases = aliases(ast)
        {_ast, calls} = Macro.prewalk(ast, [], fn node, acc -> collect(node, acc, aliases) end)
        calls

      {:error, error} ->
        flunk("could not parse #{path} to scan its accessor calls: #{inspect(error)}")
    end
  end

  defp collect(node, acc, aliases) do
    case node do
      {{:., _, [{:__aliases__, _, segments}, fun]}, _, args}
      when is_atom(fun) and is_list(args) ->
        {node, record(acc, resolve(segments, aliases), fun, length(args))}

      {:apply, _, [{:__aliases__, _, segments}, fun, args]}
      when is_atom(fun) and is_list(args) ->
        {node, record(acc, resolve(segments, aliases), fun, length(args))}

      _ ->
        {node, acc}
    end
  end

  defp record(acc, [:Cytale, :Config], fun, arity), do: [{Cytale.Config, fun, arity} | acc]

  defp record(acc, [:Cytale, :ServerConfig], fun, arity),
    do: [{Cytale.ServerConfig, fun, arity} | acc]

  defp record(acc, _other, _fun, _arity), do: acc

  # Local alias name => full segments, for `alias X.Y.Z` / `alias X.Y.Z, as: A`.
  defp aliases(ast) do
    {_ast, map} =
      Macro.prewalk(ast, %{}, fn
        {:alias, _, [{:__aliases__, _, segments} | rest]} = node, acc ->
          {node, Map.put(acc, [alias_name(segments, rest)], segments)}

        node, acc ->
          {node, acc}
      end)

    map
  end

  defp alias_name(segments, [opts]) when is_list(opts) do
    case Keyword.get(opts, :as) do
      {:__aliases__, _, [name]} -> name
      _ -> List.last(segments)
    end
  end

  defp alias_name(segments, _rest), do: List.last(segments)

  defp resolve(segments, aliases), do: Map.get(aliases, segments, segments)

  # function_exported?/3 does NOT autoload the module it is asked about.
  defp exported?(module, fun, arity) do
    Code.ensure_loaded?(module) and function_exported?(module, fun, arity)
  end

  # -- reader exercises -------------------------------------------------------------

  defp sentinel(%{transform: :present}), do: "  sentinel-7.8  "
  defp sentinel(_reader), do: :sentinel_7_8

  defp expected_default(%{transform: :present, default: default}), do: present(default)
  defp expected_default(%{default: default}), do: default

  defp present(value) when is_binary(value) do
    if String.trim(value) == "", do: nil, else: value
  end

  defp present(other), do: other

  defp put_location(%{scope: nil, key: key}, value), do: Application.put_env(:cytale, key, value)

  defp put_location(%{scope: scope, key: key}, value),
    do: Application.put_env(:cytale, scope, [{key, value}])

  defp clear_location(%{scope: nil, key: key}), do: Application.delete_env(:cytale, key)
  defp clear_location(%{scope: scope}), do: Application.delete_env(:cytale, scope)

  defp restore(slot, {:ok, value}), do: Application.put_env(:cytale, slot, value)
  defp restore(slot, :error), do: Application.delete_env(:cytale, slot)
end
