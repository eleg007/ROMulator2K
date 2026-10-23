#!/usr/bin/env python3
"""Headless-browser E2E for ROMulator2K ROM support.

Covers:
  * import of 4 test ROMs into IndexedDB via the real file input
  * boot of each system (EmulatorJS 4.2.3 CDN) to 'running' status
  * bridge commands: pause / resume / status / saveState / loadState /
    screenshot / reset
  * iframe screenshots per system (tests/e2e/*.png — verify colours by eye:
      NES red/blue, GB black/white, SNES/Genesis blue/red backdrop)
  * ROM "upload to cloud" button -> system field -> API cleanup
  * Flash regression: play the existing cloud SWF through launchRuffle

Run:  tests/.venv/bin/python tests/test_e2e_roms.py   (server must be up)
"""
import re
import sys
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

BASE = "http://127.0.0.1:8010"
ROOT = Path(__file__).parent
ROMS = ROOT / "roms"
SHOTS = ROOT / "e2e"

# (file, exact .sys-tag label shown in the ROM library)
SYSTEMS = [
    ("test.nes", "NES"),
    ("test.gb", "Game Boy"),
    ("test.sfc", "SNES"),
    ("test.md", "Genesis"),
]

results = []


def note(ok, label, extra=""):
    results.append(bool(ok))
    print(f"  [{'PASS' if ok else 'FAIL'}] {label}" + (f" — {extra}" if extra else ""), flush=True)


