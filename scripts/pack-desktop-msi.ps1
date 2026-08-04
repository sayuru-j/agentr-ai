#Requires -Version 5.1
<#
.SYNOPSIS
  Publish AgentR (self-contained win-x64) and build an MSI installer.

.NOTES
  Requires .NET SDK. WiX tooling is pulled via WixToolset.Sdk on first build.
  Output: apps/desktop/dist/AgentR-<version>-win-x64.msi
#>
param(
  [string]$Version = "",
  [switch]$SkipPublish
)

$ErrorActionPreference = "Stop"
$Root = Resolve-Path (Join-Path $PSScriptRoot "..")
$Desktop = Join-Path $Root "apps\desktop"
$PublishDir = Join-Path $Desktop "publish"
$InstallerProj = Join-Path $Desktop "installer\AgentR.Installer.wixproj"
$DistDir = Join-Path $Desktop "dist"

if (-not $Version) {
  $pkg = Get-Content (Join-Path $Root "package.json") -Raw | ConvertFrom-Json
  $Version = [string]$pkg.version
}
if (-not $Version) { $Version = "0.1.0" }

Write-Host "==> AgentR MSI pack (v$Version)" -ForegroundColor Cyan

if (-not $SkipPublish) {
  Write-Host "==> Publishing self-contained win-x64..."
  & dotnet publish (Join-Path $Desktop "src\AgentR.Desktop\AgentR.Desktop.csproj") `
    -c Release -r win-x64 --self-contained true -o $PublishDir
  if ($LASTEXITCODE -ne 0) { throw "dotnet publish failed ($LASTEXITCODE)" }
}

$exe = Join-Path $PublishDir "AgentR.exe"
if (-not (Test-Path $exe)) {
  throw "Missing $exe - run without -SkipPublish, or publish first."
}

Write-Host "==> Building MSI with WiX..."
$MsiOutDir = Join-Path $Desktop "installer\bin\Release"
& dotnet build $InstallerProj -c Release "-p:ProductVersion=$Version" -o $MsiOutDir
if ($LASTEXITCODE -ne 0) { throw "WiX build failed ($LASTEXITCODE)" }

$built = Get-ChildItem -Path $MsiOutDir -Filter "*.msi" -Recurse | Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $built) {
  throw "No .msi produced under $MsiOutDir"
}

New-Item -ItemType Directory -Force -Path $DistDir | Out-Null
$destName = "AgentR-$Version-win-x64.msi"
$dest = Join-Path $DistDir $destName
Copy-Item -Force $built.FullName $dest

Write-Host ""
Write-Host "MSI ready: $dest" -ForegroundColor Green
Write-Host ("Install: msiexec /i `"{0}`"" -f $dest)
