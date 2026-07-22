# Local development (mock mode)

Run without Azure/Teams credentials:

```bash
cp packages/server/.env.example packages/server/.env
# WORKER_TOKEN=dev-test-token
# AGENTR_MOCK=1
npm run build
npm run dev:server
```

Worker (dry-run):

```json
{
  "relayUrl": "ws://127.0.0.1:8080/ws",
  "workerToken": "dev-test-token",
  "projects": { "frontend": "C:/path/to/repo" },
  "dryRun": true
}
```

```bash
node packages/worker/dist/cli.js --config path/to/config.json --dry-run
```

## Mock HTTP API

```bash
curl -sS http://localhost:3000/health
curl -sS http://localhost:3000/api/pairing-code

curl -X POST http://localhost:3000/api/messages ^
  -H "Content-Type: application/json" ^
  -d "{\"text\":\"/pair YOUR_CODE\",\"from\":{\"id\":\"u1\"}}"

curl -X POST http://localhost:3000/api/messages ^
  -H "Content-Type: application/json" ^
  -d "{\"text\":\"[frontend] hello --approve-test\",\"from\":{\"id\":\"u1\"}}"

curl -X POST http://localhost:3000/api/approve ^
  -H "Content-Type: application/json" ^
  -d "{\"taskId\":\"...\",\"approvalId\":\"...\",\"decision\":\"approve\"}"
```

Wizard dry-run on Windows (writes `./agent-relay-out`):

```bash
npm run cli:setup -- --dry-run --domain relay.example.com --email you@example.com --app-id <id> --app-secret <secret> --tenant-id <tid>
```
