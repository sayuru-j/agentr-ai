# AgentR

Self-hosted bridge from **Microsoft Teams** to a **local agent CLI** (Cursor or Codex) on your PC.

Type in Teams → a small cloud VM relays over WebSockets → your workstation runs the agent against local repos → live task cards (and optional desktop screenshots) come back to the same chat.

<p align="center">
  <img src="./docs/media/agent-r-bot-teams-chat.png" alt="AgentR in Microsoft Teams — pair and status" width="720" />
</p>

## How it works

1. Run the **desktop tray** on your PC (Home / Projects / Settings).
2. Sideload the **AgentR** bot in Teams and `/pair` with the code from the tray.
3. Map folders to short aliases, then prompt with `!alias …`.

| In Teams | What it does |
|----------|----------------|
| `/pair <code>` | Link this chat to your PC |
| `!alias your prompt` | Run agent in that project (attach files → `.agentr-inbox/`) |
| `!alias /continue [prompt]` | Resume last task for that project |
| `!alias /run <shortcut> [extra]` | Expand a prompt template from tray config |
| `/continue [prompt]` | Resume last task in this chat |
| `/queue` | Show running and queued tasks |
| `/history [n]` | Recent tasks in this chat (persisted on VM) |
| `/prompts` | List configured prompt shortcuts |
| `/projects` | List project aliases |
| `/last` | Last task prompt / exit / short log |
| `/model` · `/model auto` | Show or set the agent model |
| `/ss` | Preview screenshots (all monitors) |
| `/sshq` | High-quality screenshots |
| `/help` | Full command list |

AgentR only replies to messages starting with `!` or `/`.

## Desktop app

<p align="center">
  <img src="./docs/media/home.png" alt="AgentR Home — pairing code and status" width="360" />
  &nbsp;
  <img src="./docs/media/projects.png" alt="AgentR Projects — aliases for Teams" width="360" />
</p>

<p align="center">
  <img src="./docs/media/settings.png" alt="AgentR Settings — relay URL, token, model" width="360" />
</p>

- **Home** — online status, `/pair` code, reconnect, CLI diagnosis checklist  
- **Projects** — alias → folder, per-project guardrails, prompt shortcuts  
- **Settings** — relay URL, worker token, Cursor/Codex backend, **Test CLI**, git context, session lock policy

## Quick start

```bash
npm install
npm run build
# or on Windows: .\scripts\build.ps1
# Windows .exe:  .\scripts\build.ps1 -Exe   → packages/tray/release/
#   portable.exe = no install · win-x64.exe = NSIS installer (both unsigned)

npm run cli:setup      # on the VM
npm run dev:tray       # on the PC (dev)
```

Full guides: **[`docs/`](./docs/README.md)**

| Guide | |
|-------|--|
| [Architecture](./docs/architecture.md) | Packages & data flow |
| [Azure & Teams](./docs/azure-teams.md) | Bot, secret, channel, sideload |
| [VM setup](./docs/vm-setup.md) | Wizard, Caddy, ports |
| [Desktop tray](./docs/desktop-tray.md) | Settings UI & worker token |
| [After adding the bot](./docs/after-teams.md) | Pair → first prompt |
| [Troubleshooting](./docs/troubleshooting.md) | TLS, App ID, offline worker |
| [Protocol](./docs/protocol.md) | WSS messages |
| [Local development](./docs/local-dev.md) | Mock mode |

## License

MIT
