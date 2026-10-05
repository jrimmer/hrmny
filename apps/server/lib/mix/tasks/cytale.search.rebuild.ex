defmodule Mix.Tasks.Cytale.Search.Rebuild do
  @shortdoc "Check and/or rebuild a workspace's search index from ScyllaDB (#89)"

  @moduledoc """
  The CLI escape hatch for #89 — the twin of the operator HTTP surface, for the
  box where you actually need it: the degraded one, with no admin session.

  It drives exactly the code the HTTP surface drives (`Cytale.Search.Drift`,
  `Cytale.Search.Rebuild`), so the two cannot disagree about what "drift" or
  "rebuild" means.

      # what is wrong? (counts + the sampled ids; exits non-zero if dirty)
      mix cytale.search.rebuild --workspace 123456789012345678 --check

      # the common repair, after the check named some ghost ids
      mix cytale.search.rebuild --workspace 123456789012345678 --repair-orphans

      # re-index every message in the workspace, verifying the result
      mix cytale.search.rebuild --workspace 123456789012345678

      # more ids per side than the default 500
      mix cytale.search.rebuild --workspace 123456789012345678 --sample 2000

  Options:

    * `--workspace` (required) — the snowflake id of the workspace.
    * `--check` — report only, do not rebuild.
    * `--repair-orphans` — unindex the orphaned ids the check finds, then
      report again. Combine with `--check` to stop there.
    * `--sample N` — ids examined per side (default: the configured 500).

  The endpoint is disabled before the app boots, so this never takes the HTTP
  port from a running node.
  """

  use Mix.Task

  alias Cytale.Search.{Drift, Rebuild}

  @impl true
  def run(argv) do
    {opts, _, invalid} =
      OptionParser.parse(argv,
        strict: [workspace: :string, check: :boolean, repair_orphans: :boolean, sample: :integer]
      )

    if invalid != [], do: Mix.raise("unknown options: #{inspect(invalid)}")

    workspace_id =
      case opts[:workspace] do
        nil -> Mix.raise("--workspace <snowflake> is required")
        raw -> parse_id(raw)
      end

    boot()

    unless Cytale.Workspaces.get_workspace(workspace_id) do
      Mix.shell().info("note: no workspace row for #{workspace_id} — reporting the index as it stands")
    end

    report = Drift.check(workspace_id, sample_limit: opts[:sample])
    print(workspace_id, report)

    if Keyword.get(opts, :repair_orphans, false) and report.orphaned.ids != [] do
      %{unindexed: n} = Drift.repair_orphans(workspace_id, report.orphaned.ids)
      Mix.shell().info("repair: unindexed #{n} orphaned document(s)")
      report = Drift.check(workspace_id, sample_limit: opts[:sample])
      print(workspace_id, report)
    end

    cond do
      Keyword.get(opts, :check, false) and not report.clean ->
        Mix.raise(
          "the check is not clean (see the report above; a truncated sample is " <>
            "not proof of anything — widen --sample and look again)"
        )

      Keyword.get(opts, :check, false) ->
        Mix.shell().info("index is clean")

      true ->
        rebuild(workspace_id, opts[:sample])
    end
  end

  defp rebuild(workspace_id, sample) do
    Mix.shell().info("rebuilding workspace #{workspace_id} (replay from message id 0)…")

    {:ok, stats} =
      Rebuild.rebuild(workspace_id,
        on_page: fn %{pages: pages, messages: messages} ->
          Mix.shell().info("  page #{pages}: #{messages} message(s) indexed so far")
        end
      )

    Mix.shell().info("rebuild: #{stats.messages} message(s) over #{stats.pages} page(s)")

    # A rebuild repairs MISSING documents and never removes orphans (nothing in
    # an upsert walk deletes), so the verification is the honest last word.
    check = Drift.check(workspace_id, sample_limit: sample)
    print(workspace_id, check)

    if check.clean do
      Mix.shell().info("index is clean")
    else
      Mix.raise("index still drifts after the rebuild — repair the ids above (or re-run with --repair-orphans)")
    end
  end

  defp print(workspace_id, report) do
    Mix.shell().info("""
    workspace #{workspace_id} (checked #{DateTime.to_iso8601(report.checked_at)})
      documents: #{report.documents.index}   messages: #{report.documents.messages}   delta: #{report.documents.delta}
      watermark: #{inspect(report.index_state.watermark)}   latest message: #{inspect(report.index_state.latest_message_id)}
      missing  : #{report.missing.count} (#{describe(report.missing)})
        #{inspect(Enum.take(report.missing.ids, 20))}
      orphaned : #{report.orphaned.count} (#{describe(report.orphaned)})
        #{inspect(Enum.take(report.orphaned.ids, 20))}
      content  : #{report.content.mismatched_count} mismatched of #{report.content.checked} checked
        #{inspect(Enum.take(report.content.mismatched_ids, 20))}
      clean    : #{report.clean}
    """)
  end

  defp describe(set) do
    truncated = if set.truncated, do: "sample truncated", else: "complete"
    "sample #{set.sampled}/#{set.sample_limit}, #{truncated}"
  end

  defp parse_id(raw) do
    case Integer.parse(raw) do
      {id, ""} when id > 0 -> id
      _ -> Mix.raise("--workspace must be a snowflake id, got #{inspect(raw)}")
    end
  end

  # Boot the app with the listener OFF: an operator running this on a live node
  # must not fight it for the HTTP port.
  defp boot do
    endpoint = Application.get_env(:cytale, CytaleWeb.Endpoint, [])
    Application.put_env(:cytale, CytaleWeb.Endpoint, Keyword.put(endpoint, :server, false))
    Mix.Task.run("app.start")
  end
end
