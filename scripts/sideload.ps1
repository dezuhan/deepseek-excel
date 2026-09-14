<#
.SYNOPSIS
  Registers the add-in with desktop Excel through the HKCU registry (no admin rights needed).

.DESCRIPTION
  Writes HKCU\SOFTWARE\Microsoft\Office\16.0\Wef\Developer with the value name = the add-in
  Id from the manifest and the data = the full manifest path. This is the official route used
  by the office-addin-dev-settings tool, so Excel loads the add-in as a developer add-in.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts/sideload.ps1
  powershell -ExecutionPolicy Bypass -File scripts/sideload.ps1 -Minimal -ForceWebView2
#>
[CmdletBinding()]
param(
  [switch]$Minimal,
  [switch]$ForceWebView2,
  [switch]$SkipWebView2Check
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$manifestName = if ($Minimal) { 'manifest-minimal.xml' } else { 'manifest.xml' }
$manifestPath = Join-Path $projectRoot $manifestName

function Write-Step($text) { Write-Host "==> $text" -ForegroundColor Cyan }
function Write-Ok($text) { Write-Host "    $text" -ForegroundColor Green }
function Write-Warn2($text) { Write-Host "    $text" -ForegroundColor Yellow }

if (-not (Test-Path $manifestPath)) { throw "Manifest not found: $manifestPath" }

Write-Step "Reading manifest $manifestName"
[xml]$manifest = Get-Content -LiteralPath $manifestPath -Raw
$addInId = $manifest.OfficeApp.Id
if (-not $addInId) { throw 'The <Id> element was not found in the manifest.' }
Write-Ok "Add-in Id : $addInId"
Write-Ok "Source    : $($manifest.OfficeApp.DefaultSettings.SourceLocation.DefaultValue)"

Write-Step 'Registering the developer add-in in HKCU'
$developerKey = 'HKCU:\SOFTWARE\Microsoft\Office\16.0\Wef\Developer'
if (-not (Test-Path $developerKey)) { New-Item -Path $developerKey -Force | Out-Null }
New-ItemProperty -Path $developerKey -Name $addInId -Value $manifestPath -PropertyType String -Force | Out-Null
# Clean up old entries that may use the manifest path as the value name.
Remove-ItemProperty -Path $developerKey -Name $manifestPath -ErrorAction SilentlyContinue
Write-Ok "Registry value created: $developerKey → $addInId"

if ($ForceWebView2 -or -not $SkipWebView2Check) {
  $webViewKey = Join-Path $developerKey $addInId
  if (-not (Test-Path $webViewKey)) { New-Item -Path $webViewKey -Force | Out-Null }
  $installed = @()
  foreach ($edgeKey in @(
      'HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}',
      'HKLM:\SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}',
      'HKCU:\SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}')) {
    if (Test-Path $edgeKey) { $installed += (Get-ItemProperty $edgeKey).pv }
  }
  if ($installed.Count -gt 0) {
    New-ItemProperty -Path $webViewKey -Name 'WebViewSelection' -Value 'Edge Chromium' -PropertyType String -Force | Out-Null
    Write-Ok "WebView2 detected (version $($installed -join ', ')); WebViewSelection forced to 'Edge Chromium'."
  } else {
    Write-Warn2 'Microsoft Edge WebView2 Runtime not detected. The sidebar may fail to appear or run.'
    Write-Warn2 'Install it from https://developer.microsoft.com/microsoft-edge/webview2/ (Evergreen Standalone Installer), then run this script again.'
  }
}

$excel = Get-Process EXCEL -ErrorAction SilentlyContinue
Write-Step 'Important note'
if ($excel) {
  Write-Warn2 'Excel is running. Close ALL Excel windows and open it again so the add-in is registered.'
} else {
  Write-Ok 'Excel is not running - ready to use right away.'
}
Write-Host @'
    After Excel opens:
      - Manifest with ribbon   : Home tab → "DeepSeek Excel" group → "DeepSeek Excel" button.
      - Minimal manifest       : the task pane opens automatically.
    If the add-in does not appear:
      - make sure the server is running (npm start),
      - run scripts/devtools.ps1 to open DevTools,
      - clear the cache: delete the contents of %LOCALAPPDATA%\Microsoft\Office\16.0\Wef\ then open Excel again.
'@ -ForegroundColor Gray
