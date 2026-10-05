defmodule Cytale.Search.Behaviour do
  @moduledoc """
  The search seam (U13, R12/R13/R14).

  Callers depend on this behaviour, never on an implementation. Today the
  pure-Elixir foundation (query parsing + partition management) is in place;
  the Tantivy-backed `Cytale.Search.TantivyImpl` (via the muninn NIF wrapper)
  lands in slice 2 behind this same seam — that is the whole point of the
  seam: swap the implementation without touching call sites.

  The seam exposes the explicit mutation surface the account-deletion cascade
  (U14) consumes:

    * `delete_by_author/2` — remove every indexed message by an author
      (the U14 sweep calls this per workspace).
    * `reconcile/1` — self-heal an index against ScyllaDB: replay the delta
      between the index's last-committed `message_id` watermark and the
      workspace's latest, via idempotent upserts keyed by `message_id`.
      Returns `{:ok, replayed_count}`.

  #89 added the explicit maintenance surface, because "the index is wrong" was
  otherwise unfixable except by deleting a directory and hoping:

    * `drift/2` — report drift per workspace WITHOUT rebuilding: document
      counts, plus bounded samples of the missing and orphaned id sets (and of
      documents whose indexed text no longer matches the row). The ids are the
      point: an orphan repair is N deletes, not a rebuild.
    * `repair_orphans/2` — unindex a given set of ids (the surgical repair).
    * `rebuild/2` — re-index the whole workspace from ScyllaDB (the same
      replay, from 0).

  All of these are REQUIRED on the contract, so a conforming implementation
  must provide them.
  """

  @typedoc "A message-shaped map for indexing (integer-native ids)."
  @type message :: %{
          required(:id) => integer(),
          required(:channel_id) => integer(),
          required(:author_id) => integer(),
          required(:content) => String.t(),
          required(:created_at) => DateTime.t(),
          optional(:thread_id) => integer() | nil
        }

  @typedoc "A search result row (jump-to-message payload)."
  @type result :: %{
          required(:message_id) => integer(),
          required(:channel_id) => integer(),
          optional(:thread_id) => integer() | nil,
          optional(:score) => float()
        }

  @typedoc "A parsed, permission-filtered query (see `Cytale.Search.Query`)."
  @type query :: map()

  @doc "Index a message (idempotent upsert keyed by message_id)."
  @callback index(workspace_id :: integer(), message()) :: :ok | {:error, term()}

  @doc "Query an index, restricted to the caller's visible channels."
  @callback query(workspace_id :: integer(), query(), filters :: map()) :: [result()]

  @doc "Delete every indexed message by an author (U14 cascade)."
  @callback delete_by_author(workspace_id :: integer(), author_id :: integer()) :: :ok

  @doc """
  Remove ONE message's document (the message-delete path, #76).

  Without this the index keeps a ghost for every deleted message, and a search
  over that channel returns a hit whose ScyllaDB row is gone — the reader then
  has an id it cannot render.
  """
  @callback delete_message(workspace_id :: integer(), message_id :: integer()) :: :ok

  @doc "Self-heal an index against ScyllaDB; returns the replayed count."
  @callback reconcile(workspace_id :: integer()) :: {:ok, non_neg_integer()}

  @doc """
  Report drift between the index and the `messages` table WITHOUT rebuilding.

  The report carries two exact counts (documents in the index, messages in the
  table) plus bounded samples of the ids behind the difference — `missing`
  (rows the index does not hold) and `orphaned` (documents whose row is gone).
  See `Cytale.Search.Drift.check/2` for the shape and the coverage caveats.
  """
  @callback drift(workspace_id :: integer(), opts :: keyword()) :: map()

  @doc """
  Unindex a set of message ids — the surgical repair the drift check's
  `orphaned.ids` feeds. No rebuild.
  """
  @callback repair_orphans(workspace_id :: integer(), message_ids :: [integer()]) ::
              %{unindexed: non_neg_integer(), ids: [integer()]}

  @doc """
  Re-index a workspace from its `messages` table (`replay_range(ws, 0, latest)`).

  Idempotent and interrupt-safe; it repairs missing documents and does NOT
  remove orphans (nothing in an upsert walk deletes). Verify with `drift/2`.
  """
  @callback rebuild(workspace_id :: integer(), opts :: keyword()) :: {:ok, map()}
end
