import hashlib
import json
import mimetypes
import os
import secrets
import sqlite3
import time
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

from argon2 import PasswordHasher
from dotenv import load_dotenv
from fastapi import FastAPI, File, Form, HTTPException, Request, Response, UploadFile
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from starlette.middleware.cors import CORSMiddleware

BASE_DIR = Path(__file__).resolve().parents[1]
load_dotenv(BASE_DIR / ".env")

DATA_DIR = BASE_DIR / "data"
DB_PATH = DATA_DIR / "flashback.sqlite3"
UPLOAD_DIR = DATA_DIR / "uploads"
FRONTEND_DIR = BASE_DIR / "public"
DATA_DIR.mkdir(parents=True, exist_ok=True)
UPLOAD_DIR.mkdir(parents=True, exist_ok=True)

ph = PasswordHasher()
SESSION_COOKIE = os.getenv("SESSION_COOKIE", "fb_session")
SESSION_TTL_SEC = int(os.getenv("SESSION_TTL_SEC", "604800"))
SECURE_COOKIES = os.getenv("SECURE_COOKIES", "false").lower() == "true"

# File extension → system. 'flash' = Ruffle (.swf); the rest are console ROMs
# played via EmulatorJS cores in the frontend.
EXT_SYSTEM = {
    ".swf": "flash",
    # NES
    ".nes": "nes",
    # SNES (console cartridges / copier formats)
    ".sfc": "snes", ".smc": "snes", ".fig": "snes", ".swc": "snes",
    # Game Boy / Game Boy Color (mGBA/gambatte also reads Super GB)
    ".gb": "gb", ".gbc": "gb", ".sgb": "gb",
    # Sega Genesis / Mega Drive (+ common dump formats)
    ".md": "genesis", ".gen": "genesis", ".bin": "genesis", ".smd": "genesis",
}
ALLOWED_EXTS = set(EXT_SYSTEM)

app = FastAPI(title="ROMulator2K")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_credentials=True, allow_methods=["*"], allow_headers=["*"])
app.mount("/uploads", StaticFiles(directory=str(UPLOAD_DIR)), name="uploads")
app.mount("/assets", StaticFiles(directory=str(FRONTEND_DIR)), name="assets")

def now_iso():
    return datetime.now(timezone.utc).isoformat()

def dbconn():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn

def init_db():
    c = dbconn()
    c.executescript("""
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      role TEXT NOT NULL DEFAULT 'user',
      cloud_banned INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      approved_at TEXT
    );
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      token_hash TEXT NOT NULL UNIQUE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS cloud_games (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      display_name TEXT NOT NULL,
      size INTEGER NOT NULL DEFAULT 0,
      storage_path TEXT NOT NULL,
      uploaded_by TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      uploaded_by_name TEXT NOT NULL,
      uploaded_at TEXT NOT NULL,
      play_count INTEGER NOT NULL DEFAULT 0,
      system TEXT NOT NULL DEFAULT 'flash'
    );
    """)
    c.commit()
    # migration: add system column to DBs created before ROM support
    cols = [r[1] for r in c.execute("PRAGMA table_info(cloud_games)").fetchall()]
    if "system" not in cols:
        c.execute("ALTER TABLE cloud_games ADD COLUMN system TEXT NOT NULL DEFAULT 'flash'")
        c.commit()
    # index only after the column is guaranteed to exist
    c.execute("CREATE INDEX IF NOT EXISTS idx_cloud_games_system ON cloud_games(system)")
    c.commit()
    # seed admin
    email = os.getenv("FLASHBACK_ADMIN_EMAIL", "admin@localhost")
    password = os.getenv("FLASHBACK_ADMIN_PASSWORD", "ChangeMe123!")
    name = os.getenv("FLASHBACK_ADMIN_NAME", "Flashback Owner")
    row = c.execute("SELECT id FROM users WHERE email=?", (email,)).fetchone()
    if not row:
        c.execute("""INSERT INTO users (id, username, email, password_hash, status, role, cloud_banned, created_at, approved_at)
                   VALUES (?, ?, ?, ?, 'approved', 'admin', 0, ?, ?)""",
                  (str(uuid.uuid4()), name, email, ph.hash(password), now_iso(), now_iso()))
        c.commit()
    c.close()

init_db()

def get_session_user(request):
    token = request.cookies.get(SESSION_COOKIE)
    if not token:
        return None
    th = hashlib.sha256(token.encode()).hexdigest()
    c = dbconn()
    row = c.execute("""SELECT users.* FROM sessions JOIN users ON users.id=sessions.user_id
                      WHERE token_hash=? AND expires_at>?""", (th, now_iso())).fetchone()
    c.close()
    return dict(row) if row else None

def require_user(request):
    u = get_session_user(request)
    if not u:
        raise HTTPException(401, "not authenticated")
    if u["status"] in ("blocked", "deleted"):
        raise HTTPException(403, "access denied")
    return u

def require_admin(u):
    if u["role"] not in ("admin", "owner"):
        raise HTTPException(403, "admin only")

