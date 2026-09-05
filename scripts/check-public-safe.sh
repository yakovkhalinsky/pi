#!/bin/sh
# check-public-safe.sh — guard the repo against accidental secret/private info.
#
# This repo is PUBLIC. Everything committed is world-visible, permanently.
# The scanner checks file names and content for known secret formats,
# credential fields with values, personal absolute paths, and files that
# must never be tracked. Run modes:
#
#   scripts/check-public-safe.sh            # scan staged changes (pre-commit)
#   scripts/check-public-safe.sh --all      # scan every tracked file (CI)
#
# Exit 0 = clean, 1 = findings (never ignore findings — fix or get an
# explicit human decision; do not relax the patterns to make it pass).
set -u

MODE="${1:---staged}"
cd "$(git rev-parse --show-toplevel 2>/dev/null || echo .)" || exit 1

# Files that must never be tracked (secrets, credentials, caches).
FILENAME_PAT='(^|/)(agent/)?(auth\.json|models\.json|models-store\.json)$|(^|/)agent/sessions/|(^|/)agent/pi-pretty/|(^|/)agent/npm/(node_modules/|package-lock\.json)|^node/|(^|/)\.env$|(^|/)team-demo/'

# Content that must never appear in tracked files.
CONTENT_PAT='gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16}|eyJ[A-Za-z0-9_-]{15,}\.eyJ[A-Za-z0-9_-]{15,}\.|BEGIN (RSA |EC |OPENSSH |PGP )?PRIVATE KEY|sk-[A-Za-z0-9_-]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|"apiKey"[[:space:]]*:[[:space:]]*"[^"]+"|EDEN_(ORG|USER)_ID=[A-Za-z0-9]|/(Users|home)/[A-Za-z0-9._-]+/|[A-Za-z0-9._%+-]+@(gmail|outlook|hotmail|protonmail|icloud)\.(com|me)'

# Placeholder values that are documented examples, not credentials.
ALLOW='EDEN_ORG_ID=<your-org>|EDEN_ORG_ID=my-org|EDEN_USER_ID=<your-user>|EDEN_USER_ID=my-user'

if [ "$MODE" = "--all" ]; then
  NAMES="$(git ls-files)"
else
  NAMES="$(git diff --cached --diff-filter=ACMR --name-only)"
  [ -n "$NAMES" ] || { echo "public-safe: nothing staged to scan"; exit 0; }
fi

FAIL=0

# 1. Forbidden file names
BADFILES=$(printf '%s\n' "$NAMES" | grep -E "$FILENAME_PAT" || true)
if [ -n "$BADFILES" ]; then
  echo "FORBIDDEN FILE(S) staged/tracked:" >&2
  printf '%s\n' "$BADFILES" | sed 's/^/  /' >&2
  FAIL=1
fi

# 2. Forbidden content
SCANLIST=""
for f in $NAMES; do [ -f "$f" ] && SCANLIST="$SCANLIST $f"; done
if [ -n "$SCANLIST" ]; then
  BADCONTENT=$(grep -InE "$CONTENT_PAT" $SCANLIST 2>/dev/null | grep -vE "$ALLOW" || true)
  if [ -n "$BADCONTENT" ]; then
    echo "SUSPICIOUS CONTENT in tracked/staged files:" >&2
    printf '%s\n' "$BADCONTENT" | sed 's/^/  /' >&2
    FAIL=1
  fi
fi

if [ "$FAIL" -ne 0 ]; then
  echo "" >&2
  echo "public-safe check FAILED ($MODE). Do NOT commit these. Fix or consult" >&2
  echo "the user — never weaken scripts/check-public-safe.sh to pass." >&2
  exit 1
fi

echo "public-safe: OK ($MODE)"