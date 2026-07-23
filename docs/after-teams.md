# After adding the bot to Teams

Do these **in order**. Do not send `/pair` until the tray shows **online**.

## A — Relay healthy

```bash
curl -sS https://YOUR_DOMAIN/health
# expect: {"ok":true,"mockMode":false,...}
```

## B — PC worker online

1. Copy `WORKER_TOKEN` from the VM.
2. `npm run dev:tray`
3. Paste relay URL + token, add a project, **Save & connect**
4. Status must be **online**

## C — Pair in Teams

1:1 chat with **AgentR**:

```
/pair AB12-CD34
```

Bot should confirm you are paired.

No reply? App ID/secret/tenant must match the Azure Bot. Check:

```bash
journalctl -u agent-relay-server -n 50 --no-pager
```

## D — Verify

```
/projects
```
or
```
/status
```

Shows PC hostname, aliases, **latency**, **last task**, and **project disk free space**. “Worker offline” → fix Step B.

## E — First task

```
[frontend] List the files in the project root
```

- `[frontend]` must match a project alias
- Adaptive Card shows live logs
- Approve / Reject if a risky command appears

## Checklist

| Done? | Item |
|-------|------|
| | `https://YOUR_DOMAIN/health` returns ok |
| | AgentR tray: token + URL saved, status **online** |
| | `/pair <code>` succeeds |
| | `/projects` shows aliases |
| | A prompt returns a task card with logs |
