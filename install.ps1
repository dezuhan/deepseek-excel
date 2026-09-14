<#
.SYNOPSIS
  One-shot installer for DeepSeek Excell by dezuhan.

.DESCRIPTION
  Runs the whole setup in order:
    1. checks Node.js (>= 20)
    2. installs npm dependencies (via npm.cmd, because npm.ps1 is blocked by AllSigned policy)
    3. creates .env with the DeepSeek API key (DSH credentials, -ApiKey, or hidden prompt)
    4. generates Heroicons assets (icon registry + ribbon PNGs)
    5. builds the React/shadcn task pane into dist/
    6. registers the add-in in Excel (HKCU registry, no admin rights needed)
    7. registers the hidden autostart (server starts at every boot/logon, no CMD popup)

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File install.ps1

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File install.ps1 -ApiKey sk-xxxx -AutoStart -StartServer

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File install.ps1 -SkipSideload -NonInteractive

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File install.ps1 -NoAutoStart
#>
[CmdletBinding()]
param(
  [string]$ApiKey,
  [switch]$AutoStart,
  [switch]$NoAutoStart,
  [switch]$StartServer,
  [switch]$SkipSideload,
  [switch]$SkipBuild,
  [switch]$NonInteractive,
  [switch]$Force
)

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$scripts = Join-Path $root 'scripts'
$version = '1.0.0'

function Write-Head($text) { Write-Host "`n==> $text" -ForegroundColor Cyan }
function Write-Ok($text) { Write-Host "    $text" -ForegroundColor Green }
function Write-Warn2($text) { Write-Host "    $text" -ForegroundColor Yellow }
function Write-Fail($text) { Write-Host "    $text" -ForegroundColor Red }

function Resolve-Npm {
  $node = Get-Command node -ErrorAction SilentlyContinue
  if (-not $node) { return $null }
  $candidate = Join-Path (Split-Path -Parent $node.Source) 'npm.cmd'
  if (Test-Path $candidate) { return $candidate }
  return 'npm.cmd'
}

function Test-ServerPort([int]$port) {
  return [bool](Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)
}

Write-Host @"
==============================================================
  DeepSeek Excell by dezuhan  v$version
  DeepSeek sidebar inside Excel 2021 (Office Add-in + local proxy)
  https://github.com/dezuhan
==============================================================
"@ -ForegroundColor White

Write-Head 'Step 1/7 - Checking Node.js'
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  Write-Fail 'Node.js was not found. Install Node.js 20 or newer from https://nodejs.org and run this installer again.'
  exit 1
}
$nodeVersion = (& node -v).TrimStart('v')
if ([int]($nodeVersion.Split('.')[0]) -lt 20) {
  Write-Fail "Node.js $nodeVersion is too old; version 20 or newer is required."
  exit 1
}
Write-Ok "Node.js v$nodeVersion detected."

$npm = Resolve-Npm
if (-not $npm) {
  Write-Fail 'npm.cmd could not be located next to node.exe.'
  exit 1
}

Write-Head 'Step 2/7 - Installing dependencies'
Write-Warn2 "Using $npm (npm.ps1 is blocked by the machine AllSigned execution policy)."
Push-Location $root
try {
  & $npm install --no-audit --no-fund
  if ($LASTEXITCODE -ne 0) { throw "npm install failed (exit $LASTEXITCODE)." }
} finally {
  Pop-Location
}
Write-Ok 'Dependencies are ready.'

Write-Head 'Step 3/7 - Preparing .env (API key)'
# Hashtable splat: elements of an ARRAY splat are passed positionally, which would
# bind "-NonInteractive"/"-Force" to setup.ps1's [string]$ApiKey and silently write
# that literal string into .env as the API key.
$setupArgs = @{}
if ($ApiKey) { $setupArgs['ApiKey'] = $ApiKey }
if ($NonInteractive) { $setupArgs['NonInteractive'] = $true }
if ($Force) { $setupArgs['Force'] = $true }
& (Join-Path $scripts 'setup.ps1') @setupArgs
if ($LASTEXITCODE -ne 0 -and $LASTEXITCODE -ne $null) { throw "scripts/setup.ps1 failed (exit $LASTEXITCODE)." }

