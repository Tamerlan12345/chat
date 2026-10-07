#!/usr/bin/env bash
# Verifies that a Release build is locked to the production server.
#
#   verify-release-server-lock.sh <path/to/CentyChat.app> [override-url]
#
# CI builds Release with CENTYCHAT_SERVER_URL=<override-url> on purpose. The check passes
# only if the binary still carries the production URL and none of the Debug override
# points (launch argument, Info.plist key, UI-test flags) or the override URL itself.
set -euo pipefail

app="${1:?usage: verify-release-server-lock.sh <CentyChat.app> [override-url]}"
override="${2:-https://override.invalid}"
binary="$app/CentyChat"
production="https://centychat-production.up.railway.app"

[[ -f "$binary" ]] || { echo "Binary not found: $binary" >&2; exit 1; }

failures=0
contains() { LC_ALL=C grep -a -q -F -- "$1" "$binary"; }

if contains "$production"; then
  echo "ok: production URL is compiled in"
else
  echo "FAIL: production URL $production is missing from the binary" >&2
  failures=$((failures + 1))
fi

# Every Debug-only test hook: launch arguments, environment keys and the UI-test account stand-in.
for forbidden in "$override" "-centychat-server-url" "CentyChatServerURL" "CENTYCHAT_UI_TESTING" "-reset-secure-state" "-centychat-color-scheme" "-centychat-ui-delivery-offline" "-centychat-stub-account" "CENTYCHAT_STUB_SIGNIN" "-allow-insecure-loopback" "UITestAccountRepository" "-centychat-ui-gallery"; do
  if contains "$forbidden"; then
    echo "FAIL: Release binary contains the Debug override point '$forbidden'" >&2
    failures=$((failures + 1))
  else
    echo "ok: no '$forbidden'"
  fi
done

if [[ $failures -ne 0 ]]; then
  echo "Release build is NOT locked to the production server ($failures problem(s))." >&2
  exit 1
fi
echo "Release build is locked to $production."
