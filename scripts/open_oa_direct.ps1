[CmdletBinding()]
param(
  [string]$Url = "http://oa.cyou-inc.com/index",
  [switch]$WithoutExtension
)

$edgeCandidates = @(@(
  "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
  "C:\Program Files\Microsoft\Edge\Application\msedge.exe"
) | Where-Object { $_ -and (Test-Path $_) })

if (-not $edgeCandidates) {
  throw "Edge executable not found."
}

$edgePath = $edgeCandidates[0]
$repoRoot = Split-Path -Parent $PSScriptRoot
$extensionDir = Join-Path $repoRoot "oa_finance_audit_rebuild_extension"

$args = @(
  "--no-proxy-server",
  "--proxy-server=direct://",
  "--proxy-bypass-list=*"
)

if (-not $WithoutExtension -and (Test-Path $extensionDir)) {
  $args += "--disable-extensions-except=$extensionDir"
  $args += "--load-extension=$extensionDir"
}

$args += $Url

Write-Host "Opening OA with direct connection..."
Write-Host "Edge: $edgePath"
Write-Host "URL:  $Url"
Start-Process -FilePath $edgePath -ArgumentList $args | Out-Null
