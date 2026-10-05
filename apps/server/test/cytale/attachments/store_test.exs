defmodule Cytale.Attachments.StoreTest do
  @moduledoc """
  Hardening plan 5.11 — the content-addressed store's admission path and its
  write durability.

  Two defects, both about what an operator sees vs what is true:

    * admission walked the WHOLE store (`File.ls/1` + `File.stat/1` per file) on
      every upload, so a store with 100k blobs paid 100k stats to admit one small
      file. The size is now a RUNNING COUNTER, seeded once from a scan and moved
      by the write/delete paths, with `recount/0` to re-derive it;
    * `put/3` wrote straight to the content-addressed path and never synced, so a
      crash mid-write left a TRUNCATED file that the store then served forever
      under a hash describing bytes it never fully held. Writes go to a temp file,
      are synced, and are RENAMED into place — a crash leaves an unreachable temp.
  """

  # async: false — the byte counter is per-NODE state shared by every test in the
  # run, so assertions are deltas and the seeding scan must not race another
  # module's writes.
  use ExUnit.Case, async: false

  alias Cytale.Attachments.Store

  defp blob(n), do: :crypto.strong_rand_bytes(n)

  # The counter is node-global and only the store's own write/delete paths move
  # it; other modules legitimately change the directory behind its back (the
  # restore tests copy blobs in, fixtures remove their roots). Re-derive it from
  # the directory first so every delta below starts from counter == disk —
  # otherwise the recount assertions inherit whatever drift earlier modules left.
  setup do
    Store.recount()
    :ok
  end

  test "put/get/delete round-trip, and the byte counter tracks the store" do
    data = blob(128)
    hash = Store.hash(data)
    on_exit(fn -> Store.delete(hash) end)

    before = Store.volume_usage_bytes()

    assert {:ok, descriptor} = Store.put(data, "probe.bin", "application/octet-stream")
    assert descriptor["size"] == 128
    assert Store.volume_usage_bytes() == before + 128

    assert {:ok, ^data} = Store.get(hash)
    assert {:ok, %{"filename" => "probe.bin", "size" => 128}} = Store.get_meta(hash)

    # Idempotent overwrite: the same content adds nothing.
    assert {:ok, _} = Store.put(data, "probe.bin", "application/octet-stream")
    assert Store.volume_usage_bytes() == before + 128

    assert :ok = Store.delete(hash)
    assert Store.volume_usage_bytes() == before
    assert :error = Store.get(hash)
  end

  test "the counter is NOT a directory walk — and recount/0 is the repair" do
    # The gate for "upload cost is independent of store size": a file that
    # disappears behind the store's back does not change the counter, which is
    # only possible if the read never looks at the directory. `recount/0` is the
    # escape hatch (an operator tool, and what a restore needs after it copies
    # blobs in directly).
    data = blob(64)
    hash = Store.hash(data)
    on_exit(fn -> Store.delete(hash) end)

    assert {:ok, _} = Store.put(data, "ghost.bin", "application/octet-stream")
    counted = Store.volume_usage_bytes()

    File.rm!(Store.path(hash))
    assert Store.volume_usage_bytes() == counted, "the size read walked the directory"

    assert Store.recount() == counted - 64
    assert Store.volume_usage_bytes() == counted - 64
  end

  test "a successful put leaves no temp file behind" do
    data = blob(32)
    hash = Store.hash(data)
    on_exit(fn -> Store.delete(hash) end)

    assert {:ok, _} = Store.put(data, "clean.bin", "application/octet-stream")

    temps =
      Store.root()
      |> File.ls!()
      |> Enum.filter(&String.contains?(&1, ".tmp-"))

    assert temps == [], "in-flight temp files survived a successful write: #{inspect(temps)}"
  end

  test "an interrupted write is unreachable: a stranded temp is not a blob" do
    # The durability half. A crash between the write and the rename leaves a
    # `.tmp-*` file; content addressing resolves by HASH, so the real path stays
    # absent — the store must never serve (or count) the partial bytes.
    data = blob(256)
    hash = Store.hash(data)
    real = Store.path(hash)
    temp = real <> ".tmp-999999"

    File.mkdir_p!(Store.root())
    File.write!(temp, data)
    on_exit(fn -> File.rm(temp) end)

    before = Store.volume_usage_bytes()

    assert :error = Store.get(hash), "a stranded temp file was served as a blob"
    assert Store.volume_usage_bytes() == before, "a stranded temp file was counted as stored bytes"

    # …and the temp is not mistaken for a stored blob by a recount either.
    assert Store.recount() == before
  end
end
