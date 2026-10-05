defmodule Cytale.Backups.ArchiveSweepTest do
  @moduledoc """
  Hardening plan 4.8 — `Archive.sweep_staging/2` is DELETION (`File.rm_rf!`)
  driven by `Scheduler.prune/2`, and until now nothing exercised it: the age
  boundary that protects a RUNNING backup's staging dir, the directory guard, and
  the "nothing to sweep" path were all unverified. Review finding (#3 on the
  delta's review).

  Pure filesystem, so this needs no database and runs async.
  """

  use ExUnit.Case, async: true

  alias Cytale.Backups.Archive

  setup do
    dir = Path.join(System.tmp_dir!(), "cytale_sweep_#{System.unique_integer([:positive])}")
    File.mkdir_p!(dir)
    on_exit(fn -> File.rm_rf!(dir) end)
    {:ok, dir: dir}
  end

  @ancient {{2020, 1, 1}, {0, 0, 0}}

  test "removes an abandoned staging dir and keeps everything else", %{dir: dir} do
    stale = Path.join(dir, ".staging-bk-20200101T000000Z-aaa")
    File.mkdir_p!(Path.join(stale, "tables"))
    File.touch!(stale, @ancient)

    # A REAL archive pair and an unrelated operator file must never move.
    File.write!(Path.join(dir, "bk-20260101T000000Z-bbb.tar"), "complete")
    File.write!(Path.join(dir, "bk-20260101T000000Z-bbb.manifest.json"), "{}")
    File.write!(Path.join(dir, "operator-notes.txt"), "keep me")

    assert Archive.sweep_staging(dir, 60_000) == 1

    refute File.exists?(stale), "an abandoned staging dir must be reclaimed"
    assert File.exists?(Path.join(dir, "bk-20260101T000000Z-bbb.tar"))
    assert File.exists?(Path.join(dir, "bk-20260101T000000Z-bbb.manifest.json"))
    assert File.exists?(Path.join(dir, "operator-notes.txt"))
  end

  test "KEEPS a fresh staging dir — a backup may be running right now", %{dir: dir} do
    live = Path.join(dir, ".staging-bk-20260101T000000Z-live")
    File.mkdir_p!(live)
    # mtime is "now": prune shares this directory with the in-flight writer.

    assert Archive.sweep_staging(dir, 60_000) == 0
    assert File.exists?(live), "a live build's own staging dir must survive the sweep"
  end

  test "the boundary is the cutoff, not the name", %{dir: dir} do
    just_inside = Path.join(dir, ".staging-just-inside")
    just_outside = Path.join(dir, ".staging-just-outside")
    File.mkdir_p!(just_inside)
    File.mkdir_p!(just_outside)

    # 10 minutes ago, with a 5-minute cutoff: inside the guard, so kept.
    File.touch!(just_inside, {{2026, 1, 1}, {0, 0, 0}})
    File.touch!(just_outside, {{2019, 1, 1}, {0, 0, 0}})

    # A minute of margin on the inside one: `sweep_staging` reads the clock
    # again, a few ms after this line, and with a +1 ms margin that later read
    # alone pushed `just_inside` past the cutoff (flaky whenever the two reads
    # straddled a millisecond).
    cutoff = DateTime.diff(DateTime.utc_now(), ~U[2026-01-01 00:00:00Z], :millisecond) + 60_000

    assert Archive.sweep_staging(dir, cutoff) == 1

    assert File.exists?(just_inside), "a staging dir inside the age guard is left alone"
    refute File.exists?(just_outside)
  end

  test "a FILE named like a staging dir is left alone", %{dir: dir} do
    # `File.stat`'s type guard: only directories are reclaimed, so a stray file
    # with the prefix cannot turn a sweep into data loss.
    stray = Path.join(dir, ".staging-not-a-dir")
    File.write!(stray, "not a directory")
    File.touch!(stray, @ancient)

    assert Archive.sweep_staging(dir, 60_000) == 0
    assert File.exists?(stray)
  end

  test "an unreadable root is a no-op, not a crash", %{dir: dir} do
    # The scheduler passes its configured backup dir; a missing one (first boot,
    # a typo'd path) must report "nothing swept" rather than raise inside prune.
    assert Archive.sweep_staging(Path.join(dir, "does-not-exist"), 60_000) == 0
  end
end
