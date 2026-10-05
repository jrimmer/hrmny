#!/usr/bin/env bash
# Hrmny mobile iOS release — TestFlight archive + App Store Connect upload.
#
# Usage:
#   scripts/ios-release.sh                     # prebuild + archive + export + upload
#   scripts/ios-release.sh --skip-prebuild     # reuse the existing ios/ folder
#   scripts/ios-release.sh --no-upload         # stop at the .ipa (no App Store Connect upload)
#   scripts/ios-release.sh --bump-build-number # increment ios.buildNumber, then build
#   scripts/ios-release.sh --help
#
# BEFORE EVERY TESTFLIGHT UPLOAD: bump ios.buildNumber in apps/mobile/app.json
# (`--bump-build-number` does it for you). App Store Connect rejects a build
# number already used by a processed build for the same version.
#
# REQUIREMENTS (the 2026-09-18 upload rejection was exactly this): the
# installed Xcode must be a version App Store Connect currently accepts —
# after the fall release that is the released Xcode 27 / its RC, NOT an
# earlier beta. ASC validates the toolchain at upload and refuses betas.
#
# Signing: automatic — the Apple Distribution cert of team $APPLE_TEAM_ID in
# the keychain plus the Xcode-managed App Store profile for chat.hrmny. The
# upload authenticates with an App Store Connect API key when one is
# configured (CYTALE_ASC_KEY_ID + CYTALE_ASC_ISSUER_ID + CYTALE_ASC_KEY_PATH),
# otherwise through the keychain's App Store Connect session (created by
# signing into Xcode).
#
# Deployment values (the server origin, the team, the ASC key) are never in
# the source. They come from the environment, or from a private overlay file
# sourced first when it exists: $HRMNY_RELEASE_ENV, default
# <repo>/private/release.env (a deployment's own file; not part of the public
# tree). Required: EXPO_PUBLIC_CYTALE_ORIGIN (https), APPLE_TEAM_ID.
# Optional: EXPO_PUBLIC_CYTALE_HOSTED_ORIGIN (the sign-in form's suggested
# server), the CYTALE_ASC_* trio above.
#
# dSYMs are NOT uploaded (uploadSymbols=false): the RN 0.86 hermesvm pod
# produces no dSYM and ASC refuses the upload when symbols are requested and
# one is missing. See docs/mobile-release.md §8.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MOBILE_DIR="$REPO_ROOT/apps/mobile"
APP_JSON="$MOBILE_DIR/app.json"
WORK_DIR="${TMPDIR:-/tmp}/hrmny-ios-release"
ARCHIVE="$WORK_DIR/Hrmny.xcarchive"
EXPORT_DIR="$WORK_DIR/export"

RELEASE_ENV="${HRMNY_RELEASE_ENV:-$REPO_ROOT/private/release.env}"
if [[ -f "$RELEASE_ENV" ]]; then
  echo "==> release values: $RELEASE_ENV"
  set -a
  # shellcheck disable=SC1090
  source "$RELEASE_ENV"
  set +a
fi

: "${EXPO_PUBLIC_CYTALE_ORIGIN:?set EXPO_PUBLIC_CYTALE_ORIGIN (the release build server origin, https) or provide $RELEASE_ENV}"
: "${APPLE_TEAM_ID:?set APPLE_TEAM_ID (the signing team) or provide $RELEASE_ENV}"
export EXPO_PUBLIC_CYTALE_ORIGIN APPLE_TEAM_ID
if [[ -n "${EXPO_PUBLIC_CYTALE_HOSTED_ORIGIN:-}" ]]; then export EXPO_PUBLIC_CYTALE_HOSTED_ORIGIN; fi
if [[ "$EXPO_PUBLIC_CYTALE_ORIGIN" != https:* ]]; then
  echo "refusing: EXPO_PUBLIC_CYTALE_ORIGIN must be https for a release build" >&2
  exit 1
fi

SKIP_PREBUILD=0
UPLOAD=1
while [[ $# -gt 0 ]]; do
  case "$1" in
    --skip-prebuild) SKIP_PREBUILD=1 ;;
    --no-upload) UPLOAD=0 ;;
    --bump-build-number)
      python3 - "$APP_JSON" <<'EOF'
