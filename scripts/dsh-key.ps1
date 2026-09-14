<#
.SYNOPSIS
  Reads DEEPSEEK_API_KEY from the DSH credentials file (or a similar YAML file).

.DESCRIPTION
  A small side-effect-free script, used by setup.ps1 and by the automated tests
  with a fixture file. Without -Raw the output is already masked, so it is safe to print.

.OUTPUTS
  The raw key (with -Raw) or the masked version. Exit code: 0 found, 3 not found.
#>
[CmdletBinding()]
param(
  [string]$Path = (Join-Path $HOME '.dsh\.credentials.yaml'),
  [switch]$Raw
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path -LiteralPath $Path)) { exit 3 }

$found = $null
foreach ($line in (Get-Content -LiteralPath $Path)) {
  $match = [regex]::Match($line, '^\s*DEEPSEEK_API_KEY\s*:\s*(?<v>.+?)\s*$')
  if (-not $match.Success) { continue }
  $value = $match.Groups['v'].Value.Trim().Trim('"').Trim("'")
  # A value that is a reference (not a raw key) is not accepted.
  if (-not $value) { continue }
  if ($value -match '^(keyring|vault|env|crypt|ref|secret-ref):') { continue }
  if ($value.Length -lt 10) { continue }
  $found = $value
  break
}

if (-not $found) { exit 3 }

if ($Raw) { Write-Output $found }
elseif ($found.Length -le 8) { Write-Output '****' }
else { Write-Output ($found.Substring(0, 3) + '…' + $found.Substring($found.Length - 4)) }
exit 0
