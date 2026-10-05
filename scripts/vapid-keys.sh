#!/usr/bin/env bash
# Generate the VAPID keypair web push signs with, and print the env block
# Cytale actually reads.
#
# WHY THIS EXISTS: `mix web_push_ex.vapid` is the authoritative generator, but
# its output is generic boilerplate that does not match how this repo is wired.
# It prints `WEB_PUSH_EX_VAPID_PRIVATE_KEY` and tells you to put the public key
# in `config/config.exs`; Cytale reads `CYTALE_VAPID_PRIVATE_KEY` /
# `CYTALE_VAPID_PUBLIC_KEY` from the environment and configures both at runtime
# (see apps/server/config/runtime.exs). Following the library's snippet
# produces a server that boots, reports no push configured, and gives no clue
# why.
#
# It also has to run from the MIX PROJECT, which is apps/server — not the repo
# root. This script is the one command that works from either.
#
# USAGE
#   scripts/vapid-keys.sh          generate a fresh pair and print the env block
#   scripts/vapid-keys.sh --check  report whether the RUNNING config has keys
#
# TREAT THE OUTPUT AS A SECRET, and store it where the deploy reads its
# environment. ROTATING IT INVALIDATES EVERY EXISTING SUBSCRIPTION: RFC 8292
# binds the key to the subscription at creation, so a new pair silently stops
# every browser that already subscribed, with no 404/410 for the sender to
# notice. Generate once per instance and keep it with SECRET_KEY_BASE.

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
server_dir="$repo_root/apps/server"

if [ ! -f "$server_dir/mix.exs" ]; then
  echo "error: no mix.exs at $server_dir — is this the Cytale checkout?" >&2
  exit 1
fi

mode="${1:-generate}"

if [ "$mode" = "--check" ]; then
  # Runs inside the app so it reads the SAME config the server does, rather
  # than re-deriving it from the environment and possibly disagreeing. A temp
  # script rather than `-e`: the probe contains string interpolation and a
  # multi-line cond, and quoting that through the shell into Elixir is a
  # nesting problem with no upside.
  probe="$(mktemp "${TMPDIR:-/tmp}/cytale-vapid-check.XXXXXX.exs")"
  trap 'rm -f "$probe"' EXIT

  cat >"$probe" <<'ELIXIR'
vapid = Application.get_env(:web_push_ex, :vapid, [])
public = Keyword.get(vapid, :public_key)
private = Keyword.get(vapid, :private_key)
delivery = Application.get_env(:cytale, Cytale.Notifications.Delivery)

describe = fn
  nil -> "ABSENT"
  value when is_binary(value) -> "present (#{byte_size(value)} chars)"
  _ -> "present"
end

IO.puts("public key:  #{describe.(public)}")
IO.puts("private key: #{describe.(private)}")
IO.puts("delivery:    #{inspect(delivery)}")
IO.puts("")

if public && private do
  IO.puts("=> web push is ON. Subscriptions made against THESE keys stay valid until they rotate.")
else
  IO.puts("=> web push is OFF. Set CYTALE_VAPID_PRIVATE_KEY and CYTALE_VAPID_PUBLIC_KEY.")
  IO.puts("   In dev a committed pair is used automatically; :prod deliberately has none.")
end

IO.puts("")
IO.puts("The /metrics surface reports this as `cytale_push_enabled` 1|0, so a scraper")
IO.puts("can alert on a silently-off sender (docs/self-hosting.md, \"Web push\").")
ELIXIR

  ( cd "$server_dir" && mix run --no-start "$probe" )
  exit 0
fi

if [ "$mode" != "generate" ] && [ "$mode" != "--generate" ]; then
  echo "usage: $0 [--check]" >&2
  exit 1
fi

# The generator's own output, parsed rather than reproduced: the library owns
# the key format, and re-deriving it here would be a second implementation to
# keep in step.
raw="$( cd "$server_dir" && mix web_push_ex.vapid 2>/dev/null )"

private_key="$(printf '%s\n' "$raw" | sed -n 's/.*WEB_PUSH_EX_VAPID_PRIVATE_KEY=\(.*\)$/\1/p' | tail -1)"
public_key="$(printf '%s\n' "$raw" | sed -n 's/.*public_key: "\([^"]*\)".*/\1/p' | head -1)"

if [ -z "$private_key" ] || [ -z "$public_key" ]; then
  echo "error: could not parse the generator's output — run it directly to see what changed:" >&2
  echo "       (cd apps/server && mix web_push_ex.vapid)" >&2
  exit 1
fi

cat <<EOF
# Cytale web push — generated $(date -u +%Y-%m-%dT%H:%M:%SZ)
#
# Store these with your other secrets (deploy/.env or equivalent). Both are
# required; providing them is the entire switch that turns push on.
#
# ROTATING THIS PAIR INVALIDATES EVERY EXISTING SUBSCRIPTION. Keep it.

CYTALE_VAPID_PRIVATE_KEY=$private_key
CYTALE_VAPID_PUBLIC_KEY=$public_key

# Optional — defaults to mailto:admin@localhost, and some push services prefer
# a real contact address.
# CYTALE_VAPID_SUBJECT=mailto:you@example.com
EOF