@app.on_event("startup")
def startup():
    init_db()

@app.get("/")
def index():
    return FileResponse(FRONTEND_DIR / "index.html")

# Auth
@app.post("/api/auth/register")
def register(data: dict, response: Response):
    username = (data.get("username") or "").strip()
    email = (data.get("email") or "").strip()
    password = data.get("password") or ""
    if len(username) < 3:
        raise HTTPException(400, "username too short")
    if len(password) < 6:
        raise HTTPException(400, "password too short")
    uid = str(uuid.uuid4())
    c = dbconn()
    try:
        c.execute("""INSERT INTO users (id, username, email, password_hash, status, role, cloud_banned, created_at)
                   VALUES (?, ?, ?, ?, ?, ?, 0, ?)""",
                  (uid, username, email, ph.hash(password), "approved", "user", now_iso()))
        # first user becomes admin
        count = c.execute("SELECT COUNT(*) FROM users").fetchone()[0]
        if count == 1:
            c.execute("UPDATE users SET role='admin', status='approved', approved_at=? WHERE id=?", (now_iso(), uid))
        c.commit()
    except sqlite3.IntegrityError:
        c.close()
        raise HTTPException(400, "email or username already exists")
    c.close()
    return {"ok": True, "uid": uid, "first": True}

@app.post("/api/auth/login")
def login(data: dict, request: Request, response: Response):
    email = (data.get("email") or "").strip()
    password = data.get("password") or ""
    remember = bool(data.get("remember", True))
    c = dbconn()
    row = c.execute("SELECT * FROM users WHERE email=?", (email,)).fetchone()
    if not row:
        c.close()
        raise HTTPException(401, "invalid credentials")
    try:
        ph.verify(row["password_hash"], password)
    except Exception:
        c.close()
        raise HTTPException(401, "invalid credentials")
    uid = row["id"]
    token = secrets.token_urlsafe(32)
    th = hashlib.sha256(token.encode()).hexdigest()
    expires = (datetime.now(timezone.utc) + timedelta(seconds=(SESSION_TTL_SEC if remember else 86400))).isoformat()
    c.execute("INSERT INTO sessions (id, token_hash, user_id, expires_at) VALUES (?, ?, ?, ?)",
             (str(uuid.uuid4()), th, uid, expires))
    c.commit()
    c.close()
    # Secure cookie when explicitly configured, or automatically when the
    # request arrives over HTTPS (ngrok sets X-Forwarded-Proto).
    is_https = request.headers.get("x-forwarded-proto", "").lower() == "https" or request.url.scheme == "https"
    response.set_cookie(SESSION_COOKIE, token, httponly=True, samesite="lax",
                         secure=(SECURE_COOKIES or is_https), max_age=(SESSION_TTL_SEC if remember else 86400))
    return {"ok": True}

@app.post("/api/auth/logout")
def logout(request: Request, response: Response):
    token = request.cookies.get(SESSION_COOKIE)
    if token:
        th = hashlib.sha256(token.encode()).hexdigest()
        c = dbconn()
        c.execute("DELETE FROM sessions WHERE token_hash=?", (th,))
        c.commit()
        c.close()
    response.delete_cookie(SESSION_COOKIE)
    return {"ok": True}

@app.get("/api/auth/session")
def session(request: Request):
    u = get_session_user(request)
    if not u:
        raise HTTPException(401, "not authenticated")
    return {
        "uid": u["id"],
        "username": u["username"],
        "email": u["email"],
        "status": u["status"],
        "role": u["role"],
        "cloud_banned": bool(u["cloud_banned"]),
    }

@app.put("/api/users/me")
def update_me(data: dict, request: Request):
    u = require_user(request)
    c = dbconn()
    c.execute("UPDATE users SET username=?, email=? WHERE id=?", (data.get("username", u["username"]), data.get("email", u["email"]), u["id"]))
    c.commit()
    c.close()
    return {"ok": True}

@app.get("/api/users/bootstrap")
def users_bootstrap(request: Request):
    require_user(request)
    c = dbconn()
    count = c.execute("SELECT COUNT(*) FROM users").fetchone()[0]
    c.close()
    return {"empty": count == 0}

# Cloud games
@app.get("/api/cloud-games")
def cloud_list():
    c = dbconn()
    rows = c.execute("""SELECT id, name, display_name, size, storage_path, uploaded_by, uploaded_by_name, uploaded_at, play_count, system
                       FROM cloud_games ORDER BY uploaded_at DESC""").fetchall()
    out = []
    for r in rows:
        out.append({
            "id": r["id"],
            "name": r["name"],
            "displayName": r["display_name"],
            "size": r["size"],
            "storageUrl": "/uploads/" + r["storage_path"],
            "storagePath": r["storage_path"],
            "uploadedBy": r["uploaded_by"],
            "uploadedByName": r["uploaded_by_name"],
            "uploadedAt": {"seconds": 0},
            "playCount": r["play_count"],
            "system": r["system"] or "flash",
        })
    c.close()
    return out

