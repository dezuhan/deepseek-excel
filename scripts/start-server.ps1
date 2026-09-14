<#
.SYNOPSIS
  Starts the DeepSeek Excel local server in the background, with no console window.

.DESCRIPTION
  Used by the logon autostart (scripts\run-server.cmd -> this script). The caller
  normally launches it with a hidden window (Startup .vbs, window style 0), so no
  CMD/Node window ever pops up at boot.

  The script is idempotent: when something already listens on the port, it exits
  immediately instead of starting a second copy of the server. Server output goes
  to logs\server.out.log and logs\server.err.log (never to a console).

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts/start-server.ps1
#>
[CmdletBinding()]
param(
  [int]$Port = 3000
)

$ErrorActionPreference = 'SilentlyContinue'
$projectRoot = Split-Path -Parent $PSScriptRoot

# Already running? Do nothing (keeps repeated logons / double-clicks harmless).
if (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue) { exit 0 }

$nodeExe = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $nodeExe) {
  foreach ($candidate in @(
      (Join-Path $env:ProgramFiles 'nodejs\node.exe'),
      (Join-Path ${env:ProgramFiles(x86)} 'nodejs\node.exe'),
      (Join-Path $env:LOCALAPPDATA 'Programs\nodejs\node.exe')
    )) {
    if ($candidate -and (Test-Path -LiteralPath $candidate)) { $nodeExe = $candidate; break }
  }
}
if (-not $nodeExe) { exit 1 }

$logs = Join-Path $projectRoot 'logs'
if (-not (Test-Path -LiteralPath $logs)) { New-Item -ItemType Directory -Force -Path $logs | Out-Null }

Start-Process -FilePath $nodeExe -ArgumentList 'server.js' -WorkingDirectory $projectRoot -WindowStyle Hidden `
  -RedirectStandardOutput (Join-Path $logs 'server.out.log') `
  -RedirectStandardError (Join-Path $logs 'server.err.log')
exit 0
