# AgentR (AgentRelay)

Self-hosted bridge from **Microsoft Teams** to a **local Cursor CLI agent** on your workstation.

Speak or type a prompt in Teams → a small cloud VM relays it over WebSockets → your PC runs `agent chat` against local repos → live logs and shell **Approve / Reject** cards stream back to the same Teams thread.

## Documentation

All guides live in **[`docs/`](./docs/README.md)**:

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

## Quick commands

```bash
npm install
npm run build
npm run cli:setup      # on the VM
npm run dev:tray       # on the PC
npm run dev:server     # local mock relay
```

## License

MIT
