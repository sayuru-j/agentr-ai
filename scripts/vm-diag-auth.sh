#!/bin/bash
set -e
echo "=== caddy ws block ==="
grep -A10 "handle /ws" /etc/caddy/Caddyfile || true
echo "=== token length ==="
awk -F= '/^WORKER_TOKEN=/{print length($2)}' /etc/agent-relay/config.env
echo "=== recent relay logs ==="
journalctl -u agent-relay-server -n 40 --no-pager
