defmodule Mix.Tasks.Protocol.Manifest do
  @moduledoc """
  Emits the gateway protocol manifest — the SERVER's view of the wire contract
  — as committed, deterministic JSON at `packages/protocol/manifest.json`.

  Hardening plan 6.6: before this task, `tools/protocol-check.ts` compared the
  TypeScript package against the human docs and read ZERO Elixir, so renaming a
  server event or a payload field passed green. The manifest is the missing
  third party in that comparison: it is derived from the server sources, and
  `tools/protocol-check.ts` diffs BOTH the package and the docs against it.

  What is emitted:

    * `opcodes` — name → numeric code. The names/codes are reflected from the
      compiled `Cytale.Gateway.Opcode` table, so a value change is caught, never
      transcribed twice.
    * `events` — event name → sorted top-level payload field names. Names come
      from the server's actual emission sites (dispatch tuple literals
      `{"EventName", …}`, `:name -> "EventName"` sink tables, `@…event
      "EventName"` attributes, and the `t:`/`d:` fields of the READY/RESUMED
      lifecycle frames). Fields come from the payload expression at each site:
      inline map literals, `Map.put`/`Map.merge` additions, and the builder
      function that produces the payload — including its piped helper calls and
      every function clause.

  The extraction is AST-based (`Code.string_to_quoted!/2`), not regex-based:
  every map literal contributes only its OWN top-level keys, so nested maps
  (attachments, referenced messages, roster entries) never leak their fields
  into the event's field list.

  Usage (from `apps/server`, or the repo root):

      mix protocol.manifest            # write packages/protocol/manifest.json
      mix protocol.manifest --check    # regenerate in memory and diff the file
      mix protocol.manifest --stdout   # print without touching the tree

  `--check` is what makes the gate live: it fails when the server source no
  longer produces the committed manifest, so a server-side rename cannot pass
  by leaving the JSON untouched.

  The output is deterministic by construction (events and fields sorted; a
  hand-rolled encoder rather than a map-order-dependent one), so the committed
  file only churns when the contract actually moves.
  """

  use Mix.Task

  @shortdoc "Writes/checks the server-derived gateway protocol manifest"

  @manifest_rel "packages/protocol/manifest.json"

  # Strict CamelCase: a protocol event name (at least one lowercase letter, no
  # underscores). Filters shouty constants ("ACCOUNT_DELETE", "READY"), the
  # compat dialect's upper-case spellings and CQL parameters ("bigint").
  @camel ~r/^[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]+)*$/

  @impl Mix.Task
  def run(argv) do
    {opts, _, invalid} = OptionParser.parse(argv, strict: [check: :boolean, stdout: :boolean])

    if invalid != [] do
      Mix.raise("protocol.manifest: unknown option(s) #{inspect(invalid)}")
    end

    root = repo_root()
    json = root |> manifest() |> encode()

    cond do
      opts[:stdout] -> IO.puts(json)
      opts[:check] -> check(root, json)
      true -> write(root, json)
    end
  end

  @doc """
  The manifest value for repo root `root`. Exposed for the server-side drift
  test; the committed JSON is `encode/1` applied to this.
  """
  @spec manifest(String.t()) :: %{opcodes: map(), events: map()}
  def manifest(root) do
    state = scan_sources(root)
    names = state.emissions |> Enum.map(&elem(&1, 0)) |> MapSet.new() |> Enum.sort()

    %{
      opcodes: opcodes(),
      events: Map.new(names, fn name -> {name, fields_for(name, state)} end)
    }
  end

  @doc "Deterministic pretty JSON for a manifest value."
  @spec encode(%{opcodes: map(), events: map()}) :: String.t()
  def encode(%{opcodes: opcodes, events: events}) do
    opcode_lines =
      opcodes
      |> Enum.sort()
      |> Enum.map_join(",\n", fn {name, code} -> ~s(    "#{name}": #{code}) end)

    event_lines =
      events
      |> Enum.sort()
      |> Enum.map_join(",\n", fn {name, fields} ->
        rendered = fields |> Enum.sort() |> Enum.map_join(", ", &~s("#{&1}"))
        ~s(    "#{name}": [#{rendered}])
      end)

    """
    {
      "opcodes": {
    #{opcode_lines}
      },
      "events": {
    #{event_lines}
      }
    }
    """
  end

  # -- Repository layout ---------------------------------------------------------

  defp repo_root do
    cwd = File.cwd!()

    [cwd, Path.expand("../..", cwd)]
    |> Enum.find(&File.dir?(Path.join(&1, "packages/protocol")))
    |> case do
      nil ->
        Mix.raise(
          "protocol.manifest: cannot find packages/protocol from #{cwd} — " <>
            "run it from apps/server or the repo root"
        )

      root ->
        root
    end
  end

  defp write(root, json) do
    path = Path.join(root, @manifest_rel)
    File.mkdir_p!(Path.dirname(path))
    File.write!(path, json)
    Mix.shell().info("protocol.manifest: wrote #{@manifest_rel}")
  end

  defp check(root, json) do
    case File.read(Path.join(root, @manifest_rel)) do
      {:ok, ^json} ->
        Mix.shell().info("protocol.manifest: #{@manifest_rel} is current")

      {:ok, _stale} ->
        Mix.raise(
          "protocol.manifest: #{@manifest_rel} is STALE — the server source no longer " <>
            "produces the committed manifest. Regenerate it with `mix protocol.manifest` " <>
            "and review the diff (a server event/payload change is a wire-contract change)."
        )

      {:error, _} ->
        Mix.raise("protocol.manifest: #{@manifest_rel} is missing — run `mix protocol.manifest`")
    end
  end

  # -- Opcodes (reflected, never transcribed) ------------------------------------

  # `Opcode.all/0` IS the table, so there is no numeric ceiling here to drift
  # past: this used to scan `0..64`, which would have dropped a 65th opcode
  # from the manifest silently (it could only have surfaced as the confusing
  # reverse complaint, "the package ships an opcode the manifest lacks").
  defp opcodes do
    for {name, code} <- Cytale.Gateway.Opcode.all(), into: %{} do
      {Atom.to_string(name), code}
    end
  end

  # -- Source scan ---------------------------------------------------------------

  defp scan_sources(root) do
    root
    |> Path.join("apps/server/lib/**/*.ex")
    |> Path.wildcard()
    |> Enum.sort()
    |> Enum.reduce(initial_state(), fn path, state ->
      ctx = %{state: state, module: nil, file: path, env: %{}}
      ctx = path |> File.read!() |> parse!(path) |> walk(ctx)
      ctx.state
    end)
  end

  defp initial_state, do: %{functions: %{}, aliases: %{}, emissions: []}

  defp parse!(source, path) do
    Code.string_to_quoted!(source, file: path, columns: true)
  end

  # -- AST walk: modules, functions, aliases, emission sites ---------------------

  # Modules nest (`Cytale.Calls.Events.Sink`); the parent module is part of the
  # full name, so the walker carries it in `ctx.module` and concats.
  defp walk({:defmodule, _, [alias_ast, [do: body]]}, ctx) do
    module = resolve_module(alias_ast, ctx)
    walk(body, %{ctx | module: module, env: %{}})
  end

  defp walk({:def, _, [head, [do: body]]}, ctx), do: walk_function(head, body, ctx)
  defp walk({:defp, _, [head, [do: body]]}, ctx), do: walk_function(head, body, ctx)

  defp walk({:alias, _, args} = node, ctx) do
    ctx = record_alias(args, ctx)
    walk_children(node, ctx)
  end

  # `{"EventName", payload}` — the dispatch tuple every origin publishes. A
  # two-element tuple literal quotes to a bare `{a, b}` (only 3+-element tuples
  # use `{:{}, …}`), so both shapes are handled. `event_payload?/1` keeps
  # non-payload tuples (`{"POST", [key | _]}`) out.
  defp walk({name, payload} = node, ctx) when is_binary(name) do
    ctx = maybe_emit_tuple(ctx, name, payload)
    walk_children(node, ctx)
  end

  defp walk({:{}, _, [name, payload]} = node, ctx) when is_binary(name) do
    ctx = maybe_emit_tuple(ctx, name, payload)
    walk_children(node, ctx)
  end

  # `:call_start -> "CallStart"` — the calls sink's atom→name table. The
  # payload is built beside the name and resolved by convention afterwards.
  defp walk({:->, _, [_lhs, name]} = node, ctx) when is_binary(name) do
    ctx = if Regex.match?(@camel, name), do: add_emission(ctx, name, nil), else: ctx
    walk_children(node, ctx)
  end

  # `@ring_event "CallRing"` — an attribute naming an event.
  defp walk({:@, _, [{_attr, _, [name]}]} = node, ctx) when is_binary(name) do
    ctx = if Regex.match?(@camel, name), do: add_emission(ctx, name, nil), else: ctx
    walk_children(node, ctx)
  end

  # Lifecycle frames carry `t:` + `d:` in a map or keyword list. Map entries
  # are walked key-first rather than as a tuple, so a CamelCase map KEY (the
  # compat dialect's `"MessageCreate" => @intent…` table) is never mistaken
  # for a dispatch tuple.
  defp walk({:%{}, _, kvs} = _node, ctx) do
    ctx = record_lifecycle(kvs, ctx)

    Enum.reduce(kvs, ctx, fn
      {key, value}, acc -> walk(value, walk(key, acc))
      _other, acc -> acc
    end)
  end

  defp walk(list, ctx) when is_list(list) do
    ctx = record_lifecycle(list, ctx)
    Enum.reduce(list, ctx, &walk(&1, &2))
  end

  defp walk({a, b}, ctx), do: walk(b, walk(a, ctx))

  defp walk({_form, _meta, args}, ctx) when is_list(args) do
    Enum.reduce(args, ctx, &walk(&1, &2))
  end

  defp walk(_leaf, ctx), do: ctx

  defp walk_children({_form, _meta, args}, ctx) when is_list(args) do
    Enum.reduce(args, ctx, &walk(&1, &2))
  end

  defp walk_children({a, b}, ctx), do: walk(b, walk(a, ctx))
  defp walk_children(_leaf, ctx), do: ctx

  defp walk_function(head, body, ctx) do
    {fun, params} = split_head(head)

    if is_atom(fun) do
      clause = %{params: params, body: body, module: ctx.module, file: ctx.file}
      state = put_function(ctx.state, ctx.module, fun, length(params), clause)
      walk(body, %{ctx | state: state, env: assign_env(body)})
    else
      walk(body, ctx)
    end
  end

  defp split_head({:when, _, [head, _guard]}), do: split_head(head)
  defp split_head({name, _, params}) when is_atom(name) and is_list(params), do: {name, params}
  defp split_head(_), do: {nil, []}

  defp put_function(state, module, fun, arity, clause) do
    key = {module, fun, arity}
    %{state | functions: Map.update(state.functions, key, [clause], &(&1 ++ [clause]))}
  end

  defp record_alias([{:__aliases__, _, parts}], ctx) do
    put_alias(ctx, List.last(parts), Module.concat(parts))
  end

  defp record_alias([{:__aliases__, _, parts}, opts], ctx) when is_list(opts) do
    case Keyword.get(opts, :as) do
      {:__aliases__, _, [as_name]} -> put_alias(ctx, as_name, Module.concat(parts))
      _ -> put_alias(ctx, List.last(parts), Module.concat(parts))
    end
  end

  defp record_alias(_args, ctx), do: ctx

  defp put_alias(ctx, name, module) do
    aliases = Map.get(ctx.state.aliases, ctx.file, %{})

    state = %{
      ctx.state
      | aliases: Map.put(ctx.state.aliases, ctx.file, Map.put(aliases, name, module))
    }

    %{ctx | state: state}
  end

  # `t: "Ready", d: %{…}` (or the map form `%{t: …, d: …}`).
  defp record_lifecycle(kvs, ctx) do
    if is_list(kvs) and Enum.all?(kvs, &match?({_, _}, &1)) do
      with {:t, t_value} <- List.keyfind(kvs, :t, 0),
           {:d, d_value} <- List.keyfind(kvs, :d, 0) do
        Enum.reduce(camel_binaries(t_value), ctx, &add_emission(&2, &1, d_value))
      else
        _ -> ctx
      end
    else
      ctx
    end
  end

  defp camel_binaries(ast) do
    {_, names} =
      Macro.prewalk(ast, [], fn
        name, acc when is_binary(name) ->
          if Regex.match?(@camel, name), do: {name, [name | acc]}, else: {name, acc}

        node, acc ->
          {node, acc}
      end)

    Enum.reverse(names)
  end

  defp add_emission(ctx, name, payload) do
    emission = {name, payload, ctx.env, ctx.module, ctx.file}
    %{ctx | state: %{ctx.state | emissions: [emission | ctx.state.emissions]}}
  end

  defp maybe_emit_tuple(ctx, name, payload) do
    if Regex.match?(@camel, name) and event_payload?(payload) do
      add_emission(ctx, name, payload)
    else
      ctx
    end
  end

  # Only a map, a call, a variable or a pipeline can be a dispatch payload.
  # A literal list (`{"POST", [key | _]}`), atom, number or string cannot, so
  # those tuples are ordinary data, not event emissions.
  defp event_payload?(payload) do
    case payload do
      {:%{}, _, _} -> true
      {:%, _, _} -> false
      {:|>, _, _} -> true
      {:=, _, _} -> true
      {:__block__, _, _} -> true
      {:case, _, _} -> true
      {:cond, _, _} -> true
      {:if, _, _} -> true
      {:unless, _, _} -> true
      {{:., _, _}, _, args} when is_list(args) -> true
      {fun, _, args} when is_atom(fun) and is_list(args) -> true
      {name, _, context} when is_atom(name) and is_atom(context) -> true
      _ -> false
    end
  end

  # Every binding in a function body — `=` assignments and `with`/`for`
  # `<-` matches — so a payload passed by name (`wire`, `minted.payload`)
  # resolves to its builder.
  defp assign_env(body) do
    {_, env} =
      Macro.prewalk(body, %{}, fn
        {op, _, [pattern, rhs]} = node, acc when op in [:=, :<-] ->
          {node, bind_pattern_vars(pattern, rhs, acc)}

        node, acc ->
          {node, acc}
      end)

    env
  end

  defp bind_pattern_vars(pattern, rhs, env) do
    {_, env} =
      Macro.prewalk(pattern, env, fn
        {name, _, context} = node, acc when is_atom(name) and is_atom(context) ->
          {node, Map.put(acc, name, rhs)}

        node, acc ->
          {node, acc}
      end)

    env
  end

  # -- Per-event fields ----------------------------------------------------------

  defp fields_for(name, state) do
    payloads =
      for {^name, payload, env, module, file} <- state.emissions, payload != nil do
        {payload, env, module, file}
      end

    fields =
      payloads
      |> Enum.flat_map(fn {payload, env, module, file} ->
        fields(payload, env, resolve_ctx(state, module, file))
      end)
      |> case do
        [] -> builder_fields(name, state)
        found -> found
      end

    fields |> Enum.uniq() |> Enum.sort()
  end

  # The calls sink names its events in an atom table and builds the payload
  # beside it, so the tuple scan cannot see them; there the builder is the
  # snake_cased event name (`CallStart` → `call_start/5`).
  defp builder_fields(name, state) do
    fun = name |> Macro.underscore() |> String.to_atom()

    state.functions
    |> Enum.filter(fn {{_module, f, _arity}, _clauses} -> f == fun end)
    |> Enum.flat_map(fn {{module, _f, _arity}, clauses} ->
      Enum.flat_map(clauses, fn clause ->
        fields(clause.body, %{}, resolve_ctx(state, module, clause.file))
      end)
    end)
  end

  # -- Expression → field names --------------------------------------------------

  # Resolution follows variables to their bindings and calls into builder
  # bodies, and both can cycle: a function whose parameter shares its name
  # with the caller's argument (`card_json(updated)` into `def
  # card_json(updated), do: updated |> Map.put(…)`) bound `updated` to
  # itself and resolved it forever — `mix protocol.manifest`, and the CI gate
  # behind it, hung instead of failing. So every resolution carries the
  # variables and functions already open on its path (a re-entry contributes
  # nothing new: the outer expansion already takes every clause) plus a depth
  # ceiling as the backstop, which makes termination structural rather than a
  # property of today's source tree.
  @max_resolve_depth 64

  defp resolve_ctx(state, module, file) do
    %{state: state, module: module, file: file, open: MapSet.new(), depth: 0}
  end

  # Enters one resolution step for `key` (a variable binding or a function);
  # `nil` when it is already open on this path or the path is too deep.
  defp enter(ctx, key) do
    if ctx.depth >= @max_resolve_depth or MapSet.member?(ctx.open, key) do
      nil
    else
      %{ctx | open: MapSet.put(ctx.open, key), depth: ctx.depth + 1}
    end
  end

  defp fields(ast, env, ctx) do
    case ast do
      {:%{}, _, kvs} ->
        Enum.flat_map(kvs, fn
          {:|, _, [base, updates]} -> fields(base, env, ctx) ++ map_keys(updates)
          {key, _value} -> key_name(key)
          _ -> []
        end)

      # `%Struct{}` is not a wire map.
      {:%, _, _} ->
        []

      {:|>, _, [lhs, rhs]} ->
        fields(lhs, env, ctx) ++ pipe_fields(rhs, lhs, env, ctx)

      {:=, _, [_lhs, rhs]} ->
        fields(rhs, env, ctx)

      {:__block__, _, statements} ->
        block_fields(statements, env, ctx)

      {:case, _, [_subject, [do: clauses]]} ->
        flat_clauses(clauses, env, ctx)

      {:cond, _, [[do: clauses]]} ->
        flat_clauses(clauses, env, ctx)

      {:if, _, [_condition, branches]} ->
        branch_fields(branches, env, ctx)

      {:unless, _, [_condition, branches]} ->
        branch_fields(branches, env, ctx)

      # `minted.payload` — field access on a map the enclosing function assigned
      # (a zero-arg remote call whose receiver is a local variable). Checked
      # before the generic remote-call clause.
      {{:., _, [{base, _, base_context}, key]}, _, []}
      when is_atom(base) and is_atom(base_context) and is_atom(key) ->
        dotted_fields(base, key, env, ctx)

      {{:., _, [module, fun]}, _, args} when is_list(args) ->
        call(resolve_module(module, ctx), fun, args, env, ctx)

      {fun, _, args} when is_atom(fun) and is_list(args) ->
        call(ctx.module, fun, args, env, ctx)

      {name, _, context} when is_atom(name) and is_atom(context) ->
        var_fields(name, env, ctx)

      _ ->
        []
    end
  end

  defp var_fields(name, env, ctx) do
    with rhs when rhs != nil <- Map.get(env, name),
         %{} = inner <- enter(ctx, {:var, name, rhs}) do
      fields(rhs, env, inner)
    else
      _ -> []
    end
  end

  # `base.key` where `base` is a local variable holding a builder call: find the
  # returned map's `key` entry and extract the fields of its value. This is how
  # InteractionCreate is emitted — `{"InteractionCreate", minted.payload}`, with
  # `minted` assigned `Interactions.invoke(…)`.
  defp dotted_fields(base, key, env, ctx) do
    case Map.get(env, base) do
      nil -> []
      rhs -> entry_fields(rhs, key, ctx)
    end
  end

  defp entry_fields(expr, key, ctx) do
    case call_target(expr, ctx) do
      nil ->
        []

      {module, fun} ->
        ctx.state.functions
        |> Enum.filter(fn {{m, f, _arity}, _clauses} -> m == module and f == fun end)
        |> Enum.flat_map(fn {_key, clauses} ->
          Enum.flat_map(clauses, fn clause ->
            clause_ctx = %{ctx | module: clause.module, file: clause.file}
            entry_value_fields(clause.body, key, assign_env(clause.body), clause_ctx)
          end)
        end)
    end
  end

  defp call_target({{:., _, [module, fun]}, _, args}, ctx) when is_atom(fun) and is_list(args) do
    {resolve_module(module, ctx), fun}
  end

  defp call_target({fun, _, args}, ctx) when is_atom(fun) and is_list(args), do: {ctx.module, fun}
  defp call_target(_other, _ctx), do: nil

  defp entry_value_fields(body, key, env, ctx) do
    {_, matches} =
      Macro.prewalk(body, [], fn
        {:%{}, _, kvs} = node, acc ->
          case entry_value(kvs, key) do
            nil -> {node, acc}
            value -> {node, [value | acc]}
          end

        node, acc ->
          {node, acc}
      end)

    case matches do
      [] -> []
      [last | _rest] -> fields(last, env, ctx)
    end
  end

  defp entry_value(kvs, key) do
    Enum.find_value(kvs, fn
      {k, value} -> if key_name(k) == [Atom.to_string(key)], do: value
      _ -> nil
    end)
  end

  defp block_fields(statements, env, ctx) do
    statements
    |> List.last()
    |> case do
      nil -> []
      last -> fields(last, env, ctx)
    end
  end

  defp flat_clauses(clauses, env, ctx) do
    Enum.flat_map(clauses, fn
      {:->, _, [_patterns, body]} -> fields(body, env, ctx)
      _ -> []
    end)
  end

  defp branch_fields(branches, env, ctx) when is_list(branches) do
    branches
    |> Keyword.values()
    |> Enum.flat_map(&fields(&1, env, ctx))
  end

  defp branch_fields(_, _env, _ctx), do: []

  defp pipe_fields({fun, _, args}, lhs, env, ctx) when is_atom(fun) and is_list(args) do
    call(ctx.module, fun, [lhs | args], env, ctx)
  end

  defp pipe_fields({{:., _, [module, fun]}, _, args}, lhs, env, ctx) when is_list(args) do
    call(resolve_module(module, ctx), fun, [lhs | args], env, ctx)
  end

  defp pipe_fields(rhs, _lhs, env, ctx), do: fields(rhs, env, ctx)

  defp call(Map, :put, args, env, ctx) when length(args) >= 2 do
    fields(Enum.at(args, 0), env, ctx) ++ key_name(Enum.at(args, 1))
  end

  defp call(Map, fun, args, env, ctx) when fun in [:merge, :take] do
    Enum.flat_map(args, &fields(&1, env, ctx))
  end

  defp call(Map, :delete, args, env, ctx), do: args |> List.first() |> fields(env, ctx)

  defp call(nil, _fun, _args, _env, _ctx), do: []

  defp call(module, fun, args, env, ctx) do
    case enter(ctx, {:call, module, fun, length(args)}) do
      nil ->
        []

      inner ->
        clauses = function_clauses(module, fun, length(args), ctx)

        Enum.flat_map(clauses, fn clause ->
          clause_env = Map.merge(env, bind_params(clause.params, args, env))
          fields(clause.body, clause_env, %{inner | module: module, file: clause.file})
        end)
    end
  end

  defp function_clauses(module, fun, arity, ctx) do
    case Map.get(ctx.state.functions, {module, fun, arity}) do
      nil -> fallback_clauses(fun, ctx)
      clauses -> clauses
    end
  end

  # Local helpers reached through an alias we could not resolve: take every
  # clause with that name. Payload builders have unique snake_case names in
  # practice, so this stays precise without a full alias solver.
  defp fallback_clauses(fun, ctx) do
    ctx.state.functions
    |> Enum.filter(fn {{_module, f, _arity}, _clauses} -> f == fun end)
    |> Enum.flat_map(fn {_key, clauses} -> clauses end)
  end

  # A bare-variable argument is bound to what it names in the CALLER's env,
  # not to the variable itself: the callee's env is layered over the caller's,
  # so `f(updated)` into `def f(updated)` would otherwise bind `updated` to
  # itself and lose the caller's binding.
  defp bind_params(params, args, caller_env) do
    params
    |> Enum.zip(args)
    |> Enum.reduce(%{}, fn {param, arg}, env -> bind(param, deref(arg, caller_env), env) end)
  end

  defp deref({name, _, context} = arg, caller_env) when is_atom(name) and is_atom(context) do
    Map.get(caller_env, name, arg)
  end

  defp deref(arg, _caller_env), do: arg

  defp bind({:\\, _, [param, _default]}, arg, env), do: bind(param, arg, env)

  defp bind({name, _, context}, arg, env) when is_atom(name) and is_atom(context),
    do: Map.put(env, name, arg)

  defp bind(_pattern, _arg, env), do: env

  defp resolve_module({:__aliases__, _, [first | rest]}, ctx) do
    aliases = Map.get(ctx.state.aliases, ctx.file, %{})
    base = Map.get(aliases, first, Module.concat([first]))
    Module.concat([base | rest])
  end

  defp resolve_module({:__MODULE__, _, _}, ctx), do: ctx.module
  defp resolve_module(module, _ctx) when is_atom(module), do: module
  defp resolve_module(_other, _ctx), do: nil

  # -- Map keys ------------------------------------------------------------------

  defp map_keys(kvs) do
    Enum.flat_map(kvs, fn
      {key, _value} -> key_name(key)
      _ -> []
    end)
  end

  defp key_name(key) when is_binary(key), do: [key]

  defp key_name(key) when is_atom(key) and key not in [nil, true, false],
    do: [Atom.to_string(key)]

  defp key_name(_other), do: []
end
