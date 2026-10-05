#!/usr/bin/env bash
# Cytale development-box bootstrap — Debian 12 (bookworm)
#
# One-shot, idempotent installation of the full toolchain required by the
# launch plan (docs/plans/2026-08-25-001-feat-cytale-team-chat-launch-plan.md):
#
#   P0  APT build prerequisites (C toolchain, OpenSSL, ncurses, pkg-config)
#   P1  mise runtime manager -> Erlang/OTP 27 + Elixir 1.18 (plan floor ~> 1.18)
#       NOTE: first run compiles OTP from source; expect ~15-30 minutes.
#   P2  Rust stable via rustup (plan floor ~> 1.92) — used by the Tantivy/muninn NIF (U13)
#   P3  Node.js 22 LTS + pnpm (monorepo, U1)
#   P4  Docker CE (hosts ScyllaDB for U6+ integration tests)
#       If docker cannot run (e.g. unprivileged LXC without nesting), fall back to
#       ScyllaDB's native Debian 12 repo: https://www.scylladb.com/download/debian/
#   P5  Tauri 2 system libs (required ONLY for desktop bundling in U27;
#       harmless to install early)
#
# Run:  bash scripts/bootstrap-debian.sh     (sudo-capable user; reboot-free except
#                                             docker group membership on next login)
set -euo pipefail

# verify_sha256 FILE EXPECTED — enforce the digest only when EXPECTED is
# non-empty: pinning is a per-run decision (MISE_INSTALL_SHA256 /
# RUSTUP_INIT_SHA256), not a default that goes stale and breaks bootstrap.
check_sha256() {
  file="$1"
  expected="$2"
  if [ -n "$expected" ]; then
    if ! printf '%s  %s\n' "$expected" "$file" | sha256sum --check --status; then
      echo "FATAL: sha256 mismatch for $file (expected $expected)" >&2
      exit 1
    fi
    echo "checksum ok: $file"
  fi
}

echo "==> [P0] APT prerequisites"
sudo apt-get update -y
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y \
  build-essential autoconf m4 libncurses-dev libssl-dev pkg-config \
  curl wget git zstd ca-certificates unzip xz-utils

echo "==> [P1] mise + Erlang/OTP 27 + Elixir 1.18"
if ! command -v mise >/dev/null 2>&1; then
  # Download-then-execute, never `curl | sh`: a pipe runs a HALF-delivered
  # script on truncation and hides the HTTP failure behind sh's parse noise.
  # We do NOT pin the installers' checksums in this script: both move with
  # their upstream releases and a stale pin would brick every bootstrap the
  # moment upstream ships. The optional env checksums below are the supported
  # pinning point for a hardened run (set before invoking, e.g. from a
  # verified copy of the installer's published digest).
  mise_installer="$(mktemp)"
  curl --fail --proto '=https' --tlsv1.2 -fsSL https://mise.run -o "$mise_installer"
  check_sha256 "$mise_installer" "${MISE_INSTALL_SHA256:-}"
  sh "$mise_installer"
  rm -f "$mise_installer"
fi
export PATH="$HOME/.local/bin:$PATH"
mise use -g erlang@27
# Pin the Elixir build variant to the SAME OTP major as the installed runtime.
# A bare elixir@1.18 resolves to its newest variant (currently *-otp-28), whose
# precompiled .beam files FAIL TO LOAD under erlang@27:
#   "Error! Failed to load module 'elixir' because it requires a more recent
#    Erlang/OTP version" -> boot undef -> erl_crash.dump
mise use -g "elixir@1.18.4-otp-27"

echo "==> [P2] Rust (rustup, stable)"
if ! command -v rustc >/dev/null 2>&1; then
  # Same download-then-execute posture as P1 (see the comment there for why
  # there is no in-tree checksum pin).
  rustup_installer="$(mktemp)"
  curl --fail --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs -o "$rustup_installer"
  check_sha256 "$rustup_installer" "${RUSTUP_INIT_SHA256:-}"
  sh "$rustup_installer" -s -- -y --default-toolchain stable
  rm -f "$rustup_installer"
fi
. "$HOME/.cargo/env"

echo "==> [P3] Node 22 + pnpm"
mise use -g node@22
if ! command -v pnpm >/dev/null 2>&1; then
  corepack enable && corepack prepare pnpm@latest --activate
fi

echo "==> [P4] Docker CE"
if ! command -v docker >/dev/null 2>&1; then
  curl -fsSL https://get.docker.com | sudo sh
  sudo usermod -aG docker "$USER" || true
fi

echo "==> [P5] Tauri 2 bundle dependencies (used by U27)"
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y \
  libwebkit2gtk-4.1-dev build-essential file libxdo-dev libssl-dev \
  libayatana-appindicator3-dev librsvg2-dev

echo "==> Reference ScyllaDB dev container (U6 owns schema/load):"
echo "    docker run -d --name cytale-scylla -p 9042:9042 \\"
echo "      scylladb/scylla:5.2 --smp 2 --memory 2G --overprovisioned 1 --developer-mode 1"
echo "    (allocate >=4 GB RAM to the host for this; 8 GB comfortable)"

echo "==> Installed versions:"
export PATH="$HOME/.local/bin:$PATH"
. "$HOME/.cargo/env" 2>/dev/null || true
mise exec -- elixir --version | tail -1 || true
rustc --version || true
mise exec -- node --version || true
pnpm --version || true
docker --version || true
echo "==> Bootstrap complete. Log out/in once for docker group membership."
