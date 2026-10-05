defmodule Cytale.Attachments.PublicMedia do
  @moduledoc """
  One-time backfill of the public-media markers (security Tier 2 #4).

  New avatar/icon uploads are marked public as they are stored
  (`Cytale.Attachments.Store.put/4`, `public: true`). Blobs uploaded BEFORE
  the marker existed have none, and their URLs sit verbatim on
  `users.avatar_url` / `workspaces.icon_url` — with no marker they would 404
  the moment unsigned serving stopped.

  So the first unsigned request for an unmarked blob runs this backfill ONCE
  per attachment volume: it reads every `avatar_url` and `icon_url` (a
  full-table scan of two small tables), marks each referenced blob public, and
  drops a done-file into the store's `.public/` directory so no later request
  or boot pays for it again. The scan is serialized under a `:global` lock, and
  a finished run is cached in `:persistent_term`, so the steady-state cost of
  an unsigned miss is one map lookup.

  A restore that brings back a volume without the done-file simply runs it
  again; it is idempotent.
  """

  require Logger

  alias Cytale.Attachments.Store
  alias Cytale.Repo

  @done_file "backfill-v1.done"
  @hash_re ~r"/api/v1/attachments/([0-9a-f]{64})(?:\?|\z)"

  @doc "Run the backfill unless this volume already has; always `:ok`."
  @spec ensure_backfilled() :: :ok
  def ensure_backfilled do
    if :persistent_term.get({__MODULE__, Store.root()}, false) do
      :ok
    else
      :global.trans({__MODULE__, self()}, fn -> run_once() end)
      :ok
    end
  end

  @doc false
  # Tests: forget the cached "done" for the current root.
  def reset_cache, do: :persistent_term.erase({__MODULE__, Store.root()})

  defp run_once do
    done = Path.join([Store.root(), ".public", @done_file])

    unless File.exists?(done) do
      count = backfill!()
      File.mkdir_p!(Path.dirname(done))
      File.write!(done, "#{count}\n")
      Logger.info("public media backfill: marked #{count} avatar/icon blob(s) public")
    end

    :persistent_term.put({__MODULE__, Store.root()}, true)
  rescue
    e ->
      # Never fail the request over it: the next unsigned miss retries.
      Logger.warning("public media backfill failed: #{Exception.message(e)}")
      :error
  end

  defp backfill! do
    users = Repo.stream_rows!("SELECT avatar_url FROM {{K}}.users", [])
    workspaces = Repo.stream_rows!("SELECT icon_url FROM {{K}}.workspaces", [])

    users
    |> Stream.map(& &1["avatar_url"])
    |> Stream.concat(Stream.map(workspaces, & &1["icon_url"]))
    |> Stream.flat_map(&hash_of/1)
    |> Stream.uniq()
    |> Enum.reduce(0, fn hash, n ->
      Store.mark_public(hash)
      n + 1
    end)
  end

  defp hash_of(url) when is_binary(url) do
    case Regex.run(@hash_re, url) do
      [_, hash] -> [hash]
      nil -> []
    end
  end

  defp hash_of(_), do: []
end
