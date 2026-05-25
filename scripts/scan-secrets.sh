#!/usr/bin/env bash
# Scan the working tree for committable secrets. Exits non-zero if anything
# matches. Run from repo root: `bash scripts/scan-secrets.sh` or `npm run scan`.
#
# This is a belt-and-braces check on top of .gitignore — it catches things
# accidentally placed in a tracked path (e.g. a PEM pasted into a .ts file).

set -euo pipefail

EXIT=0

scan() {
  local pattern="$1"
  local label="$2"
  # -I skips binary files. --include only checks committable text files.
  local hits
  hits=$(grep -rEn --color=never -I \
    --exclude-dir=node_modules \
    --exclude-dir=.git \
    --exclude-dir=.claude \
    --exclude-dir=dist \
    --exclude=package-lock.json \
    --exclude='.env' \
    --exclude="$(basename "$0")" \
    -e "$pattern" . 2>/dev/null || true)
  if [[ -n "$hits" ]]; then
    echo ""
    echo "!! Found possible secret ($label):"
    echo "$hits"
    EXIT=1
  fi
}

# Like scan(), but skips a single given path. Use for known-public values
# (e.g. the Firebase web apiKey, which is a client identifier per Firebase).
scan_with_exclude() {
  local pattern="$1"
  local label="$2"
  local exclude_path="$3"
  local hits
  hits=$(grep -rEn --color=never -I \
    --exclude-dir=node_modules \
    --exclude-dir=.git \
    --exclude-dir=.claude \
    --exclude-dir=dist \
    --exclude=package-lock.json \
    --exclude='.env' \
    --exclude="$(basename "$0")" \
    -e "$pattern" . 2>/dev/null \
    | grep -v "^${exclude_path}:" || true)
  if [[ -n "$hits" ]]; then
    echo ""
    echo "!! Found possible secret ($label):"
    echo "$hits"
    EXIT=1
  fi
}

scan 'BEGIN (RSA |EC )?PRIVATE KEY' 'PEM private key'
scan 'BEGIN CERTIFICATE' 'PEM certificate'
# The Firebase web apiKey is a public client identifier (see
# src/console/firebase-config.ts). Exclude that one file from this rule.
scan_with_exclude 'AIzaSy[A-Za-z0-9_-]{30,}' 'Google API key (apiKey-like)' \
  './src/console/firebase-config.ts'
scan 'ibkr_[A-Za-z0-9_-]{20,}' 'IBKR Gateway API key (our format)'
scan '"private_key_id":\s*"[A-Fa-f0-9]+"' 'GCP service-account JSON'
scan 'xox[abprs]-[A-Za-z0-9-]{10,}' 'Slack token'
scan 'gh[pousr]_[A-Za-z0-9]{36,}' 'GitHub token'

if [[ $EXIT -eq 0 ]]; then
  echo "scan-secrets: clean."
fi
exit $EXIT
