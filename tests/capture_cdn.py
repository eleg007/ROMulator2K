#!/usr/bin/env python3
"""Record every non-local network request made while booting all four test ROMs
through the real app flow (import -> play -> running -> bridge commands).

Purpose: cdn.emulatorjs.org is filtered on the target network, so the complete
EmulatorJS runtime surface used by our four cores is mirrored locally under
public/emulators/ejs/. This script produces the download list.

Output: tests/e2e/cdn_requests.json — sorted unique absolute URLs.
"""
import json
from pathlib import Path

from playwright.sync_api import sync_playwright

BASE = "http://127.0.0.1:8010"
ROOT = Path(__file__).parent
OUT = ROOT / "e2e" / "cdn_requests.json"

ROMS = [
    ("test.nes", "NES"),
    ("test.gb", "Game Boy"),
    ("test.sfc", "SNES"),
    ("test.md", "Genesis"),
]

external = set()


def on_request(req):
    if not req.url.startswith(BASE):
        external.add(req.url)


with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, args=[
        "--autoplay-policy=no-user-gesture-required",
        "--enable-unsafe-swiftshader",
    ])
    ctx = browser.new_context(viewport={"width": 1200, "height": 900})
    ctx.on("request", on_request)
    page = ctx.new_page()
    page.on("request", on_request)

    r = ctx.request.post(f"{BASE}/api/auth/login",
                         data=b'{"email":"admin@localhost","password":"ChangeMe123!"}',
                         headers={"Content-Type": "application/json"})
    assert r.status == 200, r.status
    page.goto(BASE + "/", wait_until="domcontentloaded")
    page.wait_for_selector(".sidebar-tab")
    page.evaluate("""() => {
      window.__statuses = [];
      const o = window.RomPlayer.prototype._emit;
      window.RomPlayer.prototype._emit = function (e, d) {
        if (e === 'status') window.__statuses.push(d.status);
        return o.call(this, e, d);
      };
    }""")

    for rom, tag in ROMS:
        page.evaluate("switchSidebarTab('roms')")
        page.set_input_files("#romFileInput", [str(ROOT / "roms" / rom)])
        js_tag = json.dumps(tag)
        page.wait_for_function(
            """(tag) => [...document.querySelectorAll('#romList .game-item')]
                 .some(el => (el.querySelector('.sys-tag')?.textContent || '').trim() === tag)""",
            arg=tag, timeout=15000)
        page.evaluate(
            """(tag) => {
                 const el = [...document.querySelectorAll('#romList .game-item')]
                   .find(el => (el.querySelector('.sys-tag')?.textContent || '').trim() === tag);
                 el.click();
               }""", arg=tag)
        page.evaluate("window.__statuses = []")
        page.wait_for_function(
            "window.__statuses.includes('running') || window.__statuses.includes('error')",
            timeout=90000)
        statuses = page.evaluate("window.__statuses")
        assert "running" in statuses, (rom, statuses)
        # exercise state/screenshot paths too (they may pull extra assets)
        page.evaluate("""async () => {
          try { await romPlayer.saveState(); } catch (e) {}
          try { await romPlayer.screenshot(); } catch (e) {}
        }""")
        page.wait_for_timeout(800)

    browser.close()

urls = sorted(external)
OUT.write_text(json.dumps(urls, indent=2))
print(f"{len(urls)} external requests -> {OUT}")
for u in urls:
    print(" ", u)
