# VM setup

## Prerequisites

- Ubuntu/Debian VM with a **public DNS A record** pointing at the VM IP
- Azure NSG allowing inbound **80** and **443** (required for Let’s Encrypt + HTTPS/WSS)
- SSH access

Open NSG ports if needed:

```bash
az network nsg rule create -g <rg> --nsg-name <nsg> -n AllowHTTP --priority 110 \
  --access Allow --protocol Tcp --direction Inbound --destination-port-ranges 80 \
  --source-address-prefixes '*' --source-port-ranges '*' --destination-address-prefixes '*'

az network nsg rule create -g <rg> --nsg-name <nsg> -n AllowHTTPS --priority 120 \
  --access Allow --protocol Tcp --direction Inbound --destination-port-ranges 443 \
  --source-address-prefixes '*' --source-port-ranges '*' --destination-address-prefixes '*'
```

## Install & wizard

```bash
git clone <repo-url> agentr-ai && cd agentr-ai
npm install
npm run build
npm run cli:setup
# or: node packages/cli/dist/index.js setup
```

The wizard can install:

- **git** + **curl** (apt)
- **nvm** `v0.40.6` and **Node.js `25.0.0`** as default
- **Caddy** (official apt repo)

It writes under `/etc/agent-relay/`:

| File | Purpose |
|------|---------|
| `config.env` | App ID/Secret/Tenant, `WORKER_TOKEN`, ports |
| `caddy/Caddyfile` | TLS + proxy to `:3000` and `:8080/ws` |
| `systemd/agent-relay-server.service` | Relay service unit |
| `agentr-teams.zip` | Teams sideload package |
| `install-services.sh` | Enable systemd + Caddy |

Save the printed **WORKER_TOKEN** for the desktop tray.

Useful commands:

```bash
npm run cli:status
# interactive menu: reload Caddy, restart relay, logs, show token/pair, …

npm run cli -- status --no-menu
npm run cli -- status --action reload-caddy
npm run cli -- token rotate
systemctl status agent-relay-server --no-pager
systemctl status caddy --no-pager
journalctl -u agent-relay-server -n 50 --no-pager
journalctl -u caddy -n 50 --no-pager
```

## Health checks

```bash
curl -sS http://127.0.0.1:3000/health
curl -sS https://YOUR_DOMAIN/health
# expect: {"ok":true,"mockMode":false,...}
```

If local health works but HTTPS fails, see [Troubleshooting](./troubleshooting.md).

## Hostname warning

If you see `sudo: unable to resolve host …`:

```bash
echo "127.0.0.1 $(hostname)" | sudo tee -a /etc/hosts
```

Next: [Azure & Teams](./azure-teams.md) (endpoint + sideload) → [Desktop tray](./desktop-tray.md)
