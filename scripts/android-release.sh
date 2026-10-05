#!/usr/bin/env bash
# Hrmny Android release builder — Play AAB + sideload APK, signed with the
# upload key (never the React Native template's debug key).
#
# Usage:
#   scripts/android-release.sh                     # prebuild + AAB + APK, then verify signing
#   scripts/android-release.sh --aab-only          # Play bundle only
#   scripts/android-release.sh --apk-only          # sideload APK only
#   scripts/android-release.sh --skip-prebuild     # reuse the existing android/ folder
#   scripts/android-release.sh --bump-version-code # increment android.versionCode, then build
#   scripts/android-release.sh --help
#
# BEFORE EVERY PLAY UPLOAD: bump android.versionCode in apps/mobile/app.json
# (`--bump-version-code` does it for you). Play rejects a bundle whose versionCode
# is not strictly greater than the last one uploaded for that track, and a burned
# versionCode cannot be reused. android.versionName is the human-facing string.
#
# The keystore lives OUTSIDE the repo (default ~/.cytale/android-upload.keystore,
# password in ~/.cytale/android-upload-credentials.txt). Losing it means losing the
# ability to publish updates for chat.hrmny — back it up offline.
# See docs/mobile-release.md.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MOBILE_DIR="$REPO_ROOT/apps/mobile"
ANDROID_DIR="$MOBILE_DIR/android"
APP_JSON="$MOBILE_DIR/app.json"

# --- environment -----------------------------------------------------------------
# A plain shell here has neither of these exported, and the build fails without them.
export JAVA_HOME="${JAVA_HOME:-/Applications/Android Studio.app/Contents/jbr/Contents/Home}"
export ANDROID_HOME="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
export PATH="$ANDROID_HOME/platform-tools:$PATH"

# Deployment values are never in the source. The sign-in form's suggested
# server is EXPO_PUBLIC_CYTALE_HOSTED_ORIGIN (apps/mobile/src/auth/serverOrigin.ts);
# it comes from the environment, or from a private overlay sourced when it
# exists: $HRMNY_ANDROID_RELEASE_ENV, default <repo>/private/android-release.env
# (a deployment's own file; not part of the public tree). Unset = no suggestion.
ANDROID_RELEASE_ENV="${HRMNY_ANDROID_RELEASE_ENV:-$REPO_ROOT/private/android-release.env}"
if [[ -f "$ANDROID_RELEASE_ENV" ]]; then
  echo "==> release values: $ANDROID_RELEASE_ENV"
  set -a
  # shellcheck disable=SC1090
  source "$ANDROID_RELEASE_ENV"
  set +a
fi

KEYSTORE="${CYTALE_UPLOAD_KEYSTORE:-$HOME/.cytale/android-upload.keystore}"
CREDENTIALS="${CYTALE_UPLOAD_CREDENTIALS:-$HOME/.cytale/android-upload-credentials.txt}"
KEY_ALIAS="${CYTALE_UPLOAD_KEY_ALIAS:-}"
KEY_PASSWORD="${CYTALE_UPLOAD_KEY_PASSWORD:-}"

# Fill anything unset from the credentials file (kept outside the repo).
if [[ -f "$CREDENTIALS" ]]; then
  while IFS='=' read -r key value; do
    case "$key" in
      CYTALE_UPLOAD_KEYSTORE) [[ -n "${CYTALE_UPLOAD_KEYSTORE:-}" ]] || KEYSTORE="$value" ;;
      CYTALE_UPLOAD_KEY_ALIAS) [[ -n "$KEY_ALIAS" ]] || KEY_ALIAS="$value" ;;
      CYTALE_UPLOAD_KEY_PASSWORD) [[ -n "$KEY_PASSWORD" ]] || KEY_PASSWORD="$value" ;;
    esac
  done < <(grep -E '^[A-Za-z_]+=' "$CREDENTIALS" || true)
fi
KEY_ALIAS="${KEY_ALIAS:-cytale-upload}"

BUILD_AAB=1
BUILD_APK=1
RUN_PREBUILD=1
BUMP_VERSION_CODE=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --aab-only) BUILD_APK=0 ;;
    --apk-only) BUILD_AAB=0 ;;
    --skip-prebuild) RUN_PREBUILD=0 ;;
    --bump-version-code) BUMP_VERSION_CODE=1 ;;
    -h|--help) sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $1 (try --help)" >&2; exit 2 ;;
  esac
  shift
done

fail() { echo "ERROR: $*" >&2; exit 1; }

# --- preflight: fail before a 20-minute build, not after -------------------------
[[ -x "$JAVA_HOME/bin/java" ]] || fail "no java at JAVA_HOME=$JAVA_HOME (export JAVA_HOME or install Android Studio)"
[[ -d "$ANDROID_HOME" ]] || fail "no Android SDK at ANDROID_HOME=$ANDROID_HOME"
[[ -f "$KEYSTORE" ]] || fail "upload keystore not found: $KEYSTORE — restore it from backup, or set CYTALE_UPLOAD_KEYSTORE (docs/mobile-release.md)"
[[ -n "$KEY_PASSWORD" ]] || fail "no keystore password: set CYTALE_UPLOAD_KEY_PASSWORD or put it in $CREDENTIALS (docs/mobile-release.md)"
if ! CYTALE_PW="$KEY_PASSWORD" "$JAVA_HOME/bin/keytool" -list -keystore "$KEYSTORE" -storetype PKCS12 \
      -alias "$KEY_ALIAS" -storepass:env CYTALE_PW >/dev/null 2>&1; then
  fail "keystore $KEYSTORE does not open with alias '$KEY_ALIAS' and the configured password"
