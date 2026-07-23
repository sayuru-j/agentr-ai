# WebSocket protocol

Worker connects to `wss://domain/ws` with:

```http
Authorization: Bearer <WORKER_TOKEN>
```

| Type | Direction | Purpose |
|------|-----------|---------|
| `worker.hello` | W→S | hostname, version, repos, pairing code, `agentModel` |
| `server.ack` | S→W | connected + optional pairing code + `pairedUsers` |
| `worker.set_config` | S→W | set `agentModel` (persisted on PC) |
| `worker.config` | W→S | confirm current `agentModel` |
| `task.create` | S→W | prompt + project alias + optional `files` / `agentModel` |
| `task.log` | W→S | stdout/stderr chunks |
| `task.approval_request` | W→S | risky command |
| `task.approval_response` | S→W | approve / reject |
| `task.status` | W→S | queued / running / succeeded / failed / cancelled (+ `exitCode`, `queuePosition`) |
| `task.cancel` | S→W | cancel running or queued task |
| `screenshot.capture` | S→W | desktop screenshots |
| `task.artifact` | W→S | screenshot payload (legacy); prefer HTTPS upload |

Schemas live in `@agentr/shared` (`packages/shared/src/protocol.ts`). Protocol version: `0.2.0`.
