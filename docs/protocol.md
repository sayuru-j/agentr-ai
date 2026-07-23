# WebSocket protocol

Worker connects to `wss://domain/ws` with:

```http
Authorization: Bearer <WORKER_TOKEN>
```

| Type | Direction | Purpose |
|------|-----------|---------|
| `worker.hello` | W→S | hostname, version, repos, pairing code, `agentModel` |
| `server.ack` | S→W | connected + optional pairing code + `pairedUsers` |
| `worker.ping` | S→W | health probe (`requestId`, `sentAt`) for `/status` latency |
| `worker.pong` | W→S | round-trip reply + optional per-project disk free/total |
| `worker.set_config` | S→W | set `agentModel` (persisted on PC) |
| `worker.config` | W→S | confirm current `agentModel` |
| `file.get` | S→W | read a project-relative file (`!alias /get path`) |
| `file.result` | W→S | inline text or base64 download (≤1.5 MB; path sandbox) |
| `task.create` | S→W | prompt + project alias + optional `files` / `agentModel` |
| `task.log` | W→S | stdout/stderr chunks |
| `task.approval_request` | W→S | risky command |
| `task.approval_response` | S→W | approve / reject |
| `task.status` | W→S | queued / running / succeeded / failed / cancelled (+ `exitCode`, `queuePosition`) |
| `task.cancel` | S→W | cancel running or queued task |
| `screenshot.capture` | S→W | desktop screenshots |
| `task.artifact` | W→S | screenshot payload (legacy); prefer HTTPS upload |

Schemas live in `@agentr/shared` (`packages/shared/src/protocol.ts`). Protocol version: `0.2.0`.