@app.post("/api/cloud-games")
async def upload(request: Request, file: UploadFile = File(...), displayName: str = Form(None)):
    u = require_user(request)
    if u["status"] != "approved":
        raise HTTPException(403, "not approved")
    if u["cloud_banned"]:
        raise HTTPException(403, "cloud banned")
    data = await file.read()
    if len(data) > 50 * 1024 * 1024:
        raise HTTPException(413, "file too large")
    ext = Path(file.filename or "").suffix.lower()
    system = EXT_SYSTEM.get(ext)
    if system is None:
        allowed = ", ".join(sorted(ALLOWED_EXTS))
        raise HTTPException(400, f"unsupported file type {ext or '(none)'} — allowed: {allowed}")
    gid = str(uuid.uuid4())
    safe_name = f"{u['id']}/{int(time.time())}-{file.filename}"
    path = UPLOAD_DIR / safe_name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    default_display = Path(file.filename).stem  # strip any extension
    c = dbconn()
    c.execute("""INSERT INTO cloud_games (id, name, display_name, size, storage_path, uploaded_by, uploaded_by_name, uploaded_at, play_count, system)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?)""",
              (gid, file.filename, displayName or default_display, len(data), safe_name, u["id"], u["username"] or u["email"], now_iso(), system))
    c.commit()
    c.close()
    return {"id": gid, "storageUrl": "/uploads/" + safe_name, "system": system}

@app.delete("/api/cloud-games/{gid}")
def delete_game(gid: str, request: Request):
    u = require_user(request)
    c = dbconn()
    row = c.execute("SELECT * FROM cloud_games WHERE id=?", (gid,)).fetchone()
    if not row:
        c.close()
        raise HTTPException(404, "not found")
    if u["role"] not in ("admin", "owner") and row["uploaded_by"] != u["id"]:
        c.close()
        raise HTTPException(403, "not allowed")
    path = UPLOAD_DIR / row["storage_path"]
    try:
        path.unlink(missing_ok=True)
    except Exception:
        pass
    c.execute("DELETE FROM cloud_games WHERE id=?", (gid,))
    c.commit()
    c.close()
    return {"ok": True}

@app.post("/api/cloud-games/{gid}/play")
def inc_play(gid: str, request: Request):
    require_user(request)
    c = dbconn()
    c.execute("UPDATE cloud_games SET play_count=play_count+1 WHERE id=?", (gid,))
    c.commit()
    c.close()
    return {"ok": True}

# Admin users
@app.get("/api/admin/users")
def admin_users(request: Request):
    u = require_user(request)
    require_admin(u)
    c = dbconn()
    rows = c.execute("SELECT * FROM users ORDER BY created_at DESC").fetchall()
    out = []
    for r in rows:
        out.append({
            "uid": r["id"],
            "username": r["username"],
            "email": r["email"],
            "status": r["status"],
            "role": r["role"],
            "cloudBanned": bool(r["cloud_banned"]),
            "createdAt": r["created_at"],
        })
    c.close()
    return out

@app.post("/api/admin/users/{uid}/status")
def admin_status(uid: str, data: dict, request: Request):
    u = require_user(request)
    require_admin(u)
    c = dbconn()
    c.execute("UPDATE users SET status=?, approved_at=CASE WHEN ?='approved' THEN ? ELSE approved_at END WHERE id=?",
              (data.get("status"), data.get("status"), now_iso(), uid))
    c.commit()
    c.close()
    return {"ok": True}

@app.post("/api/admin/users/{uid}/cloud-ban")
def admin_cloud_ban(uid: str, data: dict, request: Request):
    u = require_user(request)
    require_admin(u)
    c = dbconn()
    c.execute("UPDATE users SET cloud_banned=? WHERE id=?", (1 if data.get("banned") else 0, uid))
    c.commit()
    c.close()
    return {"ok": True}

@app.post("/api/admin/users/{uid}/update")
def admin_update(uid: str, data: dict, request: Request):
    u = require_user(request)
    require_admin(u)
    c = dbconn()
    c.execute("""UPDATE users SET username=?, email=?, status=?, role=?, cloud_banned=? WHERE id=?""",
              (data.get("username"), data.get("email"), data.get("status"), data.get("role"),
               1 if data.get("cloud_banned") else 0, uid))
    if data.get("status") == "approved":
        c.execute("UPDATE users SET approved_at=? WHERE id=?", (now_iso(), uid))
    c.commit()
    c.close()
    return {"ok": True}

@app.post("/api/admin/users/{uid}/delete")
def admin_delete(uid: str, request: Request):
    u = require_user(request)
    require_admin(u)
    if uid == u["id"]:
        raise HTTPException(400, "cannot delete self")
    c = dbconn()
    c.execute("DELETE FROM users WHERE id=?", (uid,))
    c.commit()
    c.close()
    return {"ok": True}

@app.get("/{path:path}")
def spa(path: str):
    candidate = FRONTEND_DIR / path
    if path and not path.endswith('/') and candidate.is_file():
        return FileResponse(candidate)
    index = FRONTEND_DIR / "index.html"
    return FileResponse(index)