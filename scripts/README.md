# 脚本说明

- `test_rebuild_single_case.py`
  使用解压后的扩展启动 Edge，登录 OA，打开一个付款案例，执行侧边栏分析，并保存截图与 JSON 结果。

- `open_oa_direct.ps1`
  用禁用代理的方式启动 Edge 并打开 OA，默认同时加载当前仓库里的重构版扩展。

- `open_oa_direct.cmd`
  `open_oa_direct.ps1` 的双击入口。

- `set_oa_proxy_bypass.ps1`
  给系统浏览器代理增加 OA 直连例外名单，保留现有代理，但让 `oa.cyou-inc.com` 和常见内网地址不走代理。