fi

if [[ "$BUMP_VERSION_CODE" == 1 ]]; then
  node -e '
    const fs = require("fs");
    const p = process.argv[1];
    const cfg = JSON.parse(fs.readFileSync(p, "utf8"));
    const next = (cfg.expo.android.versionCode ?? 0) + 1;
    cfg.expo.android.versionCode = next;
    fs.writeFileSync(p, JSON.stringify(cfg, null, 2) + "\n");
    console.log("android.versionCode -> " + next);
  ' "$APP_JSON"
fi

CURRENT_VERSION_CODE="$(node -e 'console.log(require(process.argv[1]).expo.android.versionCode)' "$APP_JSON")"
CURRENT_VERSION_NAME="$(node -e 'console.log(require(process.argv[1]).expo.version)' "$APP_JSON")"
echo "==> chat.hrmny versionName=$CURRENT_VERSION_NAME versionCode=$CURRENT_VERSION_CODE"
echo "    keystore: $KEYSTORE (alias $KEY_ALIAS)"
echo "    reminder: Play rejects a versionCode that was already uploaded — use --bump-version-code"

cd "$MOBILE_DIR"

if [[ "$RUN_PREBUILD" == 1 ]]; then
  echo "==> expo prebuild --platform android --clean"
  # --clean regenerates android/ from the template + config plugins (the release
  # signing wiring comes from plugins/withAndroidReleaseSigning.js). EXPO_NO_GIT_STATUS
  # skips the interactive dirty-git prompt; other agents share this working tree.
  EXPO_NO_GIT_STATUS=1 npx expo prebuild --platform android --clean --no-install
fi

cd "$ANDROID_DIR"
GRADLE=(./gradlew --console=plain)

if [[ "$BUILD_AAB" == 1 ]]; then
  echo "==> release App Bundle (all ABIs — Play splits per device)"
  "${GRADLE[@]}" :app:bundleRelease
fi

if [[ "$BUILD_APK" == 1 ]]; then
  # The owner's tablet is arm64-v8a; a single-ABI APK keeps the sideload small.
  echo "==> release APK (arm64-v8a, for the tablet)"
  "${GRADLE[@]}" :app:assembleRelease -PreactNativeArchitectures=arm64-v8a
fi

# --- verify the artifacts really carry the upload key ----------------------------
APKSIGNER="$(ls -1 "$ANDROID_HOME"/build-tools/*/apksigner 2>/dev/null | sort -V | tail -1 || true)"
KEYTOOL="$JAVA_HOME/bin/keytool"
[[ -n "$APKSIGNER" ]] || fail "apksigner not found under $ANDROID_HOME/build-tools"

normalize() { tr 'A-Z' 'a-z' | tr -d ':'; }
EXPECTED="$(CYTALE_PW="$KEY_PASSWORD" "$KEYTOOL" -list -v -keystore "$KEYSTORE" -storetype PKCS12 \
  -alias "$KEY_ALIAS" -storepass:env CYTALE_PW | grep -m1 'SHA256:' | awk '{print $2}' | normalize)"
echo
echo "==> upload certificate SHA-256: $EXPECTED"

AAB="$ANDROID_DIR/app/build/outputs/bundle/release/app-release.aab"
APK="$ANDROID_DIR/app/build/outputs/apk/release/app-release.apk"

if [[ "$BUILD_APK" == 1 ]]; then
  [[ -f "$APK" ]] || fail "expected APK not found: $APK"
  echo
  echo "==> apksigner verify --print-certs $(basename "$APK")"
  "$APKSIGNER" verify --print-certs "$APK"
  ACTUAL="$("$APKSIGNER" verify --print-certs "$APK" | grep -m1 'SHA-256 digest' | awk '{print $NF}' | normalize)"
  if "$APKSIGNER" verify --print-certs "$APK" | grep -q 'Android Debug'; then
    fail "APK is signed with the DEBUG key — do not ship it"
  fi
  [[ "$ACTUAL" == "$EXPECTED" ]] || fail "APK signer fingerprint $ACTUAL != upload keystore $EXPECTED"
  echo "    OK: APK is signed with the upload key"
fi

if [[ "$BUILD_AAB" == 1 ]]; then
  [[ -f "$AAB" ]] || fail "expected AAB not found: $AAB"
  echo
  echo "==> keytool -printcert -jarfile $(basename "$AAB")"
  CERT="$(CYTALE_PW="$KEY_PASSWORD" "$KEYTOOL" -printcert -jarfile "$AAB" 2>&1)"
  echo "$CERT" | grep -E 'Owner:|SHA256:' | sed 's/^/    /'
  ACTUAL="$(echo "$CERT" | grep -m1 'SHA256:' | awk '{print $2}' | normalize)"
  if echo "$CERT" | grep -q 'CN=Android Debug'; then
    fail "AAB is signed with the DEBUG key — do not ship it"
  fi
  [[ "$ACTUAL" == "$EXPECTED" ]] || fail "AAB signer fingerprint $ACTUAL != upload keystore $EXPECTED"
  echo "    OK: AAB is signed with the upload key"
fi

echo
echo "==> artifacts"
for f in "$AAB" "$APK"; do
  [[ -f "$f" ]] && printf '    %s  (%s)\n' "$f" "$(du -h "$f" | cut -f1)"
done
echo
echo "Next: upload $AAB to the Play Console (internal testing track first), and"
echo "sideload $APK with: adb install -r $APK"
