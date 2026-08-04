# Desktop tray (Windows)

The supported desktop app is a **.NET WPF + WebView2** tray host with an in-process C# worker. It reuses the same HTML UI and the same config path as before.

Full build notes: [`apps/desktop/README.md`](../apps/desktop/README.md).

## Start (dev)

Requires [.NET 10 SDK](https://dotnet.microsoft.com/download) and [WebView2 Evergreen Runtime](https://developer.microsoft.com/microsoft-edge/webview2/).

```powershell
cd path\to\agentr-ai
npm run desktop:run
# or:
cd apps\desktop
dotnet run --project src\AgentR.Desktop\AgentR.Desktop.csproj
```

The **AgentR** settings window opens automatically when the worker token is missing (or when Start minimized is off).

## Portable publish (recommended)

```powershell
npm run desktop:publish
# → apps/desktop/publish/AgentR.exe
```

Self-contained `win-x64` folder — copy/run `AgentR.exe`. No Node/Electron required on the PC.

## MSI installer

```powershell
npm run desktop:msi
# → apps/desktop/dist/AgentR-<version>-win-x64.msi
```

Config always lives in `%USERPROFILE%\.agent-relay\config.json`.

**Backup:** Settings → **Export config…** (or tray menu **Export config…**) copies that file. It includes the worker token — store privately.

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
   - Optional: enable global **Dry run** to test without spawning the agent CLI
3. Click **Save & connect**

Home shows a **setup checklist**: token, agent CLI, relay online, paired in Teams.  
When the relay drops, Home shows a **connection banner** (reconnect countdown, unauthorized token, or re-pair needed after a relay restart).  
`/ss` fails clearly if Windows is locked; AgentR nudges displays awake when unlocked.

## Tray menu

- Status + pairing code
- **Open AgentR…** (settings)
- **Reconnect**
- Check for updates…
- Open config folder
- **Export config…**
- Quit

Double-click the tray icon to reopen settings.

## Status meanings

| Status | Meaning |
|--------|---------|
| offline | Not connected to the relay |
| connecting | Dialing WSS |
| online | Connected; ready for tasks |
| busy | Running a task |

Reconnect disconnect reasons call out **relay restart / network** vs **bad token**. After a relay restart with empty pairings, AgentR prompts you to send `/pair` again.

## Legacy Electron tray

`packages/tray` + `npm run dev:tray` / `npm run pack:tray` remain in the repo for reference but are **deprecated**. Prefer `npm run desktop:run` / `npm run desktop:publish`.

## Headless Node worker (optional/dev)

```powershell
node packages/worker/dist/cli.js init
node packages/worker/dist/cli.js
# or dry-run:
node packages/worker/dist/cli.js --dry-run
```

Next: [After adding the bot](./after-teams.md)
