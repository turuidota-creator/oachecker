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
  "*.cyou-inc.com",
  "10.*",
  "localhost",
  "127.0.0.1",
  "<local>"
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
