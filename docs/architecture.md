# Architecture

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
| `@agentr/tray` | Windows system tray + settings UI |

## Security model

- The PC opens **outbound** WSS only — no inbound ports on the home network.
- Pair with OTP (`/pair`) so other org users cannot trigger tasks.
- Risk heuristics pause for phone approval (`rm -rf`, `git reset --hard`, `npm install`, etc.).
- Keep `WORKER_TOKEN` and App Secret private; rotate with `npm run cli -- token rotate` on the VM.