SHOTS.mkdir(exist_ok=True)

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, args=[
        "--autoplay-policy=no-user-gesture-required",
        "--enable-unsafe-swiftshader",
    ])
    ctx = browser.new_context(viewport={"width": 1360, "height": 940})
    page = ctx.new_page()

    # Self-hosted EmulatorJS: cdn.emulatorjs.org is filtered on the target
    # network. Abort every attempt to reach it — the runtime is mirrored in
    # public/emulators/ejs/, and these tests must pass without the CDN.
    cdn_blocked = []
    ctx.route(re.compile(r"^https?://cdn\.emulatorjs\.org/"),
              lambda route: (cdn_blocked.append(route.request.url), route.abort()))

    console_log = []
    page.on("console", lambda m: console_log.append((m.type, m.text)))
    page.on("pageerror", lambda e: console_log.append(("pageerror", str(e))))

    # ── login (cookies shared with the page) ─────────────────────
    r = ctx.request.post(f"{BASE}/api/auth/login",
                         data=b'{"email":"admin@localhost","password":"ChangeMe123!"}',
                         headers={"Content-Type": "application/json"})
    note(r.status == 200, "admin login", r.status)

    page.goto(BASE + "/", wait_until="domcontentloaded")
    page.wait_for_selector(".sidebar-tab", timeout=15000)

    # record every bridge status the RomPlayer emits
    page.evaluate("""() => {
      window.__statuses = [];
      const orig = window.RomPlayer.prototype._emit;
      window.RomPlayer.prototype._emit = function (evt, data) {
        if (evt === 'status') window.__statuses.push({ status: data.status, message: data.message });
        return orig.call(this, evt, data);
      };
    }""")

    # ── import all four ROMs through the real input ─────────────
    page.evaluate("switchSidebarTab('roms')")
    page.set_input_files("#romFileInput", [str(ROMS / n) for n, _ in SYSTEMS])
    page.wait_for_function(
        "document.querySelectorAll('#romList .game-item').length === 4", timeout=15000)
    note(True, "4 ROMs imported into IndexedDB")

    tags = page.eval_on_selector_all(
        "#romList .game-item",
        "els => els.map(e => e.querySelector('.sys-tag').textContent)")
    for _, label in SYSTEMS:
        note(label in tags, f"sys-tag '{label}' rendered", tags)

    # ── boot every system ───────────────────────────────────────
    for fname, label in SYSTEMS:
        page.evaluate("window.__statuses = []")
        page.evaluate("""(label) => {
          const it = [...document.querySelectorAll('#romList .game-item')]
            .find(i => i.querySelector('.sys-tag').textContent === label);
          it.click();
        }""", label)

        outcome = "timeout"
        statuses = []
        deadline = time.time() + 100
        while time.time() < deadline:
            statuses = page.evaluate("window.__statuses")
            if any(s["status"] == "running" for s in statuses):
                outcome = "running"
                break
            if any(s["status"] == "error" for s in statuses):
                outcome = "error"
                break
            page.wait_for_timeout(500)
        s_text = page.evaluate("document.getElementById('sText').textContent")
        note(outcome == "running", f"{fname} boots",
             f"outcome={outcome} sText={s_text} statuses={[s['status'] for s in statuses]}")

        if outcome != "running":
            page.evaluate("stopGame()")
            page.wait_for_timeout(400)
            continue

        res = page.evaluate("""async () => {
          const out = {};
          try {
            await romPlayer.pause();                out.pause  = true;
            await romPlayer.resume();               out.resume = true;
            const st = await romPlayer.status();    out.started = !!st.started;
            const bytes = await romPlayer.saveState();
            out.stateLen = (bytes && bytes.byteLength) || 0;
            if (out.stateLen) await romPlayer.loadState(bytes);
            const shot = await romPlayer.screenshot(); out.shotLen = shot ? shot.length : 0;
            await romPlayer.reset();                out.reset  = true;
          } catch (e) { out.err = String(e); }
          return out;
        }""")
        note(res.get("pause") and res.get("resume") and res.get("started")
             and res.get("stateLen", 0) > 0 and res.get("shotLen", 0) > 0
             and res.get("reset") and not res.get("err"),
             f"{fname} bridge commands", res)

        page.wait_for_timeout(1200)   # let frames render
        shot_path = SHOTS / (fname.replace(".", "_") + ".png")
        try:
            page.locator("iframe.rom-iframe").screenshot(path=str(shot_path))
            note(True, f"{fname} screenshot -> {shot_path.name}")
        except Exception as ex:
            note(False, f"{fname} screenshot", ex)

        page.evaluate("stopGame()")
        page.wait_for_timeout(400)

    # ── ROM share-to-cloud: button path, then cleanup ───────────
    uploaded_gid = None
    page.evaluate("switchSidebarTab('roms')")
    clicked = page.evaluate("""() => {
      const it = [...document.querySelectorAll('#romList .game-item')]
        .find(i => i.querySelector('.sys-tag').textContent === 'SNES');
      const btn = it && it.querySelector('button[title="Upload to cloud"]');
      if (btn) { btn.click(); return true; }
      return false;
    }""")
    if clicked:
        for _ in range(40):
            lst = ctx.request.get(f"{BASE}/api/cloud-games").json()
            hit = next((g for g in lst
                        if g.get("name") == "test.sfc" and g.get("system") == "snes"), None)
            if hit:
                uploaded_gid = hit["id"]
                break
            page.wait_for_timeout(500)
        note(uploaded_gid, "test.sfc visible in cloud API with system=snes")
        if uploaded_gid:
            rr = ctx.request.delete(f"{BASE}/api/cloud-games/{uploaded_gid}")
            note(rr.status == 200, "test.sfc cleaned up from cloud", rr.status)
    else:
        note(False, "cloud-upload button present on SNES item")

    # ── flash regression: play the existing cloud SWF ───────────
    page.evaluate("switchSidebarTab('cloud')")
    try:
        page.wait_for_selector("#cloudList .cloud-item", timeout=15000)
        mark = len(console_log)
        page.evaluate("""() => {
          const it = document.querySelector('#cloudList .cloud-item');
          it.click();
        }""")
        # ruffle-player is light-DOM; its canvas sits in a shadow root. The
        # movie is parsed once waitForRuffleMeta -> applyDims changed the wrap
        # aspect ratio away from the initial '4 / 3'.
        page.wait_for_function("""() => {
          const wrap = document.getElementById('ruffleWrap');
          const player = document.querySelector('#ruffleWrap ruffle-player');
          return !!player && wrap.style.aspectRatio !== '' && wrap.style.aspectRatio !== '4 / 3';
        }""", timeout=30000)
        note(True, "flash cloud game launches Ruffle (movie metadata parsed)")
        page.wait_for_timeout(4000)
        try:
            page.locator("#ruffleWrap").screenshot(path=str(SHOTS / "flash.png"))
            note(True, "flash screenshot -> flash.png")
        except Exception as ex:
            note(False, "flash screenshot", ex)
        after_errors = [c for c in console_log[mark:]
                        if c[0] == "pageerror" and "Wake Lock" not in c[1]]
        note(not after_errors, "no page errors during flash boot", after_errors[:3])
    except Exception as ex:
        note(False, "flash regression", ex)
    page.evaluate("stopGame()")

    # ── console report ──────────────────────────────────────────
    # headless Chromium denies the Screen Wake Lock API — harmless noise
    errors = [c for c in console_log
              if c[0] in ("pageerror", "error") and "Wake Lock" not in c[1]]
    warns = [c for c in console_log if c[0] == "warning"]
    print(f"\n  console: {len(console_log)} messages, "
          f"{len(errors)} errors, {len(warns)} warnings")
    for kind, text in errors[:12]:
        print(f"    [{kind}] {text[:220]}")
    if cdn_blocked:
        print(f"  cdn.emulatorjs.org attempts (blocked): {len(cdn_blocked)}")
        for u in sorted(set(cdn_blocked)):
            print("    ", u)
    else:
        print("  cdn.emulatorjs.org attempts (blocked): 0 — fully self-hosted")

    browser.close()

failed = results.count(False)
print(f"\n{'ALL E2E TESTS PASSED' if failed == 0 else str(failed) + ' E2E TESTS FAILED'}"
      f" ({len(results)} checks)")
sys.exit(0 if failed == 0 else 1)
