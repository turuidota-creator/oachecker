from __future__ import annotations

import json
import shutil
import sys
import time
from pathlib import Path
from typing import Any, Dict, List

from playwright.sync_api import TimeoutError as PlaywrightTimeoutError
from playwright.sync_api import sync_playwright


BASE_URL = "http://oa.cyou-inc.com"
DEFAULT_TARGET_URL = (
    "http://oa.cyou-inc.com/workflow/process/detail/641462669215404032"
    "?processed=false&procDefId=Process_1724209095845&processCode=DDFK-202602040001"
)
EDGE_PATH = Path(r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe")
REPO_ROOT = Path(__file__).resolve().parents[1]
EXTENSION_DIR = REPO_ROOT / "oa_finance_audit_rebuild_extension"
WORKDIR = REPO_ROOT
OUTPUT_ROOT = WORKDIR / "single_case_test_output"
PROFILE_DIR = WORKDIR / "tmp_single_case_ext_profile"
USERNAME = "turui"
PASSWORD = "1qaz@WSX#EDC"


def login_page(page: Any, username: str, password: str) -> None:
    page.goto(f"{BASE_URL}/index", wait_until="domcontentloaded", timeout=60000)
    page.wait_for_timeout(2000)
    if "oauth" in page.url or "/sso" in page.url:
        page.wait_for_selector("#username", timeout=20000)
        page.fill("#username", username)
        page.fill("#password", password)
        page.click("#loginId")

    deadline = time.time() + 90
    while time.time() < deadline:
        page.wait_for_timeout(1500)
        if page.url.startswith(f"{BASE_URL}/index"):
            return
        if "oauth" in page.url and page.locator("#username").count():
            page.fill("#username", username)
            page.fill("#password", password)
            page.click("#loginId")

    raise RuntimeError(f"Login did not reach OA index, current url: {page.url}")


def collect_panel_state(page: Any) -> Dict[str, Any]:
    return page.evaluate(
        """
        () => {
          const root = document.querySelector('#oa-finance-rebuild-root');
          const badge = root?.querySelector('.oa-finance-rebuild-badge');
          const body = root?.querySelector('.oa-finance-rebuild-body');
          const diagnostics = Array.from(root?.querySelectorAll('.oa-finance-rebuild-section') || [])
            .filter((el) => /诊断|璇婃柇/.test(el.textContent || ''))
            .map((el) => el.innerText || '');
          return {
            rootExists: !!root,
            badgeText: badge?.textContent?.trim() || '',
            bodyText: body?.innerText || '',
            diagnostics,
            analysisJson: root?.dataset?.analysisJson || '',
          };
        }
        """
    )


def wait_for_analysis(page: Any) -> Dict[str, Any]:
    page.wait_for_selector("#oa-finance-rebuild-root", timeout=60000)
    page.locator("#oa-finance-rebuild-root .oa-finance-rebuild-run").click()

    try:
        page.wait_for_function(
            """
            () => {
              const root = document.querySelector('#oa-finance-rebuild-root');
              return !!root && !!root.dataset && !!root.dataset.analysisJson;
            }
            """,
            timeout=240000,
        )
    except PlaywrightTimeoutError:
        pass

    page.wait_for_timeout(3000)
    return collect_panel_state(page)


def main() -> int:
    target_url = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_TARGET_URL
    timestamp = time.strftime("%Y%m%d_%H%M%S")
    output_dir = OUTPUT_ROOT / f"run_{timestamp}"
    output_dir.mkdir(parents=True, exist_ok=True)
    if PROFILE_DIR.exists():
        shutil.rmtree(PROFILE_DIR)

    console_logs: List[Dict[str, str]] = []
    page_errors: List[str] = []

    with sync_playwright() as playwright:
        context = playwright.chromium.launch_persistent_context(
            str(PROFILE_DIR),
            headless=False,
            executable_path=str(EDGE_PATH),
            args=[
                "--no-proxy-server",
                "--proxy-server=direct://",
                "--proxy-bypass-list=*",
                f"--disable-extensions-except={EXTENSION_DIR}",
                f"--load-extension={EXTENSION_DIR}",
            ],
            viewport={"width": 1600, "height": 1200},
        )
        page = context.pages[0] if context.pages else context.new_page()

        page.on("console", lambda msg: console_logs.append({"type": msg.type, "text": msg.text}))
        page.on("pageerror", lambda exc: page_errors.append(str(exc)))

        login_page(page, USERNAME, PASSWORD)
        page.goto(target_url, wait_until="domcontentloaded", timeout=120000)
        page.wait_for_timeout(5000)

        panel_state = wait_for_analysis(page)
        screenshot_path = output_dir / "panel.png"
        page.screenshot(path=str(screenshot_path), full_page=True)
        context.close()

    analysis = None
    if panel_state.get("analysisJson"):
      try:
        analysis = json.loads(panel_state["analysisJson"])
      except json.JSONDecodeError:
        analysis = None

    result = {
        "url": target_url,
        "panel_state": panel_state,
        "analysis": analysis,
        "console_logs": console_logs,
        "page_errors": page_errors,
        "screenshot": str(screenshot_path),
    }

    (output_dir / "result.json").write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
