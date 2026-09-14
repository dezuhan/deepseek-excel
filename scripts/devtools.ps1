<#
.SYNOPSIS
  Enables/disables WebView2 DevTools for the DeepSeek add-in (helps with debugging).

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts/devtools.ps1
  powershell -ExecutionPolicy Bypass -File scripts/devtools.ps1 -Disable
#>
[CmdletBinding()]
param(
  [switch]$Disable,
  [switch]$RuntimeLogging
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$manifestPath = Join-Path $projectRoot 'manifest.xml'

function Write-Ok($text) { Write-Host "    $text" -ForegroundColor Green }

[xml]$manifest = Get-Content -LiteralPath $manifestPath -Raw
$addInId = $manifest.OfficeApp.Id
$addInKey = "HKCU:\SOFTWARE\Microsoft\Office\16.0\Wef\Developer\$addInId"
if (-not (Test-Path $addInKey)) { New-Item -Path $addInKey -Force | Out-Null }

Write-Host '==> DevTools add-in' -ForegroundColor Cyan
if ($Disable) {
  Remove-ItemProperty -Path $addInKey -Name 'OpenDevTools' -ErrorAction SilentlyContinue
  Remove-ItemProperty -Path $addInKey -Name 'UseDirectDebugger' -ErrorAction SilentlyContinue
  Remove-ItemProperty -Path $addInKey -Name 'UseWebDebugger' -ErrorAction SilentlyContinue
  Write-Ok 'DevTools disabled.'
} else {
  New-ItemProperty -Path $addInKey -Name 'OpenDevTools' -Value 1 -PropertyType DWord -Force | Out-Null
  New-ItemProperty -Path $addInKey -Name 'UseDirectDebugger' -Value 1 -PropertyType DWord -Force | Out-Null
  Write-Ok 'DevTools enabled (OpenDevTools + UseDirectDebugger).'
}

if ($RuntimeLogging) {
  $logDir = Join-Path $projectRoot 'logs'
  if (-not (Test-Path $logDir)) { New-Item -Path $logDir -Force | Out-Null }
  $logPath = Join-Path $logDir 'OfficeAddins.log.txt'
  $runtimeKey = 'HKCU:\SOFTWARE\Microsoft\Office\16.0\Wef\Developer\RuntimeLogging'
  if (-not (Test-Path $runtimeKey)) { New-Item -Path $runtimeKey -Force | Out-Null }
  Set-ItemProperty -Path $runtimeKey -Name '(default)' -Value $logPath
  Write-Ok "Runtime logging enabled → $logPath"
}

Write-Host '    Close and reopen Excel, then open the DeepSeek sidebar.' -ForegroundColor Gray