import json, sys
path = sys.argv[1]
app = json.load(open(path))
app["expo"]["ios"]["buildNumber"] = str(int(app["expo"]["ios"].get("buildNumber", "1")) + 1)
json.dump(app, open(path, "w"), indent=2)
open(path, "a").write("\n")
print(f"buildNumber -> {app['expo']['ios']['buildNumber']}")
EOF
      ;;
    -h|--help)
      sed -n '2,30p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) echo "unknown flag: $1 (see --help)" >&2; exit 1 ;;
  esac
  shift
done

echo "==> origin: $EXPO_PUBLIC_CYTALE_ORIGIN"

ASC_KEY_ID="${CYTALE_ASC_KEY_ID:-}"
ASC_ISSUER="${CYTALE_ASC_ISSUER_ID:-}"
ASC_KEY_PATH="${CYTALE_ASC_KEY_PATH:-${ASC_KEY_ID:+$HOME/.cytale/asc/AuthKey_$ASC_KEY_ID.p8}}"
AUTH_ARGS=()
if [[ -n "$ASC_KEY_ID" && -n "$ASC_ISSUER" && -f "$ASC_KEY_PATH" ]]; then
  AUTH_ARGS=(
    -authenticationKeyPath "$ASC_KEY_PATH"
    -authenticationKeyID "$ASC_KEY_ID"
    -authenticationKeyIssuerID "$ASC_ISSUER"
  )
  echo "==> upload auth: ASC API key $ASC_KEY_ID"
else
  echo "==> upload auth: Xcode keychain session (no API key at $ASC_KEY_PATH)"
fi

if [[ "$SKIP_PREBUILD" -eq 0 ]]; then
  echo "==> prebuild (regenerates ios/)"
  (cd "$MOBILE_DIR" && pnpm exec expo prebuild --platform ios)
fi

mkdir -p "$WORK_DIR"
echo "==> archive (React Native compiles from source; this is the slow part)"
# COMPILER_INDEX_STORE_ENABLE=NO: an archive never reads the index store, and
# skipping it saves real memory on a 16GB Mac (the 2026-09-19 archive was
# SIGKILLed at peak — several Fabric C++ compiles in flight at once). The
# concurrency knob is a user default read by XCBBuildService; cap it when the
# operator asks via IOS_RELEASE_MAX_JOBS, restore afterwards.
if [ -n "${IOS_RELEASE_MAX_JOBS:-}" ]; then
  defaults write com.apple.dt.Xcode IDEBuildOperationMaxNumberOfConcurrentInvocations -int "$IOS_RELEASE_MAX_JOBS"
  trap 'defaults delete com.apple.dt.Xcode IDEBuildOperationMaxNumberOfConcurrentInvocations' EXIT
fi
(cd "$MOBILE_DIR/ios" && xcodebuild \
  COMPILER_INDEX_STORE_ENABLE=NO \
  -workspace Hrmny.xcworkspace \
  -scheme Hrmny \
  -configuration Release \
  -destination 'generic/platform=iOS' \
  -archivePath "$ARCHIVE" \
  -allowProvisioningUpdates \
  archive)

cat > "$WORK_DIR/exportOptions.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>method</key>
	<string>app-store-connect</string>
	<key>destination</key>
	<string>$([[ "$UPLOAD" -eq 1 ]] && echo upload || echo export)</string>
	<key>teamID</key>
	<string>$APPLE_TEAM_ID</string>
	<key>uploadSymbols</key>
	<false/>
	<key>signingStyle</key>
	<string>automatic</string>
	<key>manageAppVersionAndBuildNumber</key>
	<false/>
</dict>
</plist>
EOF

echo "==> export$( [[ "$UPLOAD" -eq 1 ]] && echo ' + upload to App Store Connect' )"
# The upload destination rides IN the plist — `-destination` on the CLI is a
# build destination (key=value) and xcodebuild bails with a usage error.
(cd "$MOBILE_DIR/ios" && xcodebuild \
  -exportArchive \
  -archivePath "$ARCHIVE" \
  -exportPath "$EXPORT_DIR" \
  -exportOptionsPlist "$WORK_DIR/exportOptions.plist" \
  "${AUTH_ARGS[@]}" \
  -allowProvisioningUpdates)

if [[ "$UPLOAD" -eq 1 ]]; then
  echo "==> uploaded. Track processing at https://appstoreconnect.apple.com (TestFlight tab)."
  echo "    A build needs to finish processing (~10-30 min) before testers can be added."
fi
