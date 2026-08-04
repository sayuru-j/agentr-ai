# AgentR Desktop (.NET + WebView2)

Windows tray app that hosts the C# worker in-process and reuses the existing HTML/CSS/JS settings UI via WebView2.

## Requirements

- [.NET 10 SDK](https://dotnet.microsoft.com/download)
- [WebView2 Evergreen Runtime](https://developer.microsoft.com/microsoft-edge/webview2/) (usually already on Windows 10/11)

## Build / run

```powershell
cd apps\desktop
dotnet build AgentR.slnx
dotnet run --project src\AgentR.Desktop\AgentR.Desktop.csproj
```

From the repo root:

```powershell
npm run desktop:build
npm run desktop:run
```

## Publish (portable win-x64)

```powershell
cd apps\desktop
dotnet publish src\AgentR.Desktop\AgentR.Desktop.csproj -c Release -r win-x64 --self-contained true -o publish
```

Or from repo root: `npm run desktop:publish`

Output folder: `apps/desktop/publish/` — run `AgentR.exe`.

## MSI installer

```powershell
npm run desktop:msi
# → apps/desktop/dist/AgentR-<version>-win-x64.msi
```

Publishes the portable build, then packs it with WiX (`apps/desktop/installer/`). Requires the .NET SDK; WiX tooling is restored via NuGet on first run.

```powershell
msiexec /i apps\desktop\dist\AgentR-0.1.0-win-x64.msi
```

Config remains at `%USERPROFILE%\.agent-relay\config.json` (same as the legacy Electron tray).

## Solution layout

| Project | Role |
|---------|------|
| `AgentR.Protocol` | Protocol v0.3.0 DTOs + risk matcher |
| `AgentR.Worker` | WSS worker, task queue, Cursor/Codex runner, screenshots |
| `AgentR.Desktop` | WPF tray + WebView2 host + `window.agentr` bridge |
| `ui/` | Synced from `packages/tray/ui` |

## Legacy Electron tray

`packages/tray` (Electron) is **legacy**. Prefer this .NET app for day-to-day use. The Node worker package may still be useful for headless/dev; the Azure VM server/CLI stay Node.
