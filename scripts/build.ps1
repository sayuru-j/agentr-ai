#Requires -Version 5.1
<#
.SYNOPSIS
  Pre-release build for AgentR (hobby monorepo).

.DESCRIPTION
  Installs workspace deps (optional skip), builds all packages in order,
  and prints how to run the tray / deploy the server.

.EXAMPLE
  .\scripts\build.ps1

.EXAMPLE
  .\scripts\build.ps1 -SkipInstall -Typecheck
#>
[CmdletBinding()]
param(
  [switch]$SkipInstall,
  [switch]$Typecheck,
  [switch]$Clean
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
if (-not (Test-Path (Join-Path $Root "package.json"))) {
  $Root = $PSScriptRoot
  if (-not (Test-Path (Join-Path $Root "package.json"))) {
    Write-Error "Run from the agentr-ai repo (package.json not found)."
  }
}

Set-Location $Root

function Write-Step([string]$Message) {
  Write-Host ""
  Write-Host "==> $Message" -ForegroundColor Cyan
}

function Assert-LastExit {
  param([string]$Label)
  if ($LASTEXITCODE -ne 0) {
    throw "$Label failed (exit $LASTEXITCODE)"
  }
}

Write-Host "AgentR pre-release build" -ForegroundColor Green
Write-Host "Root: $Root"

# Node check
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  throw "Node.js not found on PATH. Install Node >= 20."
}
$nodeVersion = (node -v).Trim()
Write-Host "Node: $nodeVersion"

if ($Clean) {
  Write-Step "Cleaning dist folders"
  Get-ChildItem -Path (Join-Path $Root "packages") -Directory | ForEach-Object {
    $dist = Join-Path $_.FullName "dist"
    if (Test-Path $dist) {
      Remove-Item -Recurse -Force $dist
      Write-Host "  removed $($_.Name)/dist"
    }
  }
}

if (-not $SkipInstall) {
  Write-Step "npm install"
  npm install
  Assert-LastExit "npm install"
} else {
  Write-Host "Skipping npm install (-SkipInstall)"
}

Write-Step "npm run build (shared -> server -> worker -> cli -> tray)"
npm run build
Assert-LastExit "npm run build"

if ($Typecheck) {
  Write-Step "npm run typecheck"
  npm run typecheck
  Assert-LastExit "npm run typecheck"
}

Write-Host ""
Write-Host "Build OK." -ForegroundColor Green
Write-Host ""
Write-Host "Next steps:"
Write-Host "  Desktop tray:  npm run dev:tray"
Write-Host "  Local server:  npm run dev:server"
Write-Host "  VM deploy:     git pull && npm install && npm run build && sudo systemctl restart agent-relay-server"
Write-Host ""
Write-Host "Teams tips:"
Write-Host "  Pair:   /pair <code>"
Write-Host "  Task:   !alias your prompt"
Write-Host "  Shots:  /ss (preview)  |  /sshq (high quality)"
Write-Host ""
