@echo off
setlocal

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0set_oa_proxy_bypass.ps1"

echo.
echo Current Windows proxy settings:
powershell -NoProfile -Command "Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings' | Select-Object ProxyEnable,ProxyServer,ProxyOverride | Format-List"

echo.
echo Done. If the browser still cannot open OA, close and reopen Edge.
pause
