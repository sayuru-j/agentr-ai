# Desktop tray (Windows)

## Start (dev)

```powershell
cd path\to\agentr-ai
npm install
npm run build
npm run dev:tray
```

The **AgentR** settings window opens automatically when the worker token is missing.

## Windows builds: Install vs Portable

```powershell
.\scripts\build.ps1 -Exe
# or:
npm run pack:tray
```

Artifacts in `packages/tray/release/`:

| Artifact | When to use |
|----------|-------------|
| **`AgentR-*-portable.exe`** | No install. Double-click to run. Ideal for trying AgentR or keeping it on a USB drive. Config still goes to `%USERPROFILE%\.agent-relay\`. |
| **`AgentR-*-win-x64.exe`** | One-click **NSIS installer** — Start Menu / desktop shortcuts. Prefer this for a daily driver on one PC. |

Both builds are **unsigned** hobby packages (`signAndEditExecutable: false`):

- Windows **SmartScreen** may warn on first run → *More info* → *Run anyway*.
- Building the `.exe` yourself may need **Developer Mode** (symlink privilege) if electron-builder’s winCodeSign extract fails; end users of the finished `.exe` do **not** need Dev Mode.
- Code signing (a purchased cert) would remove SmartScreen friction — not included in this hobby setup.

Config always lives in `%USERPROFILE%\.agent-relay\config.json` (same for portable and installed).

**Backup:** Settings → **Export config…** (or tray menu **Export config…**) copies that file to a path you choose. It includes the worker token — store the export privately.

## Configure

1. On the VM:
   ```bash
   grep WORKER_TOKEN /etc/agent-relay/config.env
   ```
2. In the AgentR window:
   - **Relay URL** → `wss://YOUR_DOMAIN/ws`
   - **Worker token** → paste from step 1
   - **Agent command** → leave as `agent`, or click **Find** (searches PATH and `%LOCALAPPDATA%\cursor-agent`)
   - **Projects** → alias → folder, optional per-project **model** / **dry run**
   - **Start with Windows** / **Start minimized to tray** / **Check for updates**
   - Optional: enable global **Dry run** to test without Cursor CLI
3. Click **Save & connect**

Home shows a **setup checklist**: token, agent CLI, relay online, paired in Teams.  
When the relay drops, Home shows a **connection banner** (reconnect countdown, unauthorized token, or re-pair needed after a relay restart).  
`/ss` fails clearly if Windows is locked; AgentR nudges displays awake when unlocked.

## Tray menu

- Status + pairing code
- **Open AgentR…** (settings)
- **Reconnect**
- Open config folder
- **Export config…**
- Quit

Double-click the tray icon to reopen settings. Click the pairing line to copy `/pair CODE`.

## Status meanings

| Status | Meaning |
|--------|---------|
| offline | Not connected to the relay |
| connecting | Dialing WSS |
| online | Connected; ready for tasks |
| busy | Running a task |

Reconnect disconnect reasons call out **relay restart / network** vs **bad token**. After a relay restart with empty pairings, AgentR prompts you to send `/pair` again.

## Headless worker (no UI)

```powershell
node packages/worker/dist/cli.js init
node packages/worker/dist/cli.js
# or dry-run:
node packages/worker/dist/cli.js --dry-run
```

Next: [After adding the bot](./after-teams.md)
