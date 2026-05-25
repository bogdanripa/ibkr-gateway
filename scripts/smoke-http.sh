#!/usr/bin/env bash
# Local HTTP smoke test. Starts the app on PORT=$SMOKE_PORT (default 8082),
# curls the endpoints we care about, asserts expected status codes, and
# kills the app. Catches "app crashes on startup" and "routing/handler
# wiring is broken" — the kinds of issues that should never reach a deploy.
#
# Run: npm run smoke:http
#
# Requires GCP_PROJECT_ID in the env (and ADC for Firestore SDK init).

set -euo pipefail

# Source .env if present (not committed; see .env.example).
if [[ -f .env ]]; then
  set -a; . ./.env; set +a
fi

: "${GCP_PROJECT_ID:?GCP_PROJECT_ID required}"
: "${FIREBASE_API_KEY:?FIREBASE_API_KEY required (copy .env.example to .env)}"
PORT="${SMOKE_PORT:-8082}"
LOG=$(mktemp)
PID=

trap 'cleanup' EXIT

cleanup() {
  if [[ -n "$PID" ]] && kill -0 "$PID" 2>/dev/null; then
    kill "$PID" 2>/dev/null || true
    wait "$PID" 2>/dev/null || true
  fi
  if [[ "${KEEP_LOG:-0}" -ne 1 ]]; then rm -f "$LOG"; fi
}

assert_status() {
  local label="$1"
  local url="$2"
  local want="$3"
  local got
  got=$(curl -sS -m 5 -o /dev/null -w "%{http_code}" "$url" || echo "000")
  if [[ "$got" == "$want" ]]; then
    printf "  %-42s OK (%s)\n" "$label" "$got"
  else
    printf "  %-42s FAIL (want=%s got=%s)\n" "$label" "$want" "$got"
    echo "--- app log ---" >&2
    cat "$LOG" >&2 || true
    exit 1
  fi
}

assert_body_contains() {
  local label="$1"
  local url="$2"
  local needle="$3"
  local body
  body=$(curl -sS -m 5 "$url" || echo "")
  if [[ "$body" == *"$needle"* ]]; then
    printf "  %-42s OK\n" "$label"
  else
    printf "  %-42s FAIL\n" "$label"
    echo "expected to contain: $needle" >&2
    echo "got: $body" >&2
    exit 1
  fi
}

echo "Smoke (HTTP) on :$PORT"

# Start app in background, inheriting the env we just sourced.
PORT="$PORT" ./node_modules/.bin/tsx src/index.ts >"$LOG" 2>&1 &
PID=$!

# Wait for startup.
for i in {1..20}; do
  if curl -fsS -m 1 "http://127.0.0.1:${PORT}/healthz" >/dev/null 2>&1; then break; fi
  sleep 0.5
done

assert_body_contains "GET /healthz"                "http://127.0.0.1:${PORT}/healthz" "app ok"
assert_status "GET /console (200)"                  "http://127.0.0.1:${PORT}/console" 200
assert_body_contains "GET /console contains <title>" "http://127.0.0.1:${PORT}/console" "<title>IBKR Gateway"
assert_status "GET /console/api/me (401 no token)"  "http://127.0.0.1:${PORT}/console/api/me" 401

echo "All HTTP smoke checks passed."
