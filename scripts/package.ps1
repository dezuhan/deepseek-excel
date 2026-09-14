<#
.SYNOPSIS
  Builds a distributable ZIP of DeepSeek Excell by dezuhan.

.DESCRIPTION
  Stages the project into a temporary folder (excluding node_modules, .env, logs, caches and
  previous archives), optionally rebuilds the task pane first, then writes:
    - <OutputDir>\DeepSeek-Excell-by-dezuhan-v<version>.zip
    - <OutputDir>\DeepSeek-Excell-by-dezuhan-v<version>.zip.sha256

  The archive contains a single top-level folder so extracting it stays tidy.
  node_modules is NOT included: the recipient runs install.ps1 (or "npm install") once.
  .env is NOT included on purpose - it holds the private DeepSeek API key.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts/package.ps1

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts/package.ps1 -SkipBuild -OutputDir C:\temp
#>
[CmdletBinding()]
param(
  [string]$OutputDir,
  [switch]$SkipBuild,
  [switch]$KeepStaging
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$version = (Get-Content (Join-Path $root 'package.json') -Raw | ConvertFrom-Json).version
$packageName = 'DeepSeek-Excell-by-dezuhan'
$archiveName = "$packageName-v$version"
if (-not $OutputDir) { $OutputDir = Join-Path $root 'release' }

function Write-Head($text) { Write-Host "`n==> $text" -ForegroundColor Cyan }
function Write-Ok($text) { Write-Host "    $text" -ForegroundColor Green }
function Write-Warn2($text) { Write-Host "    $text" -ForegroundColor Yellow }

# Directory names skipped anywhere in the tree.
# `store` holds runtime documents (chat sessions, personalization, prompts) - never shipped.
$excludedDirs = @('node_modules', '.git', '.vite', '.cache', 'logs', 'release', 'store', 'coverage', '.idea', '.vs')
# File names skipped (glob patterns).
$excludedFiles = @('.env', '.env.local', '.env.*.local', '*.log', 'npm-debug.log*', 'Thumbs.db', '.DS_Store', '*.zip', '*.sha256')

function Test-Excluded([System.IO.FileSystemInfo]$item) {
  if ($item.PSIsContainer) { return ($excludedDirs -contains $item.Name) }
  foreach ($pattern in $excludedFiles) {
    if ($item.Name -like $pattern -and $item.Name -ne '.env.example') { return $true }
  }
  return $false
}

function Copy-Tree([string]$source, [string]$destination) {
  $copied = 0
  foreach ($item in Get-ChildItem -LiteralPath $source -Force) {
    if (Test-Excluded $item) { continue }
    $target = Join-Path $destination $item.Name
    if ($item.PSIsContainer) {
      New-Item -ItemType Directory -Force -Path $target | Out-Null
      $copied += Copy-Tree $item.FullName $target
    } else {
      Copy-Item -LiteralPath $item.FullName -Destination $target -Force
      $copied += 1
    }
  }
  return $copied
}

function New-ZipArchive([string]$sourceRoot, [string]$zipPath, [string]$entryRoot) {
  # Entries are written one by one so the separator is always "/" as the ZIP spec requires.
  # (Compress-Archive on Windows PowerShell 5.1 writes "\" which some extractors mishandle.)
  if (Test-Path -LiteralPath $zipPath) { Remove-Item -LiteralPath $zipPath -Force }
  Add-Type -AssemblyName System.IO.Compression | Out-Null
  Add-Type -AssemblyName System.IO.Compression.FileSystem | Out-Null
  $stream = [System.IO.File]::Open($zipPath, [System.IO.FileMode]::CreateNew)
  try {
    $archive = [System.IO.Compression.ZipArchive]::new($stream, [System.IO.Compression.ZipArchiveMode]::Create)
    try {
      foreach ($file in (Get-ChildItem -LiteralPath $sourceRoot -Recurse -File -Force)) {
        $relative = $file.FullName.Substring($sourceRoot.Length).TrimStart('\', '/') -replace '\\', '/'
        $entry = $archive.CreateEntry("$entryRoot/$relative", [System.IO.Compression.CompressionLevel]::Optimal)
        $entryStream = $entry.Open()
        try {
          $fileStream = [System.IO.File]::OpenRead($file.FullName)
          try { $fileStream.CopyTo($entryStream) } finally { $fileStream.Dispose() }
        } finally { $entryStream.Dispose() }
      }
    } finally { $archive.Dispose() }
  } finally { $stream.Dispose() }
}

Write-Host "`nDeepSeek Excell by dezuhan - packaging v$version" -ForegroundColor White
Write-Host 'https://github.com/dezuhan' -ForegroundColor DarkGray

if (-not $SkipBuild) {
  Write-Head 'Building the task pane so dist/ is up to date'
  $node = Get-Command node -ErrorAction SilentlyContinue
  $npm = if ($node) { Join-Path (Split-Path -Parent $node.Source) 'npm.cmd' } else { 'npm.cmd' }
  if (Test-Path (Join-Path $root 'node_modules')) {
    Push-Location $root
    try {
      & $npm run build:ui
      if ($LASTEXITCODE -ne 0) { throw "vite build failed (exit $LASTEXITCODE)." }
    } finally {
      Pop-Location
    }
    Write-Ok 'dist/ rebuilt.'
  } else {
    Write-Warn2 'node_modules not found - skipping UI build. Run "npm install" first for a complete archive.'
  }
}

Write-Head 'Staging files (node_modules and .env excluded)'
$staging = Join-Path ([System.IO.Path]::GetTempPath()) ("$packageName-stage-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
$stagedRoot = Join-Path $staging $packageName
New-Item -ItemType Directory -Force -Path $stagedRoot | Out-Null
$fileCount = Copy-Tree $root $stagedRoot
Write-Ok "$fileCount files staged in $stagedRoot"

Write-Head 'Creating the ZIP archive'
New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null
$zipPath = Join-Path $OutputDir "$archiveName.zip"
New-ZipArchive -sourceRoot $stagedRoot -zipPath $zipPath -entryRoot $packageName
$zipSize = [math]::Round((Get-Item $zipPath).Length / 1KB, 1)
$hash = (Get-FileHash -LiteralPath $zipPath -Algorithm SHA256).Hash
Set-Content -LiteralPath "$zipPath.sha256" -Value "$hash  $archiveName.zip" -Encoding ASCII
Write-Ok "Archive: $zipPath ($zipSize KB)"

if (-not $KeepStaging) { Remove-Item -LiteralPath $staging -Recurse -Force }
else { Write-Warn2 "Staging folder kept: $stagedRoot" }

Write-Head 'Verifying the archive contents'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive = [System.IO.Compression.ZipFile]::OpenRead($zipPath)
try {
  $entries = $archive.Entries | ForEach-Object { $_.FullName -replace '\\', '/' }
  $badEntries = $entries | Where-Object { $_ -match 'node_modules/|(^|/)\.env$|/logs/|\.zip$' }
  if ($badEntries) {
    Write-Warn2 'Unexpected entries found:'
    $badEntries | Select-Object -First 10 | ForEach-Object { Write-Warn2 "  $_" }
    throw 'Archive contains excluded content.'
  }
  $mustHave = @(
    "$packageName/install.ps1",
    "$packageName/install.cmd",
    "$packageName/package.json",
    "$packageName/manifest.xml",
    "$packageName/README.md",
    "$packageName/shared/tools.json",
    "$packageName/ui/index.html",
    "$packageName/.env.example"
  )
  foreach ($expected in $mustHave) {
    if ($entries -notcontains $expected) { throw "Archive is missing $expected" }
  }
  Write-Ok "$($entries.Count) entries, no node_modules/.env/logs inside."
  Write-Ok 'install.ps1, install.cmd, manifest.xml, README.md, ui/, shared/, .env.example are present.'
} finally {
  $archive.Dispose()
}

Write-Host @"

--------------------------------------------------------------
Package ready
  ZIP      : $zipPath
  SHA256   : $hash
  Checksum : $zipPath.sha256

Recipient instructions:
  1. Extract the archive anywhere (for example C:\DeepSeek-Excell).
  2. Run:  powershell -ExecutionPolicy Bypass -File install.ps1
     (or double-click install.cmd)
  3. Close every Excel window, reopen Excel, then use
     Home -> "DeepSeek Excel" -> "DeepSeek Excel".

The installer runs npm install itself; node_modules is intentionally
not part of the archive. The private .env file is never packaged.
--------------------------------------------------------------
"@ -ForegroundColor Gray

# Explicit clean exit: otherwise a non-zero $LASTEXITCODE from an earlier native
# command (npm/node) can leak out as this script's process exit code.
exit 0
