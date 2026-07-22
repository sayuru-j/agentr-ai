# AgentRelay (AgentR)

Self-hosted bridge from **Microsoft Teams** to a **local Cursor CLI agent** on your workstation.

Speak or type a prompt in Teams → a small cloud VM relays it over WebSockets → your PC runs `agent chat` against local repos → live logs and shell **Approve / Reject** cards stream back to the same Teams thread.

## Architecture

```
Teams (any device)  --HTTPS webhook-->  VM (Caddy + agent-relay-server)
                                              ^
                                              | WSS (outbound from PC)
                                              |
                                        Host PC (tray + worker)
                                              |
                                              v
                                        Cursor CLI (`agent chat`)
```

| Package | Role |
|---------|------|
| `@agentr/shared` | WSS protocol (Zod) + auth + risk patterns |
| `@agentr/server` | Teams Bot Framework adapter + WSS hub |
| `@agentr/cli` | VM setup wizard (`agent-relay setup`) |
| `@agentr/worker` | Outbound worker daemon / library |
| `@agentr/tray` | Windows system tray shell |

## Prerequisites

- **VM:** Ubuntu/Debian with a public DNS A record (wizard installs git, nvm, Node 25.0.0, and Caddy)
- **Host PC:** Windows 10+, Node 20+, [Cursor CLI](https://cursor.com) (`agent` on PATH)
- **Teams:** Azure Bot / Teams app (App ID + Secret)

## 1. Azure / Teams app

1. Create an Azure Bot (Multi-tenant or Single-tenant).
2. Note **Microsoft App ID** and create a **client secret**.
3. Set the bot messaging endpoint to `https://YOUR_DOMAIN/api/messages` (after DNS + Caddy are live).
4. Enable the Teams channel on the bot.

## 2. VM setup (wizard)

Clone this repo on the VM (or copy packages), install dependencies, build, then run the wizard:

```bash
git clone <repo-url> agentr-ai && cd agentr-ai
npm install
npm run build
node packages/cli/dist/index.js setup
# or after linking: npm run setup
```

The wizard checks dependencies and, on Debian/Ubuntu, can install:

- **git** + **curl** (apt)
- **nvm** \`v0.40.6\` and **Node.js \`25.0.0\`** as the default (\`nvm use\` / \`nvm alias default\`)
- **Caddy** (official apt repo)

Use \`--yes\` to skip confirm prompts. It also writes:

- `config.env` — App ID/Secret, `WORKER_TOKEN`, ports
- `caddy/Caddyfile` — TLS + reverse proxy to `:3000` (bot) and `:8080` (`/ws`)
- `systemd/agent-relay-server.service`
- `agentr-teams.zip` — upload / sideload in Teams
- `install-services.sh` — enable systemd + Caddy on Linux

Copy the printed **WORKER_TOKEN** for the PC tray config.

On Windows (dev), the wizard defaults to `--dry-run` style output under `./agent-relay-out`.

```bash
node packages/cli/dist/index.js setup --dry-run --domain relay.example.com --email you@example.com --app-id <id> --app-secret <secret>
node packages/cli/dist/index.js status --dry-run
node packages/cli/dist/index.js token rotate --dry-run
```

Start the server locally for development:

```bash
cp packages/server/.env.example packages/server/.env
# set WORKER_TOKEN; AGENTR_MOCK=1 skips real Teams credentials
npm run dev:server
```

## 3. Host PC (tray / worker)

### Tray app (recommended)

```bash
npm run build
npm run dev:tray
```

The tray opens an **AgentR** settings window where you can:

- Paste **Relay URL** (`wss://YOUR_DOMAIN/ws`)
- Paste **Worker token** (from VM `config.env`)
- Add project aliases → local paths
- Click **Save & connect** (persists to `%USERPROFILE%\.agent-relay\config.json`)

Tray menu: Open AgentR…, pairing code, Reconnect, Quit. Double-click the tray icon to reopen settings.

### Headless worker (no tray)

```bash
npm run dev:worker
# or
node packages/worker/dist/cli.js --dry-run
```

## 4. After adding the bot to Teams

Do these in order. Do not skip ahead to `/pair` until the tray is **online**.

### Step A — Confirm the relay is healthy (VM)

```bash
curl -sS https://YOUR_DOMAIN/health
# expect: {"ok":true,"mockMode":false,...}
```

If that fails, fix Caddy/DNS/NSG before continuing.

### Step B — Configure the PC worker

1. On the VM, copy the token:
   ```bash
   grep WORKER_TOKEN /etc/agent-relay/config.env
   ```
2. On the PC start the tray:
   ```powershell
   npm run build
   npm run dev:tray
   ```
3. In the **AgentR** window:
   - Relay URL → `wss://YOUR_DOMAIN/ws`
   - Worker token → paste from step 1
   - Add at least one project alias → local folder
   - Click **Save & connect**
4. Confirm status shows **online**.  
   If it stays offline, check the token/URL and click **Reconnect**.

### Step C — Pair your Teams user

1. Open a **1:1 chat** with the **AgentR** bot in Teams (the app you sideloaded).
2. Click the pairing code in the tray menu (or read it from the tray tooltip / terminal).
3. Send exactly:
   ```
   /pair AB12-CD34
   ```
   (use your real code)
4. Bot should reply that you are paired.

If there is **no reply**:
- App ID/secret/tenant in `/etc/agent-relay/config.env` must match the Azure Bot
- Check VM logs: `journalctl -u agent-relay-server -n 50 --no-pager`

### Step D — Verify worker from Teams

```
/projects
```
or
```
/status
```

You should see your PC hostname and project aliases.  
If it says worker offline, the tray is not connected — go back to Step B.

### Step E — Run your first task

```
[frontend] List the files in the project root
```

- `[frontend]` must match a key in `projects` in `config.json`
- An Adaptive Card should appear with live logs
- If a risky command is detected, tap **Approve** or **Reject**

### Quick checklist

| Done? | Item |
|-------|------|
| | `https://YOUR_DOMAIN/health` returns ok |
| | AgentR tray: token + URL saved, status **online** |
| | `/pair <code>` succeeds in Teams |
| | `/projects` shows your aliases |
| | A prompt returns a task card with logs |

### Mock mode (no Teams)

With `AGENTR_MOCK=1` on the server:

```bash
curl -X POST http://localhost:3000/api/messages ^
  -H "Content-Type: application/json" ^
  -d "{\"text\":\"/pair YOUR_CODE\",\"from\":{\"id\":\"u1\"}}"

curl -X POST http://localhost:3000/api/messages ^
  -H "Content-Type: application/json" ^
  -d "{\"text\":\"[frontend] hello --approve-test\",\"from\":{\"id\":\"u1\"}}"
```

Health: `GET http://localhost:3000/health`  
Current pairing code: `GET http://localhost:3000/api/pairing-code`  
Mock approve: `POST http://localhost:3000/api/approve` with `{ "taskId", "approvalId", "decision": "approve" }`

## Protocol (WSS)

Worker connects to `wss://domain/ws` with `Authorization: Bearer <WORKER_TOKEN>`.

| Type | Direction | Purpose |
|------|-----------|---------|
| `worker.hello` | W→S | hostname, version, repos, pairing code |
| `task.create` | S→W | prompt + project alias |
| `task.log` | W→S | stdout/stderr chunks |
| `task.approval_request` | W→S | risky command |
| `task.approval_response` | S→W | approve / reject |
| `task.status` | W→S | running / succeeded / failed / cancelled |

## Security notes

- PC opens **outbound** WSS only — no inbound ports on the home network.
- Pair with OTP so other org users cannot trigger tasks.
- Risk heuristics pause for phone approval (`rm -rf`, `git reset --hard`, `npm install`, etc.).
- Keep `WORKER_TOKEN` and App Secret private; rotate with `agent-relay token rotate`.

## License

MIT
