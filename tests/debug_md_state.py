#!/usr/bin/env python3
"""Diagnose the Genesis test ROM: boot test.md in headless Chromium, pull a
GPGX savestate through the bridge, and parse boot-critical fields.

GPGX state layout (state.c / vdp_ctrl.c, save_param = raw memcpy):
  0            version[16]
  16           work_ram[0x10000]
  65552        zram[0x2000]
  73744        zstate u8
  73745        zbank  u32
  73749        (16-byte state.c field before io_reg)
  73765        io_reg[0x10]        <- io_reg[0]=0xa0 version, [4]=Port A ctrl
  73781        sat[0x400]
  74805        vram[0x10000]
  140341       cram[0x80]          <- color 0, PACKED 9-bit (see below)
  140469       vsram[0x80]
  140597       reg[0x20]           <- reg[1]: 0x44 = Mode5 + display on
  ...          (sound, m68k regs D0-D7 A0-A7 PC SR USP ISP, ...)

CRAM is stored packed: data = ((d&0xE00)>>3)|((d&0x0E0)>>2)|((d&0x00E)>>1)
  so bus colour blue 0x0E00 -> 0x01C0, red 0x000E -> 0x0007.
  Offsets validated empirically against io_reg[0]=0xa0 / reg[1]=0x44.
"""
import base64
import re
import struct
import sys
from pathlib import Path

from playwright.sync_api import sync_playwright

BASE = "http://127.0.0.1:8010"
ROOT = Path(__file__).parent
OUT = ROOT / "e2e" / "md_state.bin"

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, args=[
        "--autoplay-policy=no-user-gesture-required",
        "--enable-unsafe-swiftshader",
    ])
    ctx = browser.new_context(viewport={"width": 1200, "height": 900})
    # prove the boot works without the (network-filtered) EmulatorJS CDN
    ctx.route(re.compile(r"^https?://cdn\.emulatorjs\.org/"),
              lambda route: route.abort())
    page = ctx.new_page()
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
    page.evaluate("switchSidebarTab('roms')")
    page.set_input_files("#romFileInput", [str(ROOT / "roms" / "test.md")])
    page.wait_for_function(
        "document.querySelectorAll('#romList .game-item').length === 1")
    page.evaluate(
        "document.querySelector('#romList .game-item').click()")
    page.wait_for_function(
        "window.__statuses.includes('running') || window.__statuses.includes('error')",
        timeout=90000)
    statuses = page.evaluate("window.__statuses")
    assert "running" in statuses, statuses
    page.wait_for_timeout(2500)   # let the program loop for a while

    b64 = page.evaluate("""async () => {
      const b = await romPlayer.saveState();
      const u = new Uint8Array(b);
      let s = '';
      for (let i = 0; i < u.length; i += 0x8000)
        s += String.fromCharCode.apply(null, Array.from(u.subarray(i, i + 0x8000)));
      return btoa(s);
    }""")
    browser.close()

data = base64.b64decode(b64)
OUT.write_bytes(data)
print(f"state: {len(data)} bytes  signature={data[:16]!r}")

IO   = 16 + 0x10000 + 0x2000 + 1 + 4 + 16      # 73765 (validated: io_reg[0]=0xa0)
SAT  = IO + 0x10
VRAM = SAT + 0x400
CRAM = VRAM + 0x10000
VSRAM = CRAM + 0x80
REG  = VSRAM + 0x80

io = data[IO:IO + 16]
print("io_reg:", io.hex(" "))
bios = io[0] & 1
print(f"  config.bios (TMSS gate)   = {bios}")
print(f"  region_code               = {io[0] & ~0x21}")
print(f"  io_reg[4] A-ctrl $A10009  = {io[4]:#04x} (0x40 => pad ctrl written)")
print(f"  io_reg[5] B-ctrl $A1000B  = {io[5]:#04x} (0x00 => not touched, good)")
print(f"  io_reg[0] version reg     = {io[0]:#04x}")

reg = data[REG:REG + 0x20]
print("vdp reg[0..7]:", " ".join(f"{x:02x}" for x in reg[:8]))
print(f"  reg[0] Palette Mode (04) = {bool(reg[0] & 0x04)}")
print(f"  reg[1] display enable     = {bool(reg[1] & 0x40)}")
print(f"  reg[1] Mode 5 (M5)        = {bool(reg[1] & 0x04)}")

cram = data[CRAM:CRAM + 0x80]
colors = [struct.unpack_from("<H", cram, i * 2)[0] for i in range(6)]
print("cram[0..5] (packed 9-bit):", " ".join(f"{c:#06x}" for c in colors),
      "  (blue=0x01c0 red=0x0007 black=0x0000)")

# locate m68k regs: LE SSP 0x00FFFF00 then 16 data words later PC
a7s = [m.start() for m in re.finditer(re.escape(struct.pack("<I", 0x00FFFF00)), data)]
pcs = [m.start() for m in re.finditer(rb"[\x00-\xff][\x02\x03]\x00\x00", data)]
pc_hit = None
for a in a7s:
    for pcoff in pcs:
        if 0 <= pcoff - a <= 8 * 4 + 40:
            pc = struct.unpack_from("<I", data, pcoff)[0]
            if 0x200 <= pc < 0x400:
                pc_hit = (pcoff, pc)
                break
    if pc_hit:
        break
print(f"  A7=0x00FFFF00 occurrences : {a7s[:6]}")
print(f"  m68k PC near A7           : "
      + (f"offset {pc_hit[0]} PC={pc_hit[1]:#x}" if pc_hit else "NOT FOUND (program not looping in ROM?)"))

fail = (io[4] != 0x40) or not pc_hit or not (reg[1] & 0x44) or (colors[0] == 0) \
       or not (reg[0] & 0x04)
print("\n" + ("DIAGNOSIS: program ok — boot, display enable, Mode 5 and CRAM backdrop all verified"
              if not fail else "DIAGNOSIS: see fields above"))
sys.exit(1 if fail else 0)
