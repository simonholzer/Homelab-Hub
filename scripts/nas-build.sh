#!/usr/bin/env bash
# Runs ON the TrueNAS machine, as root (via sudo):
#   ssh -t nas "sudo bash ~/homelab-hub/scripts/nas-build.sh"
# Creates the config folder (owned by the TrueNAS apps user 568) and builds the image.
set -euo pipefail

SRC_DIR="$(cd "$(dirname "$0")/.." && pwd)"
DATA_DIR="${DATA_DIR:-/mnt/tank/appdata/homelab-hub}"   # change "tank" to your pool
IMAGE="homelab-hub:latest"

echo "==> Config folder: $DATA_DIR"
mkdir -p "$DATA_DIR"
chown 568:568 "$DATA_DIR"
chmod 750 "$DATA_DIR"

if [ "${1:-}" = "--replace-config" ]; then
  # Overwrites the NAS copy of the config with the one from this project (the old one is kept as .bak).
  # Needed when the example config gained something that has to be live (the NAS copy is the source of truth).
  if [ -f "$DATA_DIR/services.yaml" ]; then cp "$DATA_DIR/services.yaml" "$DATA_DIR/services.yaml.bak"; fi
  cp "$SRC_DIR/config/services.yaml" "$DATA_DIR/services.yaml"
  chown 568:568 "$DATA_DIR/services.yaml" "$DATA_DIR/services.yaml.bak" 2>/dev/null || true
  echo "==> Config replaced (old one: $DATA_DIR/services.yaml.bak)"
fi

echo "==> Building $IMAGE from $SRC_DIR"
docker build -t "$IMAGE" "$SRC_DIR"

echo "==> Cleaning up old dangling images"
docker image prune -f >/dev/null

if docker ps -a --format '{{.Names}}' | grep -q 'homelab-hub'; then
  echo "==> The app is already installed: restart it in TrueNAS (Apps -> homelab-hub -> Restart) to use the new image"
fi

echo "==> Done: $(docker image inspect "$IMAGE" --format '{{.Id}} {{.Created}}')"
