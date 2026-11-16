#!/bin/sh
# Started as root (the default): makes the config folder writable for the hub's user, then drops
# root before the hub starts. So a fresh, root-owned config folder or volume just works.
# Started as another user (compose `user:`, TrueNAS): nothing to prepare, the hub starts as that user.
set -e

CONFIG_DIR="$(dirname "${CONFIG_PATH:-/config/services.yaml}")"

if [ "$(id -u)" = "0" ]; then
  PUID="${PUID:-1000}"
  PGID="${PGID:-1000}"
  mkdir -p "$CONFIG_DIR"
  # only what is not ours yet (a no-op on later starts; a read-only mount is left alone)
  find "$CONFIG_DIR" \( ! -user "$PUID" -o ! -group "$PGID" \) -exec chown "$PUID:$PGID" {} + 2>/dev/null \
    || echo "[entrypoint] cannot change the owner of $CONFIG_DIR: the config may not be editable from the page"
  exec setpriv --reuid "$PUID" --regid "$PGID" --clear-groups "$@"
fi

exec "$@"
