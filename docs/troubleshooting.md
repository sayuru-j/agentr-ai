# Troubleshooting

## HTTPS fails / TLS alert / Schannel error

**Symptom:** `curl: (35) schannel…` or Node `tlsv1 alert internal error`.

**Cause:** Caddy has no certificate yet, or Let’s Encrypt couldn’t reach the VM.

1. DNS A record → VM public IP (`dig` / `Resolve-DnsName`).
2. NSG allows inbound **80** and **443**.
3. Reload and watch cert obtain:
   ```bash
   sudo systemctl reload caddy
   journalctl -u caddy -f
   ```
   Look for `certificate obtained successfully`.
4. Local app still up?
   ```bash
   curl -sS http://127.0.0.1:3000/health
   ```

Windows Schannel can still fail oddly even when Node/browser succeed — prefer:

```powershell
node -e "fetch('https://YOUR_DOMAIN/health').then(r=>r.text()).then(console.log)"
```

## App ID mismatch

**Symptom:** Teams bot never replies; server auth errors.

Azure Bot `msaAppId`, Teams zip `botId`, and `MICROSOFT_APP_ID` in `/etc/agent-relay/config.env` must be **identical**. Create the client secret on **that** App registration. Then:

```bash
sudo systemctl restart agent-relay-server
# regenerate agentr-teams.zip with the correct App ID and re-sideload
npm run cli:setup
```

## Tray connects then disconnects (4001 unauthorized)

The relay **rejected the worker token**.

1. On the VM get the current token (setup regenerates it each run):
   ```bash
   npm run cli:status
   # choose “Show worker token”
   # or: grep WORKER_TOKEN /etc/agent-relay/config.env
   ```
2. In AgentR tray → paste that **exact** token (no spaces/quotes) → **Save & connect**
3. Restart tray after saving if it was stuck reconnecting

Server logs show token length mismatch:
```bash
journalctl -u agent-relay-server -n 30 --no-pager | grep unauthorized
```

## Worker online but Teams says offline

Health:

```bash
curl -sS https://YOUR_DOMAIN/health
```

`workerOnline` should be `true` when the tray is connected. If false, token/URL mismatch or WSS blocked.

## `/pair` no reply

1. Confirm Teams channel enabled on the Azure Bot.
2. Messaging endpoint = `https://YOUR_DOMAIN/api/messages`.
3. Logs: `journalctl -u agent-relay-server -n 80 --no-pager`
4. Single Tenant bots need `MICROSOFT_APP_TENANT_ID` set.

## sudo: unable to resolve host

```bash
echo "127.0.0.1 $(hostname)" | sudo tee -a /etc/hosts
```

## git pull blocked by package-lock.json

```bash
git checkout -- package-lock.json
git pull
npm install
```
