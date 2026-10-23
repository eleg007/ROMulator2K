// ROMulator2K — console ROM support (parent side).
// RomPlayer drives public/emulators/player.html (same-origin iframe running
// EmulatorJS 4.2.3) through a small postMessage protocol. Loading a ROM is:
//   const p = new RomPlayer(container);
//   await p.load({ system: 'nes', name: 'Game.nes', file });
// Classic script (not a module) so index.html can use it directly.
// Exposes: window.RomPlayer, window.romUtils

(function () {
'use strict';

// ── System / extension tables (kept in sync with backend EXT_SYSTEM) ──
const ROM_EXT_SYSTEM = {
  '.nes': 'nes',
  '.sfc': 'snes', '.smc': 'snes', '.fig': 'snes', '.swc': 'snes',
  '.gb': 'gb', '.gbc': 'gb', '.sgb': 'gb',
  '.md': 'genesis', '.gen': 'genesis', '.bin': 'genesis', '.smd': 'genesis',
};
const ROM_EXTS   = Object.keys(ROM_EXT_SYSTEM);
const FLASH_EXTS = ['.swf', '.zip'];

const SYSTEM_META = {
  nes:     { label: 'NES',      aspect: '4 / 3' },
  snes:    { label: 'SNES',     aspect: '4 / 3' },
  gb:      { label: 'Game Boy', aspect: '10 / 9' },
  genesis: { label: 'Genesis',  aspect: '4 / 3' },
  flash:   { label: 'Flash',    aspect: '4 / 3' },
};

function extOf(name) {
  const m = /\.[^./\\]+$/.exec(name || '');
  return m ? m[0].toLowerCase() : '';
}
function detectSystem(name) { return ROM_EXT_SYSTEM[extOf(name)] || null; }
function isRomFile(name)    { return !!ROM_EXT_SYSTEM[extOf(name)]; }
function systemLabel(s)     { return (SYSTEM_META[s] && SYSTEM_META[s].label) || s || ''; }
function systemAspect(s)    { return (SYSTEM_META[s] && SYSTEM_META[s].aspect) || '4 / 3'; }

const COMMAND_TIMEOUT_MS = 20000;   // state ops / core commands
let iframeSeq = 0;

class RomPlayer {
  constructor(container) {
    if (!container) throw new Error('RomPlayer requires a container element');
    this.container   = container;
    this.iframe      = null;
    this._listeners  = Object.create(null);
    this._pending    = new Map();
    this._cmdId      = 0;
    this._romSent    = false;
    this._romFile    = null;
    this._onMessage  = this._handleMessage.bind(this);
    window.addEventListener('message', this._onMessage);
  }

  // ── events: 'status' ({status, message}) ──
  on(evt, cb) { (this._listeners[evt] || (this._listeners[evt] = [])).push(cb); return this; }
  _emit(evt, data) {
    (this._listeners[evt] || []).forEach(cb => { try { cb(data); } catch (err) { console.error(err); } });
  }

  _handleMessage(e) {
    if (e.origin !== location.origin) return;
    if (!this.iframe || e.source !== this.iframe.contentWindow) return;
    const d = e.data;
    if (!d || typeof d !== 'object') return;

    if (d.type === 'ejs-init') {
      this._sendRom();
    } else if (d.type === 'ejs-status') {
      this._emit('status', { status: d.status, message: d.message });
    } else if (d.type === 'ejs-result') {
      const p = this._pending.get(d.id);
      if (p) {
        this._pending.delete(d.id);
        clearTimeout(p.timer);
        if (d.ok) p.resolve(d);
        else p.reject(new Error(d.error || 'command failed'));
      }
    }
  }

  _sendRom() {
    if (this._romSent || !this._romFile) return;
    this._romSent = true;
    this._post({ type: 'ejs-rom', file: this._romFile });
  }

  _post(msg) {
    if (!this.iframe || !this.iframe.contentWindow) throw new Error('player is not attached');
    this.iframe.contentWindow.postMessage(msg, location.origin);
  }

  _command(action, extra) {
    return new Promise((resolve, reject) => {
      if (!this.iframe) { reject(new Error('no player attached')); return; }
      const id = ++this._cmdId;
      const timer = setTimeout(() => {
        if (this._pending.has(id)) { this._pending.delete(id); reject(new Error(action + ' timed out')); }
      }, COMMAND_TIMEOUT_MS);
      this._pending.set(id, { resolve, reject, timer });
      try { this._post(Object.assign({ type: 'ejs-command', id, action }, extra || {})); }
      catch (err) { this._pending.delete(id); clearTimeout(timer); reject(err); }
    });
  }

  /**
   * Start a game. Accepts:
   *   { system, name, file }  — File/Blob (local ROM or cached cloud ROM)
   *   { system, name, url }   — same-origin URL (cloud ROM streamed directly)
   * Resolves once the game is actually running; rejects on emulator error.
   */
  load({ system, name, file, url }) {
    this.stop();
    if (!system || !SYSTEM_META[system] || system === 'flash') {
      return Promise.reject(new Error('unsupported system: ' + system));
    }
    if (!file && !url) return Promise.reject(new Error('no ROM source given'));

    this._romFile = file || null;
    this._romSent = false;

    const iframe = document.createElement('iframe');
    iframe.className = 'rom-iframe';
    iframe.title = 'Emulator: ' + (name || system);
    iframe.setAttribute('allow', 'autoplay; fullscreen; gamepad');
    iframe.setAttribute('allowfullscreen', '');
    const q = new URLSearchParams({
      core:   system,
      name:   name || 'game',
      origin: location.origin,
    });
    if (!file && url) q.set('url', url);
    iframe.src = '/assets/emulators/player.html?' + q.toString();
    this.iframe = iframe;
    this.container.appendChild(iframe);

    return new Promise((resolve, reject) => {
      const onStatus = (d) => {
        if (d.status === 'running') { cleanup(); resolve(); }
        else if (d.status === 'error') { cleanup(); this.stop(); reject(new Error(d.message || 'emulator error')); }
      };
      const cleanup = () => {
        const arr = this._listeners['status'];
        if (arr) { const i = arr.indexOf(onStatus); if (i !== -1) arr.splice(i, 1); }
        clearTimeout(guard);
      };
      this.on('status', onStatus);
      // First status arrives quickly; give the CDN core download plenty of room.
      const guard = setTimeout(() => {
        cleanup();
        reject(new Error('emulator took too long to start (network?)'));
      }, 90000);
    });
  }

  pause()      { return this._command('pause'); }
  resume()     { return this._command('play'); }
  reset()      { return this._command('reset'); }
  saveState()  { return this._command('saveState').then(d => d.bytes); }
  loadState(bytes) { return this._command('loadState', { bytes }); }
  screenshot() { return this._command('screenshot').then(d => d.dataUrl); }
  status()     { return this._command('status'); }

  // Tear the emulator down: removing the iframe kills its JS/WASM/audio world.
  stop() {
    if (this.iframe) {
      const el = this.iframe;
      this.iframe = null;
      el.remove();
    }
    this._romFile = null;
    this._romSent = false;
    this._pending.forEach(p => { clearTimeout(p.timer); p.reject(new Error('player stopped')); });
    this._pending.clear();
  }

  destroy() {
    this.stop();
    window.removeEventListener('message', this._onMessage);
    this._listeners = Object.create(null);
  }
}

window.RomPlayer = RomPlayer;
window.romUtils = {
  ROM_EXT_SYSTEM, ROM_EXTS, FLASH_EXTS, SYSTEM_META,
  extOf, detectSystem, isRomFile, systemLabel, systemAspect,
};

})();
