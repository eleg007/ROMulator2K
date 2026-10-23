# ROMulator2K — Components

ROM library/streaming web app: single-file FastAPI backend, static frontend with
bundled emulators, archived Firebase functions, and Playwright-based tests.

## systemd services

Unit files live in `systemd/` (not necessarily installed on this host).

| Unit | Type | Purpose |
|---|---|---|
| `romulator2k-backend.service` | simple | Runs the FastAPI backend via uvicorn on `127.0.0.1:8010` with proxy headers. Runs as `debian`, `WorkingDirectory=/home/debian/projects/ROMulator2K`, `EnvironmentFile=.env`. `Restart=always`. |
| `romulator2k-ngrok.service` | simple | Public ngrok tunnel for port 8010 using `ngrok.yml`. Ordered after / wants `romulator2k-backend.service`. `Restart=always`. |

Note: the backend unit reuses the `orbit-chat` project's venv for uvicorn.

## Libraries / dependencies

### Python (`requirements.txt`)
- fastapi `>=0.109`
- uvicorn[standard] `>=0.27`
- python-dotenv `>=1.0`
- argon2-cffi `>=23.1`

### Node (`firebase-archived/package.json` — archived FLASHBACK Cloud Functions, Node 18)
- firebase-admin `^12.0.0`
- firebase-functions `^5.0.0`
- nodemailer `^6.9.7`

### Tests (`tests/.venv`)
- Playwright (browser automation for `test_e2e_roms.py`)

## Other components

- `backend/main.py` — FastAPI application (single module).
- `public/` — static frontend: `index.html`, `api.js`, `emulators/` (bundled emulator JS).
- `data/` — runtime data directory.
- `.env` / `.env.example` — runtime configuration (both present).
- `ngrok.yml` — ngrok tunnel config.
- `tests/` — `test_api_roms.py`, `test_e2e_roms.py`, `capture_cdn.py`, with its own `.venv`.
- `firebase-archived/` — archived Firebase Cloud Functions code.
- `.tmpcheck/`, `.ngrok.log`, `.uvicorn.log` — scratch/log artifacts.
