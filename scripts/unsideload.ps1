<#
.SYNOPSIS
  Unregisters the DeepSeek Excel add-in from Excel and (optionally) clears the Office cache.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts/unsideload.ps1
  powershell -ExecutionPolicy Bypass -File scripts/unsideload.ps1 -ClearCache
#>
[CmdletBinding()]
param(
  [switch]$ClearCache
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$manifestPath = Join-Path $projectRoot 'manifest.xml'

function Write-Step($text) { Write-Host "==> $text" -ForegroundColor Cyan }
function Write-Ok($text) { Write-Host "    $text" -ForegroundColor Green }
function Write-Warn2($text) { Write-Host "    $text" -ForegroundColor Yellow }

$addInId = $null
if (Test-Path $manifestPath) {
  [xml]$manifest = Get-Content -LiteralPath $manifestPath -Raw
  $addInId = $manifest.OfficeApp.Id
}

$developerKey = 'HKCU:\SOFTWARE\Microsoft\Office\16.0\Wef\Developer'
Write-Step 'Removing the add-in registration'
if (Test-Path $developerKey) {
  if ($addInId) {
    Remove-ItemProperty -Path $developerKey -Name $addInId -ErrorAction SilentlyContinue
    Remove-Item -Path (Join-Path $developerKey $addInId) -Recurse -Force -ErrorAction SilentlyContinue
  }
  Remove-ItemProperty -Path $developerKey -Name $manifestPath -ErrorAction SilentlyContinue
  Write-Ok "Registry entry for $addInId removed."
} else {
  Write-Warn2 'The Developer key does not exist - nothing to remove.'
}

Write-Step 'Removing the server autostart (if any)'
$startup = [Environment]::GetFolderPath('Startup')
$shortcut = Join-Path $startup 'DeepSeek-Excel-Server.vbs'
if (Test-Path -LiteralPath $shortcut) {
  Remove-Item -LiteralPath $shortcut -Force
  Write-Ok "Removed: $shortcut"
} else {
  Write-Warn2 'No autostart launcher.'
}

# Legacy Startup shortcuts that launched install.cmd (visible CMD window at logon).
$installers = @((Join-Path $projectRoot 'install.cmd'), (Join-Path $projectRoot 'install.ps1'))
$shell = $null
try { $shell = New-Object -ComObject WScript.Shell } catch { }
foreach ($file in @(Get-ChildItem -LiteralPath $startup -Filter '*.lnk' -ErrorAction SilentlyContinue)) {
  $match = $false
  if ($shell) { try { $match = ($installers -contains $shell.CreateShortcut($file.FullName).TargetPath) } catch { } }
  if (-not $match) {
    try {
      $raw = [Text.Encoding]::Unicode.GetString([IO.File]::ReadAllBytes($file.FullName))
      $match = ($raw -like '*install.cmd*') -or ($raw -like '*install.ps1*')
    } catch { }
  }
  if ($match) {
    Remove-Item -LiteralPath $file.FullName -Force
    Write-Ok "Legacy popup shortcut removed: $($file.FullName)"
  }
}

if ($ClearCache) {
  Write-Step 'Clearing the Office add-in cache'
  $cache = Join-Path $env:LOCALAPPDATA 'Microsoft\Office\16.0\Wef'
  if (Test-Path $cache) {
    Get-ChildItem -LiteralPath $cache -Force | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
    Write-Ok "Cache contents cleared: $cache"
  } else {
    Write-Warn2 'Cache folder not found.'
  }
}

Write-Host '    Close and reopen Excel for the changes to take effect.' -ForegroundColor Gray
