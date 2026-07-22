# Desktop tray (Windows)

## Start (dev)

```powershell
cd path\to\agentr-ai
npm install
npm run build
npm run dev:tray
```

The **AgentR** settings window opens automatically when the worker token is missing.

## Windows `.exe`

Pack a portable app and NSIS installer (unsigned hobby build):

```powershell
.\scripts\build.ps1 -Exe
# or:
npm run pack:tray
```

Artifacts land in `packages/tray/release/`:

- `AgentR-0.1.0-portable.exe` — run anywhere, no install
- `AgentR-0.1.0-win-x64.exe` — one-click NSIS installer

Config still lives in `%USERPROFILE%\.agent-relay\config.json`.

## Configure

1. On the VM:
   ```bash
   grep WORKER_TOKEN /etc/agent-relay/config.env
   ```
2. In the AgentR window:
   - **Relay URL** → `wss://YOUR_DOMAIN/ws`
   - **Worker token** → paste from step 1
   - **Projects** → alias → local folder (e.g. `frontend` → `C:/dev/app`)
   - Optional: enable **Dry run** to test without Cursor CLI
3. Click **Save & connect**

Config is persisted to `%USERPROFILE%\.agent-relay\config.json`.

## Tray menu

- Status + pairing code
- **Open AgentR…** (settings)
- **Reconnect**
- Open config folder
- Quit

Double-click the tray icon to reopen settings. Click the pairing line to copy `/pair CODE`.

## Status meanings

| Status | Meaning |
|--------|---------|
| offline | Not connected to the relay |
| connecting | Dialing WSS |
| online | Connected; ready for tasks |
| busy | Running a task |

## Headless worker (no UI)

```powershell
node packages/worker/dist/cli.js init
node packages/worker/dist/cli.js
# or dry-run:
node packages/worker/dist/cli.js --dry-run
```

Next: [After adding the bot](./after-teams.md)
