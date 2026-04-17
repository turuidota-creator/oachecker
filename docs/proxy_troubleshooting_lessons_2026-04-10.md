# 2026-04-10 Proxy Troubleshooting Lessons

## Summary

- `http://oa.cyou-inc.com/...` and `http://www.cyou-inc.com/Portal/index.do` were failing in the browser while the local proxy on `127.0.0.1:1080` was enabled.
- Direct requests worked, but requests forced through `127.0.0.1:1080` timed out.

## Root Cause

- Both domains resolve to internal `10.x` addresses.
- The machine had system proxy enabled, but the browser bypass list was empty.
- As a result, the browser incorrectly sent internal OA traffic to the local proxy instead of connecting directly.

## Fix

- Reused the existing script: `scripts/set_oa_proxy_bypass.ps1`
- Expanded the required bypass entries to cover:
  - `oa.cyou-inc.com`
  - `www.cyou-inc.com`
  - `*.cyou-inc.com`
  - `ai.cy.com`
  - `10.*`
  - `localhost`
  - `127.0.0.1`
  - `<local>`

## Lessons

- A listening process on port `1080` only proves the proxy client is running; it does not mean OA traffic should use that proxy.
- When automation can open OA but the normal browser cannot, check Windows browser proxy exceptions before suspecting an OA outage.
- For this project, prefer reusing `scripts/set_oa_proxy_bypass.ps1` and `scripts/open_oa_direct.ps1` instead of reconfiguring proxies by hand each time.
- `ShadowsocksR` may re-apply Windows proxy settings in the background, so a bypass list that was correct a moment ago can be overwritten later in the same session.
- Even after adding `.cyou-inc.com direct` to `user.rule`, explicit proxy requests to OA still returned `502` on `2026-04-11`, so browser-side bypass remains the critical fix.
- The same failure pattern happened again on `2026-04-13`: `ProxyOverride` was empty, direct OA access returned `200`, and explicit proxy access through `127.0.0.1:1080` returned `502`.
- The same repair was re-applied again on `2026-04-15`, and the effective fix remained restoring `ProxyOverride` to include the OA / intranet bypass list.
- On `2026-04-16`, `http://10.1.10.30:8080/` was added explicitly to the bypass list, even though `10.*` should already cover it. The explicit entry makes future diagnostics clearer.
- A double-click repair wrapper was added at `scripts/fix_oa_proxy_bypass.cmd` so the Windows proxy bypass list can be restored without opening PowerShell manually.
