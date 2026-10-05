defmodule Cytale.TestNonce do
  @moduledoc """
  Per-run unique nonce for test fixtures (usernames, emails, workspaces).

  Replaces the per-module `phash2({node(), System.system_time()}, 99_999)`
  recipe: that hashed microsecond time into a 100k space, so two modules
  minting in the same microsecond — routine under a full parallel suite —
  collided and produced `username_taken` flakes that accumulated as the
  persistent test keyspace carried rows across repeated full-suite runs.

  Compact on purpose (≤9 digits): fixture fields have length caps, so a raw
  millis+unique concat overflows them. The hashed input pair is unique by
  construction; 1e9 of hash space keeps within-run collisions negligible
  (the same recipe the interactions tests used without a single flake).
  Cross-run residue still needs the keyspace flush, not luck. Use as
  `Cytale.TestNonce.get()` wherever a fixture needs a unique handle;
  prefix/suffix at the call site.
  """

  @spec get() :: String.t()
  def get do
    Integer.to_string(:erlang.phash2({System.system_time(), System.unique_integer([:monotonic])}, 1_000_000_000))
  end
end
