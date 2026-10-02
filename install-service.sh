#!/usr/bin/env bash
# Installs the pr-triage server as a systemd --user service, so it starts at login.
# Run it on the machine whose browser runs the userscript (the host, not a container without systemd).
set -euo pipefail
REPO="$(cd "$(dirname "$0")" && pwd)"
PORT="${PR_TRIAGE_PORT:-7788}"
NODE="$(command -v node || true)"
if [[ -z "$NODE" ]]; then echo "node not found; install Node 22 or newer" >&2; exit 1; fi
major="$("$NODE" -p 'process.versions.node.split(".")[0]')"
if (( major < 22 )); then echo "node $major is too old; pr-triage needs Node 22 or newer" >&2; exit 1; fi
if ! command -v systemctl >/dev/null || ! systemctl --user show-environment >/dev/null 2>&1; then
  echo "no systemd --user here; run the server by hand:" >&2
  echo "  setsid nohup $REPO/bin/pr-triage serve > ~/.local/state/pr-triage.log 2>&1 < /dev/null &" >&2
  exit 1
fi
UNIT="$HOME/.config/systemd/user/pr-triage.service"
mkdir -p "$(dirname "$UNIT")"
cat > "$UNIT" <<UNIT
[Unit]
Description=pr-triage local server for the GitHub review userscript

[Service]
Environment=PR_TRIAGE_PORT=$PORT
ExecStart=$NODE $REPO/bin/pr-triage serve
Restart=on-failure

[Install]
WantedBy=default.target
UNIT
systemctl --user daemon-reload
systemctl --user enable --now pr-triage.service
echo "pr-triage runs on http://127.0.0.1:$PORT — install the userscript from http://127.0.0.1:$PORT/pr-triage.user.js"
