#!/usr/bin/env bash
# scripts/security-scan.sh — the #125 Tier-1 manual security scan.
#
# OWNER DECISION 2026-09-20: manual runs only — deliberately NOT wired into
# CI. Every scanner runs independently; one failing never stops the rest.
# Reports land in /tmp/cytale-secscan-<timestamp>/ (never committed).
#
# Scanners (all deterministic, all free, no source leaves the machine):
#   gitleaks   — secrets across FULL git history (v8.x)
#   sobelow    — Phoenix-specific SAST (installed as a mix ARCHIVE, never a
#                project dep — the repo rule keeps mix.lock churn-free)
#   mix audit   — mix.lock against the CVE advisory DB (mix_audit escript;
#                 `mix hex.audit` = retired packages)
#   pnpm audit — npm ecosystem CVEs from the lockfile
#   trivy fs   — lockfile vulns + IaC/compose misconfig + second secrets pass
#                (build-artifact dirs skipped: they're local-only and huge)
#
# Usage: scripts/security-scan.sh [report-dir]
#
# -e/-o pipefail: scanner FAILURES are the report's content — each one is
# deliberately independent (OWNER DECISION above), so every scanner
# invocation whose nonzero status is normal is guarded at its site (|| true
# with a reason). Strict mode only makes an unexpected setup failure (bad
# report dir, missing tool binary) stop the run instead of producing a
# half-empty report.
set -euo pipefail

REPORT="${1:-/tmp/cytale-secscan-$(date +%Y%m%d-%H%M%S)}"
mkdir -p "$REPORT"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
echo "report dir: $REPORT"

section() { printf '\n=== %s ===\n' "$1"; }

# --- 1. gitleaks: full-history secrets sweep -------------------------------
section "gitleaks (git history)"
if gitleaks git . --redact --no-banner >"$REPORT/gitleaks.txt" 2>&1; then
  echo "CLEAN — no secrets found in history"
  GITLEAKS_RC=0
else
  # v8 exits 1 on findings, 2 on errors; re-run detect only if the file is
  # empty (means the subcommand syntax failed, not findings).
  if [ -s "$REPORT/gitleaks.txt" ]; then
    echo "FINDINGS — see $REPORT/gitleaks.txt ($(grep -c 'Finding:' "$REPORT/gitleaks.txt" 2>/dev/null || echo '?') hits)"
    GITLEAKS_RC=1
  else
    gitleaks detect --source . --redact --verbose --no-banner >"$REPORT/gitleaks.txt" 2>&1 \
      && { echo "CLEAN"; GITLEAKS_RC=0; } || { echo "FINDINGS — see gitleaks.txt"; GITLEAKS_RC=1; }
  fi
fi

# --- 2. sobelow: Phoenix SAST -----------------------------------------------
section "sobelow (Phoenix SAST)"
if mix archive.install hex sobelow --force >/dev/null 2>&1; then :; fi
# -e guard: sobelow's exit code is NOT findings-shaped (see below) — a
# nonzero exit is recorded by the analysis and summary, never fatal.
( cd apps/server && mix sobelow --ignore Config.HTTPS --verbose ) >"$REPORT/sobelow.txt" 2>&1 || true
# Sobelow's exit code is not findings-shaped on every version, and 0.15 does
# not honor function-level skip comments on private functions — so the
# high-confidence findings are diffed against the #125 TRIAGE LEDGER instead.
# Each entry: "check-name:file-fragment". A finding matching an entry is the
# triaged one (its justification lives as a comment at the code site); ANY
# other high-confidence finding is new and must be triaged before it can be
# added here. Config.HTTPS is ignored at invocation: TLS terminates at the
# edge proxy by architecture.
LEDGER=(
  # check-name prefix is informational; the FILE is what is matched
  "Misc.BinToTerm:webauthn.ex"
  "DOS.StringToAtom:channel_controller.ex"
)
mapfile -t HIGHS < <(grep -A1 "High Confidence" "$REPORT/sobelow.txt" \
  | grep "File:" | sed 's/.*File: //')
UNTRIAGED=0
for file in "${HIGHS[@]}"; do
  file="$(basename "$file")"
  known=false
  for l in "${LEDGER[@]}"; do
    lchk="${l%%:*}"; lfile="${l##*:}"
    if [[ "$file" == *"$lfile"* ]]; then known=true; break; fi
  done
  if [ "$known" = false ]; then
    echo "UNTRIAGED HIGH: $file"
    UNTRIAGED=1
  fi
done
if [ "$UNTRIAGED" -eq 0 ]; then
  echo "HIGH-CONFIDENCE FINDINGS: ${#HIGHS[@]} — all on the #125 triage ledger"
else
  echo "NEW HIGH-CONFIDENCE FINDINGS — triage before re-running (see sobelow.txt)"
fi

# --- 3. Elixir dependency audits ---------------------------------------------
section "mix hex.audit (retired Hex packages)"
# mix.lock CVEs are covered by trivy below (it parses mix.lock natively and
# found the repo's advisories); this check is the one thing trivy lacks.
( cd apps/server && mix hex.audit ) >"$REPORT/hex-audit.txt" 2>&1 && echo "retired packages: none" || echo "RETIRED PACKAGES — see hex-audit.txt"

# --- 4. pnpm audit ------------------------------------------------------------
section "pnpm audit (npm ecosystem)"
pnpm audit --prod >"$REPORT/pnpm-audit.txt" 2>&1 && echo "CLEAN (prod deps)" || echo "FINDINGS — see pnpm-audit.txt"

# --- 5. trivy: lockfiles + IaC + second secrets pass --------------------------
section "trivy fs (vuln, misconfig, secret)"
trivy fs --scanners vuln,misconfig,secret --timeout 10m \
  --skip-dirs 'node_modules' --skip-dirs 'apps/server/backups' --skip-dirs 'apps/server/tmp' \
  --skip-dirs 'docs/research' --skip-dirs '.pnpm-store' --skip-dirs 'apps/mobile/.expo' \
  --skip-dirs 'apps/mobile/ios/build' --skip-dirs 'apps/mobile/android/app/build' \
  --skip-dirs 'apps/desktop/src-tauri/target' \
  --ignore-unfixed \
  . >"$REPORT/trivy.txt" 2>&1 || TRIVY_RC=$?
# -e guard above: trivy's own exit code is the finding signal (1 = findings,
# 2 = error) and is reported verbatim below, so it must reach the assignment
# rather than kill the run (`|| true` would have flattened it to 0).
TRIVY_RC=${TRIVY_RC:-0}
if grep -q "Total: 0 (HIGH: 0" "$REPORT/trivy.txt" 2>/dev/null; then
  echo "CLEAN"
else
  echo "FINDINGS (exit $TRIVY_RC) — see trivy.txt"
fi

# --- summary ------------------------------------------------------------------
section "SUMMARY"
for f in gitleaks sobelow hex-audit pnpm-audit trivy; do
  printf '%-12s %s\n' "$f" "$(wc -l <"$REPORT/$f.txt" | tr -d ' ') lines"
done
echo "full reports: $REPORT"
echo "note: apps/server/backups + apps/server/tmp are skipped by trivy (local-only, gitignored, may contain real dev secrets)"
