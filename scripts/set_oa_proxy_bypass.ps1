[CmdletBinding()]
param()

$regPath = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings"
$current = Get-ItemProperty $regPath
$existingItems = @()

if ($current.ProxyOverride) {
  $existingItems = $current.ProxyOverride -split ";" | ForEach-Object { $_.Trim() } | Where-Object { $_ }
}

$requiredItems = @(
  "oa.cyou-inc.com",
  "www.cyou-inc.com",
  "*.cyou-inc.com",
  "ai.cy.com",
  "10.1.10.30",
  "10.1.10.30:8080",
  "10.*",
  "localhost",
  "127.0.0.1",
  "<local>"
)

$requiredDirectRules = @(
  ".cyou-inc.com direct",
  "ai.cy.com direct",
  "10.1.10.30 direct"
)

$merged = [System.Collections.Generic.List[string]]::new()
foreach ($item in @($existingItems + $requiredItems)) {
  if (-not $item) {
    continue
  }
  if (-not $merged.Contains($item)) {
    $merged.Add($item)
  }
}

$proxyOverride = $merged -join ";"
Set-ItemProperty -Path $regPath -Name ProxyOverride -Value $proxyOverride

function Get-SsrRuleFiles {
  $ruleFiles = [System.Collections.Generic.List[string]]::new()
  $candidateDirs = [System.Collections.Generic.List[string]]::new()

  Get-Process | Where-Object { $_.ProcessName -like 'ShadowsocksR-dotnet*' -and $_.Path } | ForEach-Object {
    $dir = Split-Path -Parent $_.Path
    foreach ($candidateDir in @($dir, (Split-Path -Parent $dir))) {
      if (-not $candidateDir) {
        continue
      }
      if (-not (Test-Path $candidateDir)) {
        continue
      }
      if (-not $candidateDirs.Contains($candidateDir)) {
        $candidateDirs.Add($candidateDir)
      }
    }
  }

  foreach ($dir in $candidateDirs) {
    $rulePath = Join-Path $dir "user.rule"
    if ((Test-Path $rulePath) -and (-not $ruleFiles.Contains($rulePath))) {
      $ruleFiles.Add($rulePath)
    }
  }

  return $ruleFiles
}

function Update-SsrUserRule {
  param(
    [string]$RulePath
  )

  $existingLines = @()
  if (Test-Path $RulePath) {
    $existingLines = Get-Content $RulePath
  }

  $missingRules = @()
  foreach ($rule in $requiredDirectRules) {
    if (-not ($existingLines | Where-Object { $_.Trim() -eq $rule })) {
      $missingRules += $rule
    }
  }

  if (-not $missingRules) {
    Write-Host "SSR rule file already contains OA direct rules: $RulePath"
    return
  }

  if (-not ($existingLines | Where-Object { $_.Trim() -eq "# OA internal direct rules" })) {
    Add-Content -Path $RulePath -Value ""
    Add-Content -Path $RulePath -Value "# OA internal direct rules"
  }
  foreach ($rule in $missingRules) {
    Add-Content -Path $RulePath -Value $rule
  }

  Write-Host "Updated SSR user.rule: $RulePath"
}

foreach ($rulePath in Get-SsrRuleFiles) {
  Update-SsrUserRule -RulePath $rulePath
}

Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class WinInetNative {
  [DllImport("wininet.dll", SetLastError = true)]
  public static extern bool InternetSetOption(IntPtr hInternet, int dwOption, IntPtr lpBuffer, int dwBufferLength);
}
"@

[void][WinInetNative]::InternetSetOption([IntPtr]::Zero, 39, [IntPtr]::Zero, 0)
[void][WinInetNative]::InternetSetOption([IntPtr]::Zero, 37, [IntPtr]::Zero, 0)

Write-Host "已更新系统代理例外名单："
Write-Host $proxyOverride
