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


def record_timing(timings: List[Dict[str, Any]], label: str, started_at: float, **extra: Any) -> None:
    timings.append(
        {
            "label": label,
            "durationMs": round((time.perf_counter() - started_at) * 1000, 1),
            **extra,
        }
    )


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


def wait_for_analysis(page: Any, timings: List[Dict[str, Any]]) -> Dict[str, Any]:
    started_at = time.perf_counter()
    page.wait_for_selector("#oa-finance-rebuild-root", timeout=60000)
    record_timing(timings, "analysis-root-wait", started_at)

    started_at = time.perf_counter()
    page.locator("#oa-finance-rebuild-root .oa-finance-rebuild-run").click()
    record_timing(timings, "analysis-button-click", started_at)

    wait_status = "ok"
    started_at = time.perf_counter()
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
        wait_status = "timeout"
    record_timing(timings, "analysis-json-wait", started_at, status=wait_status)

    started_at = time.perf_counter()
    page.wait_for_timeout(3000)
    record_timing(timings, "analysis-post-wait", started_at)

    started_at = time.perf_counter()
    panel_state = collect_panel_state(page)
    record_timing(timings, "analysis-panel-collect", started_at)
    return panel_state


def main() -> int:
    script_started_at = time.perf_counter()
    target_url = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_TARGET_URL
    timestamp = time.strftime("%Y%m%d_%H%M%S")
    output_dir = OUTPUT_ROOT / f"run_{timestamp}"
    output_dir.mkdir(parents=True, exist_ok=True)
    timings: List[Dict[str, Any]] = []

    started_at = time.perf_counter()
    profile_removed = PROFILE_DIR.exists()
    if PROFILE_DIR.exists():
        shutil.rmtree(PROFILE_DIR)
    record_timing(timings, "profile-reset", started_at, removed=profile_removed)

    console_logs: List[Dict[str, str]] = []
    page_errors: List[str] = []

    with sync_playwright() as playwright:
        started_at = time.perf_counter()
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
        record_timing(timings, "browser-launch", started_at)

        started_at = time.perf_counter()
        page = context.pages[0] if context.pages else context.new_page()
        record_timing(timings, "page-create", started_at)

        page.on("console", lambda msg: console_logs.append({"type": msg.type, "text": msg.text}))
        page.on("pageerror", lambda exc: page_errors.append(str(exc)))

        started_at = time.perf_counter()
        login_page(page, USERNAME, PASSWORD)
        record_timing(timings, "login", started_at, finalUrl=page.url)

        started_at = time.perf_counter()
        page.goto(target_url, wait_until="domcontentloaded", timeout=120000)
        record_timing(timings, "target-goto", started_at, finalUrl=page.url)

        started_at = time.perf_counter()
        page.wait_for_timeout(5000)
        record_timing(timings, "target-settle-wait", started_at)

        panel_state = wait_for_analysis(page, timings)
        screenshot_path = output_dir / "panel.png"

        started_at = time.perf_counter()
        page.screenshot(path=str(screenshot_path), full_page=True)
        record_timing(timings, "screenshot", started_at)

        started_at = time.perf_counter()
        context.close()
        record_timing(timings, "browser-close", started_at)

    analysis = None
    started_at = time.perf_counter()
    if panel_state.get("analysisJson"):
        try:
            analysis = json.loads(panel_state["analysisJson"])
        except json.JSONDecodeError:
            analysis = None
    record_timing(timings, "analysis-json-parse", started_at, parsed=analysis is not None)

    result = {
        "url": target_url,
        "panel_state": panel_state,
        "analysis": analysis,
        "console_logs": console_logs,
        "page_errors": page_errors,
        "screenshot": str(screenshot_path),
        "timings": {
            "totalDurationMs": round((time.perf_counter() - script_started_at) * 1000, 1),
            "entries": timings,
        },
    }

    (output_dir / "result.json").write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
