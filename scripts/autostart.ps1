<#
.SYNOPSIS
  Installs/removes the DeepSeek Excel local server autostart (no admin rights).

.DESCRIPTION
  Makes the local server start by itself when Windows boots/logs in, completely
  hidden: the logon entry is a .vbs launcher that runs the server with window
  style 0, so no CMD (or Node) window ever pops up.

  What it writes:
    scripts\run-server.cmd                      hidden runner -> scripts\start-server.ps1
    <Startup>\DeepSeek-Excel-Server.vbs          logon launcher, window style 0 (hidden)

  It also removes a legacy Startup shortcut that pointed at install.cmd: that one
  opened a visible CMD window and re-ran the whole installer on every logon.

  Running it again is always safe - scripts\start-server.ps1 checks the port first,
  so the server is never started twice.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts/autostart.ps1
  powershell -ExecutionPolicy Bypass -File scripts/autostart.ps1 -Status
  powershell -ExecutionPolicy Bypass -File scripts/autostart.ps1 -Remove
  powershell -ExecutionPolicy Bypass -File scripts/autostart.ps1 -NoStart
#>
[CmdletBinding()]
param(
  [switch]$Remove,
  [switch]$Status,
  [switch]$NoStart
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$port = 3000
$appName = 'DeepSeek Excel'
$runnerPath = Join-Path $PSScriptRoot 'run-server.cmd'
$starterPath = Join-Path $PSScriptRoot 'start-server.ps1'
$installers = @((Join-Path $projectRoot 'install.cmd'), (Join-Path $projectRoot 'install.ps1'))
$startup = [Environment]::GetFolderPath('Startup')
$shortcut = Join-Path $startup 'DeepSeek-Excel-Server.vbs'
$wscript = Join-Path $env:SystemRoot 'System32\wscript.exe'

function Write-Ok($text) { Write-Host "    $text" -ForegroundColor Green }
function Write-Warn2($text) { Write-Host "    $text" -ForegroundColor Yellow }

function Test-ServerPort([int]$p) {
  return [bool](Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue)
}

# Startup shortcuts that launch install.cmd / install.ps1: they pop a CMD window
# (and re-run the installer) at every logon, which the hidden .vbs replaces.
function Get-PopupShortcut {
  $links = @()
  if (-not (Test-Path -LiteralPath $startup)) { return $links }
  $shell = $null
  try { $shell = New-Object -ComObject WScript.Shell } catch { }
  foreach ($file in @(Get-ChildItem -LiteralPath $startup -Filter '*.lnk' -ErrorAction SilentlyContinue)) {
    $match = $false
    if ($shell) {
      try { $match = ($installers -contains $shell.CreateShortcut($file.FullName).TargetPath) } catch { }
    }
    if (-not $match) {
      try {
        $raw = [Text.Encoding]::Unicode.GetString([IO.File]::ReadAllBytes($file.FullName))
        $match = ($raw -like '*install.cmd*') -or ($raw -like '*install.ps1*')
      } catch { }
    }
    if ($match) { $links += $file }
  }
  return $links
}

$popupLinks = @(Get-PopupShortcut)

if ($Status) {
  Write-Host "==> $appName autostart status" -ForegroundColor Cyan
  Write-Ok "Hidden logon launcher : $(if (Test-Path $shortcut) { 'PRESENT' } else { 'missing' })"
  Write-Ok "Runner script         : $(if (Test-Path $runnerPath) { 'PRESENT' } else { 'missing' })"
  Write-Ok "Port $port            : $(if (Test-ServerPort $port) { 'listening (server running)' } else { 'nothing listening' })"
  if ($popupLinks.Count) {
    Write-Warn2 "Legacy popup shortcut : $($popupLinks.Name -join ', ') (opens a CMD window at logon)"
    Write-Warn2 'Run this script without -Status to replace it with the hidden launcher.'
  } else {
    Write-Ok 'Legacy popup shortcut : none - logon is silent.'
  }
  return
}

if ($Remove) {
  $removed = $false
  if (Test-Path -LiteralPath $shortcut) {
    Remove-Item -LiteralPath $shortcut -Force
    Write-Ok "Autostart removed: $shortcut"
    $removed = $true
  }
  foreach ($file in $popupLinks) {
    Remove-Item -LiteralPath $file.FullName -Force
    Write-Ok "Legacy popup shortcut removed: $($file.FullName)"
    $removed = $true
  }
  if (-not $removed) { Write-Warn2 'Autostart is not installed.' }
  return
}

Write-Host "==> Installing the hidden $appName server autostart" -ForegroundColor Cyan

$node = (Get-Command node -ErrorAction SilentlyContinue)
if (-not $node) { throw 'Node.js was not found in PATH. Run scripts/setup.ps1 first.' }
if (-not (Test-Path -LiteralPath $starterPath)) { throw "Missing $starterPath - re-extract the project." }

$runner = @"
@echo off
rem Created automatically by scripts/autostart.ps1
rem Starts the local server hidden (no CMD window) and never starts a second copy.
powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0start-server.ps1"
"@
Set-Content -LiteralPath $runnerPath -Value $runner -Encoding ASCII
Write-Ok "Runner created: $runnerPath"

foreach ($file in $popupLinks) {
  Remove-Item -LiteralPath $file.FullName -Force
  Write-Ok "Legacy popup shortcut removed (no more CMD window at logon): $($file.FullName)"
}

$vbs = @"
' $appName - starts the local server at logon with NO console window.
' Window style 0 = hidden, so no CMD/Node window ever pops up.
Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")
runner = "$runnerPath"
If Not fso.FileExists(runner) Then WScript.Quit 0
shell.Run """" & runner & """", 0, False
"@
Set-Content -LiteralPath $shortcut -Value $vbs -Encoding ASCII
Write-Ok "Hidden logon launcher created: $shortcut"

if ($NoStart) {
  Write-Ok 'Autostart registered (-NoStart: the server itself was left alone).'
} elseif (Test-ServerPort $port) {
  Write-Ok "A server is already listening on port $port - nothing to start."
} else {
  # Start through the exact same launcher Windows uses at logon, to prove it works.
  Start-Process -FilePath $wscript -ArgumentList "`"$shortcut`"" -WindowStyle Hidden
  Start-Sleep -Seconds 5
  if (Test-ServerPort $port) {
    Write-Ok "The hidden launcher started the server; port $port is active."
  } else {
    Write-Warn2 "The server was not detected on port $port. Check logs\server.out.log and logs\server.err.log."
  }
}

Write-Ok "Autostart ready: at every boot/logon the server starts by itself with no CMD popup."
Write-Ok "Server log: $(Join-Path $projectRoot 'logs\server.out.log')"
