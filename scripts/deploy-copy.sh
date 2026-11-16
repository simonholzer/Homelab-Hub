#!/usr/bin/env bash
# Runs on your computer (Git Bash on Windows, or any shell with git and ssh). Copies the committed project to the NAS (~/homelab-hub).
# Then build there with:  ssh -t nas "sudo bash ~/homelab-hub/scripts/nas-build.sh"
# Another host or address:  HOST=user@nas-vpn-address bash scripts/deploy-copy.sh
set -euo pipefail
cd "$(dirname "$0")/.."
HOST="${HOST:-nas}"

if [ -n "$(git status --porcelain)" ]; then
  echo "!! There are uncommitted changes. The NAS gets the last commit only:"
  git status --short
fi

echo "==> Copying $(git rev-parse --short HEAD) to $HOST:~/homelab-hub"
ssh "$HOST" 'rm -rf ~/homelab-hub && mkdir -p ~/homelab-hub'
git archive --format=tar HEAD | ssh "$HOST" 'tar -x -C ~/homelab-hub'
ssh "$HOST" 'echo "    $(du -sh ~/homelab-hub | cut -f1) copied"'
