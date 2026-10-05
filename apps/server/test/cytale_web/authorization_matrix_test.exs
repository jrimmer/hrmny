defmodule CytaleWeb.AuthorizationMatrixTest do
  @moduledoc """
  The default-deny completeness gate (#35 P0-1 / S-P3-16): every route whose
  path carries a sensitive resource param MUST carry a declaration in
  `CytaleWeb.AuthorizationMatrix`, and pipeline-backed declarations must
  match the route's ACTUAL pipelines (resolved via `Phoenix.Router.route_info/
  4`). A new sensitive route fails here until its gate is declared — the
  router convention that would have caught the #35 IDOR family at review.
  """

  use ExUnit.Case, async: true

  alias CytaleWeb.AuthorizationMatrix

  test "every sensitive route is declared in the matrix" do
    declared = AuthorizationMatrix.declarations()

    undeclared =
      sensitive_routes()
      |> Enum.reject(&Map.has_key?(declared, &1.key))

    assert undeclared == [],
           "sensitive route(s) without an authorization-matrix declaration — declare the " <>
             "gate in CytaleWeb.AuthorizationMatrix (or fix the route): \n" <>
             Enum.map_join(undeclared, "\n", &"  #{&1.key} -> #{&1.plug}.#{&1.plug_opts}")
  end

  test "pipeline-backed declarations match the routes' actual pipelines" do
    for {key, {:pipelines, expected, _note}} <- AuthorizationMatrix.declarations() do
      assert {:ok, info} = route_info(key),
             "declared route #{key} no longer matches the router"

      missing = expected -- info.pipe_through

      assert missing == [],
             "route #{key} declares pipelines #{inspect(expected)} but actually pipes through " <>
               "#{inspect(info.pipe_through)} (missing #{inspect(missing)})"
    end
  end

  test "operator-backed declarations actually pipe through :operator" do
    for {key, {kind, _note}} <- AuthorizationMatrix.declarations(), kind == :operator do
      assert {:ok, info} = route_info(key), "declared route #{key} no longer matches the router"
      assert :operator in info.pipe_through, "route #{key} declares the operator gate but does not pipe through it"
    end
  end

  test "matrix declarations never point at routes that vanished" do
    keys = MapSet.new(sensitive_routes(), & &1.key)

    # Declarations beyond the sensitive set are allowed (documentation for
    # param-less routes like /admin/metrics), but only if they match SOME
    # real route shape.
    for {key, _decl} <- AuthorizationMatrix.declarations() do
      unless MapSet.member?(keys, key) do
        assert {:ok, _info} = route_info(key),
               "matrix declares #{key} but no such route exists"
      end
    end
  end

  # -- error-key vocabulary (hardening plan 6.4) --------------------------------

  @lower_snake ~r/^[a-z0-9_]+$/

  # Every emitted `error.key` is lower_snake — one casing, so a client that
  # switches on the key never has to match two spellings of one failure.
  #
  # Why a SOURCE PIN instead of driving the routes: the invariant is about
  # every key the server CAN emit. Driving ~300 endpoints would need auth,
  # permission and fixture setup per branch and would still miss every branch
  # no test happens to exercise. This walks the emission sites themselves with
  # the compiler's own AST, so it is exhaustive over the tree instead of over
  # what a run happened to touch. It reads the five literal positions a key is
  # emitted in:
  #
  #   1. `CytaleWeb.API.Error.error(conn, status, "key", "message")`
  #   2. the backup controller's `errors/4` sibling
  #   3. the SSH controller's audited `refuse/5` wrapper call sites
  #   4. a hand-built envelope map (`%{"error" => %{"key" => "key", ...}}`)
  #   5. a module attribute (`@error_key "..."`) and the scoped-404 helper
  #      (`not_found_key/1`-style functions that RETURN the literal)
  test "every emitted REST error key is lower_snake" do
    keys = emitted_error_keys()

    assert length(keys) > 250,
           "the error-key scan found only #{length(keys)} literal(s); the scanner " <>
             "is too narrow to trust, not the tree"

    offenders = Enum.reject(keys, &Regex.match?(@lower_snake, &1.key))

    assert offenders == [],
           "every emitted error key must match ~r/^[a-z0-9_]+$/ (hardening plan " <>
             "6.4); #{length(offenders)} do not:\n" <>
             Enum.map_join(offenders, "\n", &"  #{&1.key}  (#{&1.file}:#{&1.line})")
  end

  # The scan above only sees a literal, so a non-literal key at `error/4`'s
  # third argument would slip past it. This fails the gate CLOSED instead: the
  # only tolerated holes are the helper's own definition/spec and a forwarder
  # whose literal call sites the scan already reads.
  @key_forwarders ~w(refuse)a

  test "every error/4 key is a literal this gate can inspect" do
    holes =
      dynamic_error_keys()
      |> Enum.reject(&(&1.fun == &1.call or is_nil(&1.fun) or &1.fun in @key_forwarders))

    assert holes == [],
           "CytaleWeb.API.Error.error/4 keys must be string literals (or reach one " <>
             "through a scanned forwarder) so the lower_snake gate can see them; " <>
             "these call sites are not:\n" <>
             Enum.map_join(holes, "\n", &"  #{&1.arg}  (#{&1.file}:#{&1.line})")
  end

  # -- helpers -------------------------------------------------------------------

  defp sensitive_routes do
    for r <- CytaleWeb.Router.__routes__(),
        Enum.any?(AuthorizationMatrix.sensitive_params(), &String.contains?(r.path, &1)) do
      %{
        key: "#{r.verb |> to_string() |> String.upcase()} #{r.path}",
        plug: r.plug,
        plug_opts: r.plug_opts
      }
    end
  end

  # "VERB /path/:param" → a concrete sample path ("1" for every param) that
  # the router can resolve, so route_info/4 yields the real pipe list.
  defp route_info(key) do
    case String.split(key, " ", parts: 2) do
      [verb, path] ->
        sample = String.replace(path, ~r/:[a-zA-Z_]+/, "1")

        case Phoenix.Router.route_info(CytaleWeb.Router, verb, sample, "cytale.test") do
          :error -> {:error, :no_match}
          info -> {:ok, info}
        end

      _ ->
        {:error, :bad_key}
    end
  end

  # -- error-key scan helpers ----------------------------------------------------

  @error_helpers ~w(error errors)a
  @key_helpers ~w(error errors refuse)a
  @attr_ignored ~w(spec doc moduledoc typedoc)a

  defp source_files do
    Path.wildcard(Path.expand("../../lib/cytale_web/**/*.ex", __DIR__))
  end

  defp emitted_error_keys do
    for %{key: key} = hit <- scan_sources(), is_binary(key), do: hit
  end

  defp dynamic_error_keys do
    for hit <- scan_sources(), not Map.has_key?(hit, :key), do: hit
  end

  defp scan_sources do
    Enum.flat_map(source_files(), fn file ->
      ast = file |> File.read!() |> Code.string_to_quoted!()
      init = %{file: Path.relative_to_cwd(file), stack: [], attrs: [], hits: []}

      {_, acc} =
        Macro.traverse(ast, init, &{&1, scan_pre(&1, &2)}, &{&1, scan_post(&1, &2)})

      acc.hits
    end)
  end

  # A function definition: remember its name for the forwarder check, and if
  # it is a scoped-key helper (`not_found_key/1`), read the literal each
  # `cond`/`case` clause returns.
  defp scan_pre({def_kind, meta, [head | _]} = node, acc)
       when def_kind in [:def, :defp] do
    name = def_name(head)
    acc = %{acc | stack: [name | acc.stack]}

    if key_function?(name) do
      hits = Enum.map(clause_keys(node), &%{key: &1, file: acc.file, line: meta[:line]})
      %{acc | hits: hits ++ acc.hits}
    else
      acc
    end
  end

  defp scan_pre({:@, meta, [{:error_key, _, [value]}]}, acc) when is_binary(value) do
    add_hit(acc, value, meta, :error_key, nil)
  end

  # `error/4` and `errors/4` take the key third; `refuse/5` forwards its third
  # argument to `error/4` (rate-limit's unrelated `refuse/8` has no literal
  # there, so it is simply not a hit).
  defp scan_pre({call, meta, args}, acc)
       when call in @key_helpers and is_list(args) and length(args) >= 4 do
    fun = List.first(acc.stack)

    case Enum.at(args, 2) do
      key when is_binary(key) ->
        add_hit(acc, key, meta, call, fun)

      expr when call in @error_helpers and acc.attrs == [] ->
        %{
          acc
          | hits: [%{arg: Macro.to_string(expr), call: call, fun: fun, file: acc.file, line: meta[:line]} | acc.hits]
        }

      _ ->
        acc
    end
  end

  # The hand-built envelope map. Restricted to maps that also carry a
  # `"code"`/`"message"`/`"reason"` so an unrelated `%{"key" => ...}` (e.g.
  # the push VAPID key) is not mistaken for an error.
  defp scan_pre({:%{}, meta, pairs}, acc) when is_list(pairs) do
    if error_envelope?(pairs) do
      case List.keyfind(pairs, "key", 0) do
        {_, value} when is_binary(value) -> add_hit(acc, value, meta, :envelope, nil)
        _ -> acc
      end
    else
      acc
    end
  end

  # `@spec`/`@doc` are not emission sites — and the `error/4` @spec would
  # otherwise look like a dynamic key.
  defp scan_pre({:@, _, [{name, _, _}]}, acc) when name in @attr_ignored do
    %{acc | attrs: [name | acc.attrs]}
  end

  defp scan_pre(_node, acc), do: acc

  defp scan_post({def_kind, _, _}, acc) when def_kind in [:def, :defp], do: pop(acc, :stack)
  defp scan_post({:@, _, [{name, _, _}]}, acc) when name in @attr_ignored, do: pop(acc, :attrs)
  defp scan_post(_node, acc), do: acc

  defp pop(acc, field) do
    case Map.fetch!(acc, field) do
      [_ | rest] -> Map.put(acc, field, rest)
      [] -> acc
    end
  end

  defp add_hit(acc, key, meta, call, fun) do
    hit = %{key: key, call: call, fun: fun, file: acc.file, line: meta[:line]}
    %{acc | hits: [hit | acc.hits]}
  end

  defp error_envelope?(pairs) do
    List.keymember?(pairs, "key", 0) and
      (List.keymember?(pairs, "code", 0) or List.keymember?(pairs, "message", 0) or
         List.keymember?(pairs, "reason", 0))
  end

  # The literal each `->` clause of a scoped-key helper returns (the
  # `path_param(conn, "channel_id") -> "channel_not_found"` shape).
  defp clause_keys(node) do
    {_, keys} =
      Macro.prewalk(node, [], fn
        {:->, _, [_patterns, body]} = clause, acc -> {clause, binaries_in(body) ++ acc}
        other, acc -> {other, acc}
      end)

    Enum.reverse(keys)
  end

  defp binaries_in(ast) do
    {_, literals} =
      Macro.prewalk(ast, [], fn
        literal, acc when is_binary(literal) -> {literal, [literal | acc]}
        other, acc -> {other, acc}
      end)

    literals
  end

  defp key_function?(name) when is_atom(name), do: String.ends_with?(Atom.to_string(name), "_key")
  defp key_function?(_), do: false

  defp def_name({:when, _, [head | _]}), do: def_name(head)
  defp def_name({name, _, _}) when is_atom(name), do: name
  defp def_name(_), do: nil
end
