# Creates a multi-size .ico from logo.png
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing

$root = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
if (-not (Test-Path (Join-Path $PSScriptRoot "..\..\packages\assets\logo.png"))) {
  # script lives in apps/desktop/assets when run from there — support both
}

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..\..\..")
$pngPath = Join-Path $repoRoot "packages\assets\logo.png"
$outDir = Join-Path $repoRoot "apps\desktop\assets"
$icoPath = Join-Path $outDir "logo.ico"
$pngOut = Join-Path $outDir "logo.png"

New-Item -ItemType Directory -Force -Path $outDir | Out-Null
Copy-Item -Force $pngPath $pngOut

$bmp = [System.Drawing.Bitmap]::FromFile($pngPath)
$sizes = @(16, 32, 48, 256)
$images = New-Object System.Collections.Generic.List[byte[]]

foreach ($s in $sizes) {
  $resized = New-Object System.Drawing.Bitmap $bmp, $s, $s
  $imgMs = New-Object System.IO.MemoryStream
  $resized.Save($imgMs, [System.Drawing.Imaging.ImageFormat]::Png)
  $images.Add($imgMs.ToArray())
  $resized.Dispose()
  $imgMs.Dispose()
}
$bmp.Dispose()

$ms = New-Object System.IO.MemoryStream
$bw = New-Object System.IO.BinaryWriter($ms)
$bw.Write([Int16]0)
$bw.Write([Int16]1)
$bw.Write([Int16]$sizes.Count)

$offset = 6 + (16 * $sizes.Count)
for ($i = 0; $i -lt $sizes.Count; $i++) {
  $s = $sizes[$i]
  $w = 0
  $h = 0
  if ($s -lt 256) { $w = $s; $h = $s }
  $bw.Write([byte]$w)
  $bw.Write([byte]$h)
  $bw.Write([byte]0)
  $bw.Write([byte]0)
  $bw.Write([Int16]1)
  $bw.Write([Int16]32)
  $bw.Write([Int32]$images[$i].Length)
  $bw.Write([Int32]$offset)
  $offset += $images[$i].Length
}
foreach ($img in $images) { $bw.Write($img) }
$bw.Flush()
[IO.File]::WriteAllBytes($icoPath, $ms.ToArray())
$bw.Dispose()
$ms.Dispose()

Write-Host "Wrote $icoPath ($((Get-Item $icoPath).Length) bytes)"
