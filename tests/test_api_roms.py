#!/usr/bin/env python3
"""End-to-end API test for ROM uploads (Phase 1A). Hits the live server,
verifies the system column, integrity on download, rejection of bad
extensions, then cleans up all test data."""
import hashlib
import sys
import time
from pathlib import Path

import requests

BASE = "http://127.0.0.1:8010"
ROMS = Path(__file__).parent / "roms"
s = requests.Session()
ok = True


def check(cond, label, extra=""):
    global ok
    status = "PASS" if cond else "FAIL"
    if not cond:
        ok = False
    print(f"  [{status}] {label}{(' — ' + str(extra)) if extra else ''}")


# ── login as admin ────────────────────────────────────────────
r = s.post(f"{BASE}/api/auth/login",
           json={"email": "admin@localhost", "password": "ChangeMe123!"})
check(r.status_code == 200, "admin login", r.status_code)
r = s.get(f"{BASE}/api/auth/session")
me = r.json()
check(r.status_code == 200 and me.get("email") == "admin@localhost",
      "session", me.get("email"))

before = s.get(f"{BASE}/api/cloud-games").json()
before_ids = {g["id"] for g in before}
print(f"  baseline games: {len(before)}")

# ── upload each system ROM ───────────────────────────────────
expected = {"test.nes": "nes", "test.sfc": "snes", "test.gb": "gb", "test.md": "genesis"}
uploaded = []
for fname, system in expected.items():
    data = (ROMS / fname).read_bytes()
    r = s.post(f"{BASE}/api/cloud-games",
               files={"file": (fname, data, "application/octet-stream")})
    check(r.status_code == 200, f"upload {fname} -> 200", r.status_code if r.status_code != 200 else r.json())
    if r.status_code != 200:
        continue
    gid, url, rsys = r.json()["id"], r.json()["storageUrl"], r.json().get("system")
    check(rsys == system, f"{fname} system={system}", rsys)
    uploaded.append((gid, url, fname, data))

# ── plain swf still maps to flash; junk rejected ─────────────
r = s.post(f"{BASE}/api/cloud-games",
           files={"file": ("tiny.swf", b"FWS\x00fake", "application/x-shockwave-flash")})
check(r.status_code == 200 and r.json().get("system") == "flash",
      "upload .swf -> system=flash", r.json() if r.status_code == 200 else r.status_code)
swf = (r.json()["id"], r.json()["storageUrl"], "tiny.swf", b"FWS\x00fake") if r.status_code == 200 else None

r = s.post(f"{BASE}/api/cloud-games", files={"file": ("evil.exe", b"MZ", "application/octet-stream")})
check(r.status_code == 400, "upload .exe -> 400", r.status_code)
r = s.post(f"{BASE}/api/cloud-games", files={"file": ("noext", b"x", "text/plain")})
check(r.status_code == 400, "upload extensionless -> 400", r.status_code)

# ── list: all present with correct fields ────────────────────
lst = s.get(f"{BASE}/api/cloud-games").json()
by_id = {g["id"]: g for g in lst}
for gid, url, fname, data in [x for x in uploaded if x]:
    g = by_id.get(gid)
    check(g is not None, f"list contains {fname}")
    if g:
        check(g.get("system") == expected[fname], f"list {fname} system", g.get("system"))
        check(g.get("displayName") == Path(fname).stem, f"list {fname} displayName=stem", g.get("displayName"))
        check(g.get("name") == fname, f"list {fname} name keeps ext", g.get("name"))
        check(g.get("storageUrl", "").startswith("/uploads/"), f"list {fname} storageUrl", g.get("storageUrl"))

# ── download integrity (md5) ─────────────────────────────────
for gid, url, fname, data in [x for x in uploaded if x] + ([swf] if swf else []):
    r = s.get(BASE + url)
    same = r.status_code == 200 and hashlib.md5(r.content).hexdigest() == hashlib.md5(data).hexdigest()
    check(same, f"download {fname} byte-identical", f"len={len(r.content)}/{len(data)}")

# ── cleanup: delete every uploaded test game ─────────────────
for gid, url, fname, data in [x for x in uploaded if x] + ([swf] if swf else []):
    r = s.delete(f"{BASE}/api/cloud-games/{gid}")
    check(r.status_code == 200, f"delete {fname}", r.status_code if r.status_code != 200 else "")

after = {g["id"] for g in s.get(f"{BASE}/api/cloud-games").json()}
check(after == before_ids, "list restored to baseline", f"{sorted(before_ids)} -> {sorted(after)}")

print("\n" + ("ALL API TESTS PASSED" if ok else "SOME TESTS FAILED"))
sys.exit(0 if ok else 1)
