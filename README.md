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

- **VM:** Ubuntu/Debian, public DNS A record, Node 20+, Caddy, Git
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

The wizard writes:

- `config.env` — App ID/Secret, `WORKER_TOKEN`, ports
- `caddy/Caddyfile` — TLS + reverse proxy to `:3000` (bot) and `:8080` (`/ws`)
- `systemd/agent-relay-server.service`
- `teams-app.zip` — upload / sideload in Teams
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

### Config

```bash
npm run build -w @agentr/worker
node packages/worker/dist/cli.js init
```

Edit `%USERPROFILE%\.agent-relay\config.json`:

```json
{
  "relayUrl": "wss://YOUR_DOMAIN/ws",
  "workerToken": "paste-from-vm-config.env",
  "projects": {
    "frontend": "C:/dev/frontend",
    "backend": "C:/dev/backend"
  },
  "agentCommand": "agent",
  "dryRun": false
}
```

Set `"dryRun": true` to test without Cursor CLI (streams a fake run; prompts containing `npm install` or `--approve-test` exercise approval cards).

### Tray app

```bash
npm run dev:tray
```

Tray menu: status, pairing code, Reconnect, Open config, Quit.

### Headless worker (no tray)

```bash
npm run dev:worker
# or
node packages/worker/dist/cli.js --dry-run
```

## 4. Pair and run a prompt

1. Ensure tray/worker shows **online** and a pairing code.
2. In Teams, message the AgentRelay bot:
   ```
   /pair AB12-CD34
   ```
3. Check worker projects:
   ```
   /projects
   ```
4. Send a task (optional project alias):
   ```
   [frontend] Add a loading spinner to the settings page
   ```
5. When the agent hits a risky shell command, tap **Approve** or **Reject** on the Adaptive Card.

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
