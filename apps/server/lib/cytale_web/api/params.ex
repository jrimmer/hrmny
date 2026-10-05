defmodule CytaleWeb.API.Params do
  @moduledoc """
  The REST boundary's parameter readers: one definition per shape, instead of a
  private copy in every controller (hardening plan 3.2).

  Every HTTP id in this API arrives as a decimal STRING (the wire contract:
  snowflakes exceed 2^53, so they never travel as JSON numbers), and every
  controller that reads one needs the same three answers: the integer, `:error`
  for something that is not one, and a defined answer for a value of the WRONG
  TYPE rather than a crash.
  """

  @doc """
  A positive decimal snowflake string → `{:ok, integer}`; anything else → `:error`.

  TOTAL, deliberately (hardening plan 4.12, applied here to all sixteen former
  copies): without the catch-all a non-binary id raised `FunctionClauseError`, so
  a body like `{"message_ids":[123]}` answered 500 instead of the handler's
  malformed-id answer. The wrong type is not a shape any doc promises
  (`docs/protocol/rest.md`: snowflake fields are "always decimal strings, never a
  JSON number"), which is exactly why it must be ANSWERED rather than allowed to
  crash.

  Where the fallthrough lands is the CALLER's business: some handlers answer 400
  `validation_failed`, others 404 (the anti-enumeration posture for a resource
  route). This function only refuses.
  """
  @spec snowflake(term()) :: {:ok, pos_integer()} | :error
  def snowflake(bin) when is_binary(bin) do
    case Integer.parse(bin) do
      {int, ""} when int > 0 -> {:ok, int}
      _ -> :error
    end
  end

  def snowflake(_other), do: :error

  @doc """
  The OPTIONAL form, for cursor parameters: `nil` for absent, `nil` for anything
  that is not a positive decimal string (hardening plan 3.3).

  "Absent cursor" and "unusable cursor" collapse to the same answer on purpose —
  every caller uses this to seed a `before`/`after`/`parent_id` filter, where the
  only two outcomes that exist are a cursor or no cursor, and a malformed one
  failing the whole request would be a worse answer than ignoring it.

  String-only, like `snowflake/1` and for the same reason: an id of the wrong TYPE
  is refused rather than accepted (hardening plan 4.12). Every call site is an HTTP
  parameter, so no caller can observe the difference from the integer-accepting
  `Cytale.Snowflake.parse/1` these used to be written in terms of.
  """
  @spec snowflake_opt(term()) :: pos_integer() | nil
  def snowflake_opt(nil), do: nil

  def snowflake_opt(bin) do
    case snowflake(bin) do
      {:ok, value} -> value
      _ -> nil
    end
  end

  @doc """
  A `limit` query parameter → a page size, with the caller's policy applied
  (hardening plan 3.5).

  Ten controllers carried this reader as two to four private clauses that differed
  ONLY in their default and cap (50/100, 100/100, 25/100, and the inbox's uncapped
  `Inbox.limit_default/0`). Both are now required at the call site — `default:` and
  `cap:` — because they are per-route POLICY, not shared logic, and the point of
  this consolidation is that the LOGIC stops being duplicated while the policy
  stays where it belongs: visible at the route.

  `cap: :infinity` is the uncapped spelling (the inbox's behaviour). The reader is
  TOTAL: `nil` and an unparseable string take the default, a positive integer is
  used directly (bounded by the cap), and anything else takes the default rather
  than raising. The last one is a deliberate widening — the nine strict copies
  raised `FunctionClauseError` on a wrong-typed `limit`, i.e. a JSON body carrying
  `{"limit": 50}` was a 500 — and it matches what the inbox already did. Same
  direction as `snowflake/1`'s totality (hardening plan 4.12): answer, do not
  crash.
  """
  @spec parse_limit(term(), keyword()) :: pos_integer()
  def parse_limit(value, opts) do
    default = Keyword.fetch!(opts, :default)
    cap = Keyword.fetch!(opts, :cap)

    case value do
      nil ->
        default

      n when is_integer(n) and n > 0 ->
        bounded(n, cap)

      bin when is_binary(bin) ->
        case Integer.parse(bin) do
          {n, ""} when n > 0 -> bounded(n, cap)
          _ -> default
        end

      _ ->
        default
    end
  end

  defp bounded(n, :infinity), do: n
  defp bounded(n, cap), do: min(n, cap)
end