Write-Head 'Step 4/7 - Generating Heroicons assets'
node (Join-Path $scripts 'build-assets.js')
if ($LASTEXITCODE -ne 0) { throw 'Asset generation failed.' }
Write-Ok 'Icon registry and ribbon icons are up to date.'

if (-not $SkipBuild) {
  Write-Head 'Step 5/7 - Building the task pane (React + shadcn/ui)'
  Push-Location $root
  try {
    & $npm run build:ui
    if ($LASTEXITCODE -ne 0) { throw "vite build failed (exit $LASTEXITCODE)." }
  } finally {
    Pop-Location
  }
  Write-Ok 'Task pane built into dist/.'
} else {
  Write-Head 'Step 5/7 - Build skipped (-SkipBuild)'
  Write-Warn2 'Run "npm run build:ui" before using the sidebar if ui/src changed.'
}

if (-not $SkipSideload) {
  Write-Head 'Step 6/7 - Registering the add-in in Excel'
  & (Join-Path $scripts 'sideload.ps1')
  if ($LASTEXITCODE -ne 0 -and $LASTEXITCODE -ne $null) { throw "scripts/sideload.ps1 failed (exit $LASTEXITCODE)." }
} else {
  Write-Head 'Step 6/7 - Add-in registration skipped (-SkipSideload)'
}

Write-Head 'Step 7/7 - Server autostart / startup'
if ($AutoStart -and -not $NoAutoStart) {
  & (Join-Path $scripts 'autostart.ps1')
  Write-Ok 'The local server will start by itself at every boot/logon - hidden, with no CMD popup.'
} elseif ($NoAutoStart) {
  Write-Warn2 'Autostart skipped (-NoAutoStart). Run scripts\autostart.ps1 when you want it.'
} elseif ($StartServer -or -not (Test-ServerPort 3000)) {
  $runner = Join-Path $scripts 'run-server.cmd'
  if (-not (Test-Path $runner)) {
    $runner = $null
  }
  New-Item -ItemType Directory -Force -Path (Join-Path $root 'logs') | Out-Null
  if ($runner) {
    Start-Process -FilePath $runner -WindowStyle Hidden
  } else {
    Start-Process -FilePath 'node' -ArgumentList 'server.js' -WorkingDirectory $root -WindowStyle Hidden `
      -RedirectStandardOutput (Join-Path $root 'logs\server.out.log') -RedirectStandardError (Join-Path $root 'logs\server.err.log')
  }
  Start-Sleep -Seconds 6
  if (Test-ServerPort 3000) {
    Write-Ok 'Local server is running on https://localhost:3000.'
  } else {
    Write-Warn2 'The server did not answer on port 3000 yet; check logs\server*.log.'
  }
  Write-Warn2 'This process stops when you sign out. Use -AutoStart for a hidden start at every logon.'
} else {
  Write-Ok 'A server is already listening on port 3000.'
}

Write-Host @"

--------------------------------------------------------------
Installation finished.

Next steps:
  1. Close every Excel window, then open Excel again.
  2. Home tab -> group "DeepSeek Excel" -> button "DeepSeek Excel".
  3. Type a request, review the plan card, press Apply.

Handy commands:
  npm start                 run the local server in the foreground
  npm run build:ui          rebuild the task pane after changing ui/src
  scripts\autostart.ps1     start the server automatically at logon (hidden, no CMD popup)
  scripts\unsideload.ps1 -ClearCache   remove the add-in completely
  npm test                  run the automated test suite

Rollback pane (no build required): https://localhost:3000/taskpane-classic.html
Project: https://github.com/dezuhan
--------------------------------------------------------------
"@ -ForegroundColor Gray

# Explicit clean exit: otherwise a non-zero $LASTEXITCODE from an earlier native
# command (npm/node) can leak out as this installer's process exit code.
exit 0

