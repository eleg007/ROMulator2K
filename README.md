# ROMulator2K (FLASHBACK)

Self-hosted FLASHBACK flash-game emulator.

## Stack

- **Backend:** FastAPI + SQLite (Python), auth, uploads, admin approval
- **Frontend:** dark-themed browser UI — Ruffle (Flash), console ROM support, JSZip
- **Deployment:** self-hosted behind ngrok (systemd units in `systemd/`)

## Run locally

```bash
cd /home/debian/projects/ROMulator2K
/home/debian/projects/orbit-chat/.venv/bin/uvicorn backend.main:app --host 127.0.0.1 --port 8010
```

Copy `.env.example` to `.env` and edit as needed.

## Dependencies

See `requirements.txt` (fastapi, uvicorn[standard], python-dotenv, argon2-cffi).

## Components

See `COMPONENTS.md`.
