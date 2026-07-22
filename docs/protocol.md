# WebSocket protocol

Worker connects to `wss://domain/ws` with:

```http
Authorization: Bearer <WORKER_TOKEN>
```

| Type | Direction | Purpose |
|------|-----------|---------|
| `worker.hello` | W→S | hostname, version, repos, pairing code |
| `server.ack` | S→W | connected + optional pairing code |
| `task.create` | S→W | prompt + project alias |
| `task.log` | W→S | stdout/stderr chunks |
| `task.approval_request` | W→S | risky command |
| `task.approval_response` | S→W | approve / reject |
| `task.status` | W→S | running / succeeded / failed / cancelled |
| `task.cancel` | S→W | cancel running task |

Schemas live in `@agentr/shared` (`packages/shared/src/protocol.ts`).
