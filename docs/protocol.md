# WebSocket protocol

Worker connects to `wss://domain/ws` with:

```http
Authorization: Bearer <WORKER_TOKEN>
```

| Type | Direction | Purpose |
|------|-----------|---------|
| `worker.hello` | W→S | hostname, version, repos, pairing code, `agentModel`, `agentBackend`, `sessionLocked`, queue snapshot, `cliDiagnosis`, prompt templates |
| `worker.queue` | W→S | running + queued task id snapshot |
| `server.ack` | S→W | connected + optional pairing code + `pairedUsers` |
| `worker.ping` | S→W | health probe (`requestId`, `sentAt`) for `/status` latency |
| `worker.pong` | W→S | round-trip reply + disk probe + `sessionLocked` + queue snapshot |
| `worker.set_config` | S→W | set `agentModel` (persisted on PC) |
| `worker.config` | W→S | confirm current `agentModel` |
| `file.get` | S→W | read a project-relative file (`!alias /get path`) |
| `file.result` | W→S | inline text or base64 download (≤1.5 MB; path sandbox) |
| `task.create` | S→W | prompt + project alias + optional `files` / `agentModel` / `resumeMode` / `resumeContext` |
| `task.log` | W→S | stdout/stderr chunks |
| `task.approval_request` | W→S | risky command (+ optional cwd, git branch, screenshot URL) |
| `task.approval_response` | S→W | approve / reject |
| `task.status` | W→S | queued / running / succeeded / failed / cancelled (+ `exitCode`, `queuePosition`, `summary`, `agentThreadId`) |
| `task.cancel` | S→W | cancel running or queued task |
| `screenshot.capture` | S→W | desktop screenshots |
| `task.artifact` | W→S | screenshot payload (legacy); prefer HTTPS upload |

Schemas live in `@agentr/shared` (`packages/shared/src/protocol.ts`). Protocol version: **`0.3.0`**.

## Resume context

`task.create` may include:

- `resumeMode`: `"continue"` | `"fresh"`
- `resumeContext`: `{ parentTaskId, agentThreadId?, logSummary?, priorPrompt? }`

The worker tries native CLI resume (Codex thread / Cursor `--resume` when supported), otherwise injects prior log summary into the prompt.
