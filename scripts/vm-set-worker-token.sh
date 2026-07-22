#!/bin/bash
set -euo pipefail
TOKEN="$1"
sudo sed -i "s|^WORKER_TOKEN=.*|WORKER_TOKEN=${TOKEN}|" /etc/agent-relay/config.env
# ensure line exists
if ! grep -q '^WORKER_TOKEN=' /etc/agent-relay/config.env; then
  echo "WORKER_TOKEN=${TOKEN}" | sudo tee -a /etc/agent-relay/config.env >/dev/null
fi
LEN=$(awk -F= '/^WORKER_TOKEN=/{print length($2)}' /etc/agent-relay/config.env)
echo "updated_token_length=${LEN}"
sudo systemctl restart agent-relay-server
sleep 2
systemctl is-active agent-relay-server
curl -sS http://127.0.0.1:3000/health
echo
