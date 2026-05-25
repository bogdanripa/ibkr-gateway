#!/usr/bin/env bash
# Runs on the VM. Idempotent. Called by .github/workflows/deploy.yml after
# the source tarball has been dropped at /tmp/ibkr-gateway.tar.gz.
#
# Responsibilities:
#   1. Ensure Node.js is installed (one-time bootstrap).
#   2. Extract the new source into /opt/ibkr-gateway-new and `npm install`.
#   3. Atomically swap into /opt/ibkr-gateway.
#   4. Install/refresh the systemd unit + env file (preserves env values).
#   5. Restart the service and report status.

set -euo pipefail

APP_DIR="/opt/ibkr-gateway"
NEW_DIR="/opt/ibkr-gateway-new"
OLD_DIR="/opt/ibkr-gateway-old"
TARBALL="/tmp/ibkr-gateway.tar.gz"
SVC="ibkr-gateway"

log() { echo "==> $*"; }

# 1. Node.js (LTS 20). Idempotent — skip if already installed and >=20.
need_node=1
if command -v node >/dev/null 2>&1; then
  major=$(node -p 'process.versions.node.split(".")[0]')
  if [[ "$major" -ge 20 ]]; then need_node=0; fi
fi
if [[ "$need_node" -eq 1 ]]; then
  log "installing Node.js 20 LTS"
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo apt-get -qq install -y nodejs
fi

node --version
npm --version

# 2. Extract new source.
if [[ ! -f "$TARBALL" ]]; then
  echo "missing $TARBALL — aborting" >&2
  exit 2
fi
sudo rm -rf "$NEW_DIR"
sudo mkdir -p "$NEW_DIR"
sudo tar -xzf "$TARBALL" -C "$NEW_DIR"
sudo rm -f "$TARBALL"

log "installing dependencies"
( cd "$NEW_DIR" && sudo npm ci --omit=dev=false --no-audit --no-fund )

# 3. Atomic swap.
if [[ -d "$APP_DIR" ]]; then
  sudo rm -rf "$OLD_DIR"
  sudo mv "$APP_DIR" "$OLD_DIR"
fi
sudo mv "$NEW_DIR" "$APP_DIR"

# 4. Systemd unit + env file.
sudo install -m 0644 "$APP_DIR/deploy/ibkr-gateway.service" "/etc/systemd/system/${SVC}.service"

# Always (re)write /etc/ibkr-gateway.env. The deploy workflow is the source
# of truth for Firebase values — if a workflow run passes new ones in, they
# win. Treat the file as ephemeral, populated from the workflow env.
log "writing /etc/ibkr-gateway.env"
sudo tee /etc/ibkr-gateway.env >/dev/null <<EOF
GCP_PROJECT_ID=${GCP_PROJECT_ID:-auto-trader-493814}
PORT=8080
FIREBASE_API_KEY=${FIREBASE_API_KEY:-}
FIREBASE_AUTH_DOMAIN=${FIREBASE_AUTH_DOMAIN:-}
FIREBASE_PROJECT_ID=${FIREBASE_PROJECT_ID:-}
FIREBASE_STORAGE_BUCKET=${FIREBASE_STORAGE_BUCKET:-}
FIREBASE_MESSAGING_SENDER_ID=${FIREBASE_MESSAGING_SENDER_ID:-}
FIREBASE_APP_ID=${FIREBASE_APP_ID:-}
EOF
sudo chmod 600 /etc/ibkr-gateway.env

# 5. Restart.
sudo systemctl daemon-reload
sudo systemctl enable "${SVC}.service" >/dev/null 2>&1 || true
sudo systemctl restart "${SVC}.service"
sleep 2
sudo systemctl --no-pager --full status "${SVC}.service" | head -20

# 6. Local healthcheck via the systemd-managed port (not via Caddy/CF).
log "local healthcheck on :8080"
for i in {1..10}; do
  if curl -fsS -m 3 "http://127.0.0.1:8080/healthz" >/dev/null 2>&1; then
    log "healthcheck OK"
    exit 0
  fi
  sleep 1
done

echo "healthcheck FAILED — last 30 journal lines:" >&2
sudo journalctl -u "${SVC}.service" -n 30 --no-pager >&2
exit 1
