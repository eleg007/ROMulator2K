
// ══════════════════════════════════════════════════
//  LOCAL BACKEND — auth/db/storage come from /assets/api.js
//  (window.authApi, window.cloudApi, window.adminApi,
//   window.onAuthStateChanged)
// ══════════════════════════════════════════════════

window.RufflePlayer = window.RufflePlayer || {};
const getRuffle = () => window.RufflePlayer.newest();

// ── State ──
const games        = [];
let currentGameIdx  = -1;
let currentCloudGame = null;
let rufflePlayer    = null;
let isPaused        = false;
let currentUserDoc  = null;
let allUsers        = [];
let editingUid      = null;
let activeFilter    = 'all';
let cloudCache      = [];
let cachedGameIds   = new Set();
let pendingDeleteCloudId     = null;
let pendingDeleteCloudPath   = null;
let pendingDeleteUploaderUid = null;
let currentGameKey  = null;
let cloudLibraryLoaded = false;  // guard: only render cloud list after it's been fetched
// ── Console ROM state ──
let romList         = [];        // IndexedDB records {id,name,system,size,addedAt,clouded}
let currentRom      = null;      // playing ROM record (local library)
let romPlayer       = null;      // active RomPlayer instance (iframe)
let cloudSystemFilter = 'all';   // cloud library system filter

// ══════════════════════════════════════════════════
//  SETTINGS (persisted to localStorage)
// ══════════════════════════════════════════════════
const DEFAULT_SETTINGS = {
  renderer:   '',     // '' = auto
  quality:    '',     // '' = default
  frameRate:  '',     // '' = native
  maxExec:    '',     // '' = default (15s)
};

// Default key bindings: { actionName: { label, fromKey, toKey } }
// fromKey = what the game expects; toKey = what the user wants to press
// When user presses toKey, we translate it to fromKey before dispatching.
const DEFAULT_KEYBINDS = [
  { id: 'up',     label: 'Move Up',    fromKey: 'ArrowUp',    toKey: 'ArrowUp'    },
  { id: 'down',   label: 'Move Down',  fromKey: 'ArrowDown',  toKey: 'ArrowDown'  },
  { id: 'left',   label: 'Move Left',  fromKey: 'ArrowLeft',  toKey: 'ArrowLeft'  },
  { id: 'right',  label: 'Move Right', fromKey: 'ArrowRight', toKey: 'ArrowRight' },
  { id: 'action', label: 'Action / Jump', fromKey: 'Space',   toKey: 'Space'      },
  { id: 'fire',   label: 'Fire / Attack', fromKey: 'KeyZ',    toKey: 'KeyZ'       },
  { id: 'pause',  label: 'Pause (game)', fromKey: 'KeyP',     toKey: 'KeyP'       },
];

let perfSettings = { ...DEFAULT_SETTINGS };
let keybinds     = DEFAULT_KEYBINDS.map(k => ({ ...k }));

function loadSettingsFromStorage() {
  try {
    const ps = localStorage.getItem('fb_perf');
    if (ps) perfSettings = { ...DEFAULT_SETTINGS, ...JSON.parse(ps) };
    const kb = localStorage.getItem('fb_keybinds');
    if (kb) keybinds = JSON.parse(kb);
  } catch {}
}
function saveSettingsToStorage() {
  localStorage.setItem('fb_perf', JSON.stringify(perfSettings));
  localStorage.setItem('fb_keybinds', JSON.stringify(keybinds));
}
loadSettingsFromStorage();

// ── Settings modal ──
function openSettings() {
  document.getElementById('pref-renderer').value  = perfSettings.renderer  || '';
  document.getElementById('pref-quality').value   = perfSettings.quality   || '';
  document.getElementById('pref-framerate').value = perfSettings.frameRate || '';
  document.getElementById('pref-maxexec').value   = perfSettings.maxExec   || '';
  buildKeybindGrid();
  document.getElementById('settingsModal').classList.add('open');
}
function closeSettings() {
  document.getElementById('settingsModal').classList.remove('open');
  stopListeningKeybind();
}
function saveSettings() {
  perfSettings.renderer  = document.getElementById('pref-renderer').value;
  perfSettings.quality   = document.getElementById('pref-quality').value;
  perfSettings.frameRate = document.getElementById('pref-framerate').value;
  perfSettings.maxExec   = document.getElementById('pref-maxexec').value;
  saveSettingsToStorage();
  closeSettings();
  showToast('Settings saved — restart the game to apply.');
}

// ── Keybind grid ──
let listeningEl  = null;
let listeningIdx = null;

function buildKeybindGrid() {
  const grid = document.getElementById('keybindGrid');
  grid.innerHTML = '';
  keybinds.forEach((kb, i) => {
    const row = document.createElement('div');
    row.className = 'keybind-row';
    const lbl = document.createElement('span');
    lbl.className = 'keybind-label';
    lbl.textContent = kb.label;
    const inp = document.createElement('div');
    inp.className   = 'keybind-input';
    inp.tabIndex    = 0;
    inp.textContent = formatKey(kb.toKey);
    inp.dataset.idx = i;
    inp.addEventListener('click',   () => startListeningKeybind(inp, i));
    inp.addEventListener('keydown', (e) => { e.preventDefault(); e.stopPropagation(); if (listeningIdx === i) captureKey(e); });
    row.appendChild(lbl);
    row.appendChild(inp);
    grid.appendChild(row);
  });
}

function startListeningKeybind(el, idx) {
  if (listeningEl) listeningEl.classList.remove('listening');
  listeningEl  = el;
  listeningIdx = idx;
  el.classList.add('listening');
  el.textContent = '— press a key —';
  el.focus();
}
function stopListeningKeybind() {
  if (listeningEl) { listeningEl.classList.remove('listening'); listeningEl = null; listeningIdx = null; }
}
function captureKey(e) {
  if (listeningIdx === null) return;
  const key = e.code;
  if (key === 'Escape') { stopListeningKeybind(); buildKeybindGrid(); return; }
  keybinds[listeningIdx].toKey = key;
  saveSettingsToStorage();
  stopListeningKeybind();
  buildKeybindGrid();
  showToast(`Mapped to ${formatKey(key)}`);
}
function formatKey(code) {
  const map = { Space:'Space', ArrowUp:'↑', ArrowDown:'↓', ArrowLeft:'←', ArrowRight:'→', Enter:'Enter', Escape:'Esc', Backspace:'Bksp', ShiftLeft:'L-Shift', ShiftRight:'R-Shift', ControlLeft:'L-Ctrl', ControlRight:'R-Ctrl', AltLeft:'L-Alt', AltRight:'R-Alt' };
  if (map[code]) return map[code];
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  if (code.startsWith('Numpad')) return 'NP' + code.slice(6);
  return code;
}
function resetKeybinds() {
  keybinds = DEFAULT_KEYBINDS.map(k => ({ ...k }));
  saveSettingsToStorage();
  buildKeybindGrid();
  showToast('Keybinds reset to defaults');
}

// ── Key remapping interception ──
// We intercept keydown events on the Ruffle container and re-dispatch
// translated keys so the Flash game sees the original key it expects.
function setupKeyRemap() {
  document.addEventListener('keydown', handleKeyRemap, true);
  document.addEventListener('keyup',   handleKeyRemap, true);
}
function handleKeyRemap(e) {
  // Only intercept when a game is running
  if (!rufflePlayer) return;
  // Skip when typing in our own inputs
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || e.target.tagName === 'TEXTAREA') return;
  // Skip modifier-only keys
  if (['Control','Shift','Alt','Meta'].includes(e.key)) return;

  const mapping = keybinds.find(kb => kb.toKey === e.code && kb.toKey !== kb.fromKey);
  if (!mapping) return; // no remap needed

  e.preventDefault();
  e.stopImmediatePropagation();

  // Synthesize a new event with the fromKey the game expects
  const ruffleEl = rufflePlayer;
  if (!ruffleEl) return;
  const fakeEvt = new KeyboardEvent(e.type, {
    ...e,
    code:    mapping.fromKey,
    key:     codeToKey(mapping.fromKey),
    bubbles: true,
    cancelable: true,
  });
  ruffleEl.dispatchEvent(fakeEvt);
}
function codeToKey(code) {
  const m = { Space:' ', ArrowUp:'ArrowUp', ArrowDown:'ArrowDown', ArrowLeft:'ArrowLeft', ArrowRight:'ArrowRight', Enter:'Enter', Escape:'Escape', Backspace:'Backspace' };
  if (m[code]) return m[code];
  if (code.startsWith('Key')) return code.slice(3).toLowerCase();
  if (code.startsWith('Digit')) return code.slice(5);
  return code;
}
setupKeyRemap();

// ══════════════════════════════════════════════════
//  INDEXEDDB — cloud game cache + save states
// ══════════════════════════════════════════════════
const IDB_NAME       = 'flashback-v4';
const STORE_CACHE    = 'swf-blobs';
const STORE_SAVES    = 'save-states';
const STORE_ROMS     = 'roms';

function openIDB() {
  return new Promise((res, rej) => {
    const req = indexedDB.open(IDB_NAME, 3);
    req.onupgradeneeded = e => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE_CACHE)) db.createObjectStore(STORE_CACHE);
      if (!db.objectStoreNames.contains(STORE_SAVES)) db.createObjectStore(STORE_SAVES);
      if (!db.objectStoreNames.contains(STORE_ROMS))  db.createObjectStore(STORE_ROMS);
    };
    req.onsuccess = e => res(e.target.result);
    req.onerror   = () => rej(req.error);
  });
}
async function idbGet(store, key) {
  const db = await openIDB();
  return new Promise(res => {
    const req = db.transaction(store, 'readonly').objectStore(store).get(key);
    req.onsuccess = () => res(req.result ?? null);
    req.onerror   = () => res(null);
  });
}
async function idbSet(store, key, val) {
  const db = await openIDB();
  return new Promise((res, rej) => {
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).put(val, key);
    tx.oncomplete = res;
    tx.onerror    = () => rej(tx.error);
  });
}
async function idbDelete(store, key) {
  const db = await openIDB();
  return new Promise(res => {
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).delete(key);
    tx.oncomplete = res;
    tx.onerror    = res;
  });
}
async function idbGetAllKeys(store) {
  const db = await openIDB();
  return new Promise(res => {
    const req = db.transaction(store, 'readonly').objectStore(store).getAllKeys();
    req.onsuccess = () => res(req.result || []);
    req.onerror   = () => res([]);
  });
}
async function idbGetAll(store) {
  const db = await openIDB();
  return new Promise(res => {
    const req = db.transaction(store, 'readonly').objectStore(store).getAll();
    req.onsuccess = () => res(req.result || []);
    req.onerror   = () => res([]);
  });
}

// ══════════════════════════════════════════════════
//  SAVE STATES
// ══════════════════════════════════════════════════
// Each save state is stored in IDB as:
//   key: "saves:{gameKey}:{slotIndex}"   (4 slots per game)
//   value: { name, date, thumb (dataURL), gameKey }
//
// "Local save state" = screenshot thumbnail + metadata.
// Ruffle has no serialization API, so we can't truly save emulator RAM —
// instead this saves a screenshot + timestamp so you can quickly see
// where you were and restart from a manual in-game save if the game supports it.
// On "Load" we restart the game and show the screenshot as a reminder.

const MAX_SLOTS = 4;

function getSaveKey(gameKey, slot) { return `${gameKey}::${slot}`; }

async function captureScreenshot() {
  if (romPlayer) {
    try { return await romPlayer.screenshot(); } catch { return null; }
  }
  if (!rufflePlayer) return null;
  try {
    // Ruffle renders into a canvas inside its shadow DOM
    const canvas = rufflePlayer.shadowRoot?.querySelector('canvas');
    if (!canvas) return null;
    return new Promise(res => {
      canvas.toBlob(blob => {
        if (!blob) { res(null); return; }
        const reader = new FileReader();
        reader.onload = () => res(reader.result); // dataURL
        reader.onerror = () => res(null);
        reader.readAsDataURL(blob);
      }, 'image/jpeg', 0.7);
    });
  } catch { return null; }
}

function quickSave() {
  if ((!rufflePlayer && !romPlayer) || !currentGameKey) { showToast('No game running'); return; }
  document.getElementById('saveStateName').value = '';
  document.getElementById('saveNameModal').classList.add('open');
  setTimeout(() => document.getElementById('saveStateName').focus(), 50);
}
function closeSaveNameModal() {
  document.getElementById('saveNameModal').classList.remove('open');
}

async function confirmSave() {
  const nameVal = document.getElementById('saveStateName').value.trim() || 'Save State';
  closeSaveNameModal();

  // Find first empty slot, or overwrite oldest
  const slots = await loadAllSlots(currentGameKey);
  let targetSlot = slots.findIndex(s => !s);
  if (targetSlot === -1) targetSlot = 0; // overwrite slot 0 if all full

  const thumb = await captureScreenshot();
  // Console ROMs store the real emulator state — restore is instant, no restart.
  let emuState = null;
  if (romPlayer) { try { emuState = await romPlayer.saveState(); } catch (err) { console.warn('saveState failed', err); } }
  const state = {
    name:    nameVal,
    date:    new Date().toISOString(),
    thumb,
    gameKey: currentGameKey,
    slot:    targetSlot,
    emuState,
  };
  await idbSet(STORE_SAVES, getSaveKey(currentGameKey, targetSlot), state);
  renderSavesPanel();
  showToast(`Saved to slot ${targetSlot + 1}: "${nameVal}"`);
}

async function loadAllSlots(gameKey) {
  const slots = [];
  for (let i = 0; i < MAX_SLOTS; i++) {
    slots.push(await idbGet(STORE_SAVES, getSaveKey(gameKey, i)));
  }
  return slots;
}

async function renderSavesPanel() {
  const container = document.getElementById('savesContent');
  const nameEl    = document.getElementById('savesGameName');

  if (!currentGameKey) {
    container.innerHTML = '<div class="no-game-msg">Load a game first to manage save states.</div>';
    nameEl.style.display = 'none';
    return;
  }

  nameEl.textContent  = currentGameKey;
  nameEl.style.display = '';

  const slots = await loadAllSlots(currentGameKey);
  const grid  = document.createElement('div');
  grid.className = 'save-states-grid';

  for (let i = 0; i < MAX_SLOTS; i++) {
    const state = slots[i];
    const slot  = document.createElement('div');
    slot.className = 'save-slot' + (state ? ' occupied' : '');

    const thumbEl = document.createElement('div');
    thumbEl.className = 'slot-thumb';
    if (state?.thumb) {
      const img = document.createElement('img');
      img.src = state.thumb;
      thumbEl.appendChild(img);
    } else {
      thumbEl.innerHTML = `<span class="empty-slot-icon">+</span>`;
    }

    const infoEl = document.createElement('div');
    infoEl.className = 'slot-info';
    infoEl.innerHTML = `
      <div class="slot-name">${state ? esc(state.name) : `Slot ${i+1} — Empty`}</div>
      <div class="slot-date">${state ? new Date(state.date).toLocaleString() : '—'}</div>
    `;

    slot.appendChild(thumbEl);
    slot.appendChild(infoEl);

    if (state) {
      const actEl = document.createElement('div');
      actEl.className = 'slot-actions';
      const loadBtn = document.createElement('button');
      loadBtn.className   = 'slot-load-btn';
      loadBtn.textContent  = state.emuState ? '▶ Load' : '▶ Load (Restart)';
      loadBtn.onclick = () => loadSaveState(state);
      const delBtn = document.createElement('button');
      delBtn.className   = 'slot-del-btn';
      delBtn.textContent = '🗑';
      delBtn.title = 'Delete save';
      delBtn.onclick = () => deleteSaveState(currentGameKey, i);
      actEl.appendChild(loadBtn);
      actEl.appendChild(delBtn);
      slot.appendChild(actEl);
    } else {
      // Empty slot — click to save here directly
      thumbEl.style.cursor = 'pointer';
      thumbEl.title = 'Save to this slot';
      thumbEl.onclick = () => saveToSlot(i);
    }

    grid.appendChild(slot);
  }

  container.innerHTML = '';
  container.appendChild(grid);
}

async function saveToSlot(slot) {
  if ((!rufflePlayer && !romPlayer) || !currentGameKey) { showToast('No game running'); return; }
  const name  = `Save ${new Date().toLocaleTimeString()}`;
  const thumb = await captureScreenshot();
  let emuState = null;
  if (romPlayer) { try { emuState = await romPlayer.saveState(); } catch (err) { console.warn('saveState failed', err); } }
  const state = { name, date: new Date().toISOString(), thumb, gameKey: currentGameKey, slot, emuState };
  await idbSet(STORE_SAVES, getSaveKey(currentGameKey, slot), state);
  renderSavesPanel();
  showToast(`Saved to slot ${slot + 1}`);
}

async function loadSaveState(state) {
  // ROM with a captured emulator state → restore in place (no restart)
  if (romPlayer && state.emuState) {
    try {
      await romPlayer.loadState(state.emuState);
      showToast(`Loaded: "${state.name}"`);
      return;
    } catch (err) { showToast('State restore failed — restarting instead'); console.warn(err); }
  }
  // Flash games (and ROMs without state bytes) → restart, screenshot as reminder
  showToast(`Loading save: "${state.name}" — game restarting…`);
  if (currentRom?.kind === 'local')       await playRom(currentRom.rec.id);
  else if (currentRom?.kind === 'cloud')  await playCloud(currentRom.game);
  else if (currentCloudGame)              await playCloud(currentCloudGame);
  else if (currentGameIdx !== -1)         await loadGame(currentGameIdx);
}

async function deleteSaveState(gameKey, slot) {
  await idbDelete(STORE_SAVES, getSaveKey(gameKey, slot));
  renderSavesPanel();
  showToast('Save state deleted');
}

// ══════════════════════════════════════════════════
//  CLOUD CACHE helpers
// ══════════════════════════════════════════════════
async function refreshCacheSet() {
  const keys = await idbGetAllKeys(STORE_CACHE);
  cachedGameIds = new Set(keys);
  document.getElementById('cacheCount').textContent = cachedGameIds.size;
}
refreshCacheSet();

async function clearAllCache() {
  const db = await openIDB();
  await new Promise(res => { const tx = db.transaction(STORE_CACHE,'readwrite'); tx.objectStore(STORE_CACHE).clear(); tx.oncomplete = res; });
  cachedGameIds.clear();
  document.getElementById('cacheCount').textContent = 0;
  renderCloudList();
  showToast('Cloud game cache cleared');
}

// ══════════════════════════════════════════════════
//  VIEW MANAGEMENT
// ══════════════════════════════════════════════════
function showView(name) {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.getElementById('view-' + name)?.classList.add('active');
  if (name === 'admin') loadAdminUsers();
}

// ══════════════════════════════════════════════════
//  AUTH (local backend, session cookie)
// ══════════════════════════════════════════════════
onAuthStateChanged(user => {
  if (!user) { currentUserDoc = null; showView('auth'); return; }
  currentUserDoc = user;
  if      (user.status === 'pending')                                showView('pending');
  else if (user.status === 'revoked' || user.status === 'rejected')  showView('revoked');
  else if (user.status === 'approved') {
    document.getElementById('hdr-username').textContent = user.username || user.email;
    document.getElementById('admin-btn').style.display  = user.role === 'admin' ? '' : 'none';
    document.getElementById('shareRow').classList.toggle('banned', !!user.cloud_banned);
    if (user.cloud_banned) document.getElementById('shareToggle').checked = false;
    showView('app');
  }
});

async function handleLogin(e) {
  e.preventDefault();
  const errEl = document.getElementById('login-error');
  errEl.classList.remove('show');
  try {
    await authApi.login(
      document.getElementById('login-email').value,
      document.getElementById('login-pwd').value,
      document.getElementById('remember-me').checked
    );
  } catch (err) { errEl.textContent = err.message; errEl.classList.add('show'); }
}

async function handleRegister(e) {
  e.preventDefault();
  const errEl = document.getElementById('reg-error');
  errEl.classList.remove('show');
  const username = document.getElementById('reg-username').value.trim();
  const email    = document.getElementById('reg-email').value.trim();
  const password = document.getElementById('reg-pwd').value;
  try {
    await authApi.register(username, email, password);
    await authApi.login(email, password, true);
    showToast('Account created — welcome!');
  } catch (err) { errEl.textContent = err.message; errEl.classList.add('show'); }
}

async function handleSignOut() {
  try { await authApi.logout(); } catch {}
  currentUserDoc = null;
  showView('auth');
}

function switchAuthTab(tab) {
  document.querySelectorAll('.auth-tab').forEach((t,i) => t.classList.toggle('active', i === (tab==='login'?0:1)));
  document.getElementById('form-login').style.display    = tab==='login'    ? 'flex':'none';
  document.getElementById('form-register').style.display = tab==='register' ? 'flex':'none';
  document.getElementById('login-error').classList.remove('show');
  document.getElementById('reg-error').classList.remove('show');
}

// ══════════════════════════════════════════════════
//  SIDEBAR
// ══════════════════════════════════════════════════
function switchSidebarTab(tab) {
  document.querySelectorAll('.sidebar-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
  ['local','saves','cloud','roms'].forEach(p => document.getElementById('panel-'+p).classList.toggle('active', p === tab));
  if (tab === 'cloud') loadCloudLibrary();
  if (tab === 'saves') renderSavesPanel();
  if (tab === 'roms')  renderRomList();
}

// ══════════════════════════════════════════════════
//  SWF DIMENSION DETECTION
// ══════════════════════════════════════════════════
async function getSWFDims(file) {
  try {
    const bytes = new Uint8Array(await file.slice(0, 64).arrayBuffer());
    if (String.fromCharCode(bytes[0],bytes[1],bytes[2]) !== 'FWS') return null;
    let bi = 8, buf = bytes[8], left = 8;
    function rBits(n) { let r=0; while(n>0){if(left===0){buf=bytes[++bi];left=8;} const t=Math.min(n,left); r=(r<<t)|((buf>>(left-t))&((1<<t)-1)); left-=t; n-=t;} return r; }
    function rSBits(n){ const v=rBits(n); return v&(1<<(n-1))?v-(1<<n):v; }
    const nb=rBits(5); if(!nb||nb>31) return null;
    const xmin=rSBits(nb),xmax=rSBits(nb),ymin=rSBits(nb),ymax=rSBits(nb);
    const w=Math.round((xmax-xmin)/20), h=Math.round((ymax-ymin)/20);
    return (w>0&&h>0&&w<10000&&h<10000) ? {width:w,height:h} : null;
  } catch { return null; }
}
async function waitForRuffleMeta(player, ms=7000) {
  const t0=Date.now();
  while(Date.now()-t0<ms) { if(player.metadata?.width&&player.metadata?.height) return player.metadata; await new Promise(r=>setTimeout(r,300)); }
  return null;
}
function applyDims(dims) {
  if (!dims?.width || !dims?.height) return;
  document.getElementById('ruffleWrap').style.aspectRatio = `${dims.width} / ${dims.height}`;
  document.getElementById('dimInfo').textContent = `${dims.width} × ${dims.height}px`;
}

// ══════════════════════════════════════════════════
//  FILE HANDLING
// ══════════════════════════════════════════════════
const uploadZone = document.getElementById('uploadZone');
const fileInput  = document.getElementById('fileInput');
uploadZone.addEventListener('dragover', e => { e.preventDefault(); uploadZone.classList.add('drag-over'); });
uploadZone.addEventListener('dragleave', () => uploadZone.classList.remove('drag-over'));
uploadZone.addEventListener('drop', e => { e.preventDefault(); uploadZone.classList.remove('drag-over'); handleFiles([...e.dataTransfer.files]); });
fileInput.addEventListener('change', e => { handleFiles([...e.target.files]); fileInput.value = ''; });

// ROM drop zone (same router — files are dispatched by extension)
const romUploadZone = document.getElementById('romUploadZone');
const romFileInput  = document.getElementById('romFileInput');
romUploadZone.addEventListener('dragover', e => { e.preventDefault(); romUploadZone.classList.add('drag-over'); });
romUploadZone.addEventListener('dragleave', () => romUploadZone.classList.remove('drag-over'));
romUploadZone.addEventListener('drop', e => { e.preventDefault(); romUploadZone.classList.remove('drag-over'); handleFiles([...e.dataTransfer.files]); });
romFileInput.addEventListener('change', e => { handleFiles([...e.target.files]); romFileInput.value = ''; });

async function handleFiles(files) {
  const shareFlash = document.getElementById('shareToggle').checked && !currentUserDoc?.cloud_banned;
  const shareRoms  = document.getElementById('romShareToggle').checked && !currentUserDoc?.cloud_banned;
  for (const file of files) {
    const name = file.name.toLowerCase();
    if (romUtils.isRomFile(name))          await addRom(file, shareRoms);
    else if (name.endsWith('.swf'))         addSWF(file, shareFlash);
    else if (name.endsWith('.zip'))         await processZip(file, shareFlash, shareRoms);
    else showToast(`Unsupported: "${file.name}" — use .swf, .zip, or a console ROM (.nes/.sfc/.gb/.md…)`);
  }
}

function addSWF(file, share) {
  if (games.find(g => g.name === file.name)) { showToast(`"${file.name}" already loaded`); return; }
  games.push({ name: file.name, size: file.size, url: URL.createObjectURL(file), file });
  renderLibrary();
  if (currentGameIdx === -1) loadGame(games.length - 1);
  if (share) uploadToCloud(file).catch(err => showToast('Cloud upload failed: ' + err.message));
}

async function processZip(zipFile, share, shareRoms) {
  showToast(`Unpacking "${zipFile.name}"…`);
  try {
    const zip = await JSZip.loadAsync(zipFile);
    const swfs = [], roms = [];
    const promises = [];
    zip.forEach((path, entry) => {
      if (entry.dir) return;
      const low = path.toLowerCase();
      const base = path.split('/').pop();
      if (low.endsWith('.swf')) {
        promises.push(entry.async('arraybuffer').then(buf => swfs.push(new File([buf], base, {type:'application/x-shockwave-flash'}))));
      } else if (romUtils.isRomFile(low)) {
        promises.push(entry.async('arraybuffer').then(buf => roms.push(new File([buf], base))));
      }
    });
    await Promise.all(promises);
    if (!swfs.length && !roms.length) { showToast(`No playable files found in "${zipFile.name}"`); return; }
    let added = 0;
    for (const f of swfs) {
      if (!games.find(g => g.name === f.name)) {
        games.push({ name: f.name, size: f.size, url: URL.createObjectURL(f), file: f });
        added++;
        if (share) uploadToCloud(f).catch(() => {});
      }
    }
    for (const f of roms) {
      const ok = await addRom(f, shareRoms, /*silent*/ true);
      if (ok) added++;
    }
    renderLibrary();
    showToast(`${added} file(s) added from "${zipFile.name}"`);
    if (currentGameIdx === -1 && added) loadGame(games.length - added);
  } catch (err) { showToast(`ZIP error: ${err.message}`); }
}

// ══════════════════════════════════════════════════
//  ROM LIBRARY (local IndexedDB) + ROM PLAYER
// ══════════════════════════════════════════════════
async function refreshRomList(silent) {
  try {
    romList = (await idbGetAll(STORE_ROMS)) || [];
  } catch { romList = []; }
  romList.sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));
  const el = document.getElementById('romCount');
  if (el) el.textContent = romList.length;
  if (!silent) renderRomList();
}
refreshRomList(true);

function renderRomList() {
  const list  = document.getElementById('romList');
  const empty = document.getElementById('emptyRoms');
  if (!list) return;
  if (!romList.length) {
    list.innerHTML = '';
    if (empty) empty.style.display = '';
    list.appendChild(empty || document.createTextNode(''));
    return;
  }
  if (empty) empty.style.display = 'none';
  list.querySelectorAll('.game-item').forEach(el => el.remove());
  const canShare = !currentUserDoc?.cloud_banned && currentUserDoc?.status === 'approved';
  romList.forEach(rec => {
    const active = currentRom?.kind === 'local' && currentRom.rec?.id === rec.id;
    const item = document.createElement('div');
    item.className = 'game-item' + (active ? ' active' : '');
    const label = (rec.name || '').replace(/\.[^.]+$/, '');
    item.innerHTML = `
      <div class="g-icon">🎮</div>
      <div class="g-info">
        <div class="g-name" title="${esc(rec.name)}">${esc(label)}</div>
        <div class="g-meta"><span class="sys-tag sys-${rec.system}">${romUtils.systemLabel(rec.system)}</span> ${fmt(rec.size)}${rec.clouded ? ' <span class="cache-tag">☁</span>' : ''}</div>
      </div>
      <div class="cloud-actions">
        ${canShare && !rec.clouded ? `<button class="rm-btn" title="Upload to cloud" onclick="uploadRomToCloud(event,'${rec.id}')">☁</button>` : ''}
        <button class="rm-btn" title="Remove" onclick="removeRom(event,'${rec.id}')">✕</button>
      </div>
    `;
    item.addEventListener('click', e => { if (e.target.classList.contains('rm-btn')) return; playRom(rec.id); });
    list.appendChild(item);
  });
}

async function addRom(file, share, silent) {
  const system = romUtils.detectSystem(file.name);
  if (!system) {
    if (!silent) showToast(`"${file.name}" isn't a supported ROM format`);
    return false;
  }
  if (romList.find(r => r.name === file.name && r.size === file.size)) {
    if (!silent) showToast(`"${file.name}" already in your ROM library`);
    return false;
  }
  const rec = {
    id:      (crypto.randomUUID ? crypto.randomUUID() : 'rom-' + Date.now() + '-' + Math.random().toString(36).slice(2)),
    name:    file.name,
    system,
    size:    file.size,
    addedAt: Date.now(),
    clouded: false,
    blob:    file,
  };
  try {
    await idbSet(STORE_ROMS, rec.id, rec);
  } catch (err) {
    if (!silent) showToast('Could not store ROM (storage full?): ' + err.message);
    return false;
  }
  await refreshRomList(true);
  renderRomList();
  if (!silent) showToast(`"${file.name}" added — ${romUtils.systemLabel(system)}`);
  if (share) uploadRomToCloud(null, rec.id).catch(err => showToast('Cloud upload failed: ' + err.message));
  return true;
}

async function removeRom(e, id) {
  if (e) e.stopPropagation();
  if (currentRom?.kind === 'local' && currentRom.rec?.id === id) await stopGame();
  await idbDelete(STORE_ROMS, id);
  await refreshRomList();
  showToast('ROM removed');
}

async function uploadRomToCloud(e, id) {
  if (e) e.stopPropagation();
  const rec = romList.find(r => r.id === id);
  if (!rec) return;
  if (!currentUserDoc || currentUserDoc.cloud_banned) { showToast('Cloud sharing unavailable'); return; }
  await uploadToCloud(rec.blob);
  rec.clouded = true;
  await idbSet(STORE_ROMS, rec.id, rec);
  renderRomList();
}

// Play a ROM from the local library.
async function playRom(id) {
  const rec = romList.find(r => r.id === id);
  if (!rec || !rec.blob) { showToast('ROM data missing — re-import the file'); return; }
  currentRom  = { kind: 'local', rec };
  currentGameIdx = -1; currentCloudGame = null;
  renderLibrary(); renderCloudList(); renderRomList();
  await launchRom({
    system: rec.system,
    name:   rec.name,
    size:   rec.size,
    file:   rec.blob,
    key:    rec.name.replace(/\.[^.]+$/, ''),
  });
}

// Shared ROM launch path (local files and cloud games).
async function launchRom({ system, name, size, file, url, key }) {
  document.getElementById('emptyState').style.display = 'none';
  document.getElementById('playerWrap').style.display = '';
  document.getElementById('gameTitle').textContent    = name.replace(/\.[^.]+$/, '');
  document.getElementById('fileInfo').textContent     = fmt(size);
  document.getElementById('dimInfo').textContent      = romUtils.systemLabel(system);
  document.getElementById('ruffleWrap').style.aspectRatio = romUtils.systemAspect(system);
  isPaused = false;
  document.getElementById('pauseBtn').textContent = '❚❚ Pause';
  document.getElementById('sDot').className = 's-dot';
  document.getElementById('sText').textContent = 'LOADING…';

  currentGameKey = key || name.replace(/\.[^.]+$/, '');
  renderSavesPanel();

  const wrap = document.getElementById('ruffleWrap');
  if (rufflePlayer)   { try { rufflePlayer.remove(); } catch {} rufflePlayer = null; }
  if (romPlayer)       { romPlayer.stop(); romPlayer = null; }
  wrap.innerHTML = '';

  const player = new RomPlayer(wrap);
  romPlayer = player;
  player.on('status', d => {
    if (romPlayer !== player) return;   // stale instance
    if (d.status === 'running') {
      document.getElementById('sDot').className = 's-dot on';
      document.getElementById('sText').textContent = 'RUNNING';
    } else if (d.status === 'error') {
      document.getElementById('sDot').className = 's-dot';
      document.getElementById('sText').textContent = 'ERROR';
      if (d.message) showToast('Emulator error: ' + d.message);
    }
  });

  try {
    await player.load({ system, name, file, url });
  } catch (err) {
    if (romPlayer === player) {
      document.getElementById('sText').textContent = 'ERROR';
      showToast('Could not start emulator: ' + err.message);
    }
  }
}

// ══════════════════════════════════════════════════
//  CLOUD UPLOAD (local backend)
// ══════════════════════════════════════════════════
async function uploadToCloud(file) {
  if (!currentUserDoc || currentUserDoc.cloud_banned) return;
  const prog = document.getElementById('uploadProg');
  const bar  = document.getElementById('uploadProgBar');
  const lbl  = document.getElementById('progLabel');
  prog.classList.add('show'); lbl.textContent = `☁ Uploading "${file.name}"…`; lbl.classList.add('show');
  bar.style.width = '50%';
  try {
    await cloudApi.upload(file, file.name.replace(/\.[^.]+$/, ''));
    bar.style.width = '100%';
    showToast(`"${file.name}" shared ☁`);
    cloudLibraryLoaded = false; // force refresh next time Cloud tab opens
  } finally {
    setTimeout(() => {
      prog.classList.remove('show'); lbl.classList.remove('show'); bar.style.width = '0%';
    }, 400);
  }
}

// ══════════════════════════════════════════════════
//  CLOUD LIBRARY (local backend)
// ══════════════════════════════════════════════════
let cloudPollTimer = null;

async function loadCloudLibrary() {
  const listEl  = document.getElementById('cloudList');
  const loadEl  = document.getElementById('cloudLoading');
  loadEl.style.display=''; listEl.style.display='none'; listEl.innerHTML='';
  try {
    cloudCache = await cloudApi.list();
    document.getElementById('cloudCount').textContent = cloudCache.length;
    await refreshCacheSet();
    cloudLibraryLoaded = true;
    renderCloudList();
    loadEl.style.display='none'; listEl.style.display='';
    // Poll every 10s while the app is open (replaces Firestore realtime)
    if (!cloudPollTimer) cloudPollTimer = setInterval(refreshCloudLibrary, 10000);
  } catch (err) { loadEl.textContent='Error loading cloud library.'; console.error(err); }
}

async function refreshCloudLibrary() {
  if (!currentUserDoc || currentUserDoc.status !== 'approved') return;
  try {
    cloudCache = await cloudApi.list();
    document.getElementById('cloudCount').textContent = cloudCache.length;
    if (cloudLibraryLoaded) renderCloudList();
  } catch {}
}

function setCloudFilter(s) {
  cloudSystemFilter = s;
  document.querySelectorAll('#cloudFilterBar .filter-btn').forEach(b => b.classList.toggle('active', b.dataset.s === s));
  renderCloudList();
}

function renderCloudList() {
  if (!cloudLibraryLoaded) return;  // don't render until library has been fetched
  const listEl  = document.getElementById('cloudList');
  listEl.innerHTML = '';
  const isAdmin = currentUserDoc?.role === 'admin';
  const games = cloudCache.filter(g => cloudSystemFilter === 'all' || (g.system || 'flash') === cloudSystemFilter);
  if (!cloudCache.length) { listEl.innerHTML='<div class="empty-lib">No cloud games yet.<br/>Upload with "Share to Cloud" on.</div>'; return; }
  if (!games.length) { listEl.innerHTML=`<div class="empty-lib">No ${cloudSystemFilter === 'flash' ? 'Flash' : romUtils.systemLabel(cloudSystemFilter)} games in the cloud.</div>`; return; }
  games.forEach(game => {
    const sys      = game.system || 'flash';
    const isActive = (currentCloudGame?.id === game.id) || (currentRom?.kind === 'cloud' && currentRom.game?.id === game.id);
    const isCached  = cachedGameIds.has(game.id);
    const canDelete = isAdmin || game.uploadedBy === currentUserDoc?.uid;
    const item = document.createElement('div');
    item.className = 'cloud-item' + (isActive ? ' active' : '');
    item.innerHTML = `
      <div class="g-icon">${sys === 'flash' ? emoji(game.name) : '🎮'}</div>
      <div class="g-info">
        <div class="g-name" title="${esc(game.displayName)}">${esc(game.displayName)}</div>
        <div class="g-meta"><span class="sys-tag sys-${sys}">${sys === 'flash' ? 'SWF' : romUtils.systemLabel(sys)}</span> ${fmt(game.size)} · ▶ ${game.playCount||0} ${isCached?'<span class="cache-tag">💾</span>':'<span class="cloud-tag">☁</span>'}</div>
      </div>
      <div class="cloud-actions">
        ${isCached?`<button class="rm-btn" title="Clear from cache" onclick="evictCache(event,'${game.id}')">🗑</button>`:''}
        ${canDelete?`<button class="rm-btn" title="Delete from cloud" onclick="openDeleteCloudModal(event,'${game.id}','${esc(game.storagePath||'')}','${esc(game.uploadedBy||'')}','${esc(game.uploadedByName||'')}')">✕</button>`:''}
      </div>
    `;
    item.addEventListener('click', e => { if (e.target.classList.contains('rm-btn')) return; playCloud(game); });
    listEl.appendChild(item);
  });
}

async function evictCache(e, gameId) {
  e.stopPropagation();
  await idbDelete(STORE_CACHE, gameId);
  cachedGameIds.delete(gameId);
  document.getElementById('cacheCount').textContent = cachedGameIds.size;
  renderCloudList(); showToast('Removed from cache');
}

// Resolve a cloud game's bytes: IndexedDB cache first, else fetch & cache.
async function getCloudBlob(game) {
  const cached = await idbGet(STORE_CACHE, game.id);
  if (cached) return cached;
  showToast('⟳ Fetching from cloud…');
  const blob = await fetch(game.storageUrl).then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.blob(); });
  await idbSet(STORE_CACHE, game.id, blob);
  cachedGameIds.add(game.id);
  document.getElementById('cacheCount').textContent = cachedGameIds.size;
  renderCloudList();
  return blob;
}

async function playCloud(game) {
  const system = game.system || 'flash';
  currentCloudGame = game; currentGameIdx = -1;
  renderLibrary(); renderCloudList();
  cloudApi.play(game.id).catch(()=>{});
  if (system === 'flash') {
    currentRom = null; renderRomList();
    await launchRuffle({url:null, cloudGame:game, name:game.displayName, size:game.size, file:null});
    return;
  }
  // Console ROM → RomPlayer (cache-first, URL stream as fallback)
  currentRom = { kind: 'cloud', game };
  renderRomList();
  let file = null, url = null;
  try { file = await getCloudBlob(game); }
  catch (err) { url = game.storageUrl; showToast('Cache failed — streaming directly'); }
  await launchRom({
    system,
    name:   game.name || (game.displayName + ''),
    size:   game.size,
    file, url,
    key:    game.displayName || game.name || game.id,
  });
}

function openDeleteCloudModal(e, gameId, storagePath, uploaderUid, uploaderName) {
  e.stopPropagation();
  pendingDeleteCloudId=gameId; pendingDeleteCloudPath=storagePath; pendingDeleteUploaderUid=uploaderUid;
  document.getElementById('dcm-sub').textContent = `Uploader: ${uploaderName||uploaderUid}`;
  document.getElementById('dcm-uploader-label').textContent = `"${uploaderName||uploaderUid}" will no longer be able to share files.`;
  document.getElementById('dcm-ban').checked = false;
  document.getElementById('dcm-ban').parentElement.style.display = (uploaderUid===currentUserDoc?.uid) ? 'none':'';
  document.getElementById('deleteCloudModal').classList.add('open');
}
function closeDeleteCloudModal() { document.getElementById('deleteCloudModal').classList.remove('open'); pendingDeleteCloudId=null; pendingDeleteCloudPath=null; pendingDeleteUploaderUid=null; }
async function confirmDeleteCloud() {
  if (!pendingDeleteCloudId) return;
  const banUser = document.getElementById('dcm-ban').checked;
  const gid = pendingDeleteCloudId, uploaderUid = pendingDeleteUploaderUid;
  closeDeleteCloudModal();
  try {
    await cloudApi.delete(gid);
    await idbDelete(STORE_CACHE, gid);
    cachedGameIds.delete(gid);
    if (banUser && uploaderUid) { await adminApi.cloudBan(uploaderUid, true); showToast('Game deleted + uploader banned'); }
    else showToast('Cloud game deleted');
    if (currentCloudGame?.id===gid || (currentRom?.kind==='cloud' && currentRom.game?.id===gid)) stopGame();
    cloudCache = cloudCache.filter(g=>g.id!==gid);
    document.getElementById('cloudCount').textContent = cloudCache.length;
    document.getElementById('cacheCount').textContent = cachedGameIds.size;
    cloudLibraryLoaded = true;
    renderCloudList();
  } catch (err) { showToast('Delete failed: '+err.message); }
}

// ══════════════════════════════════════════════════
//  LOCAL LIBRARY
// ══════════════════════════════════════════════════
function renderLibrary() {
  const list  = document.getElementById('gameList');
  const empty = document.getElementById('emptyLib');
  document.getElementById('gameCount').textContent = games.length;
  list.querySelectorAll('.game-item').forEach(el => el.remove());
  if (!games.length) { empty.style.display=''; return; }
  empty.style.display = 'none';
  games.forEach((game, i) => {
    const item = document.createElement('div');
    item.className = 'game-item' + (i===currentGameIdx?' active':'');
    item.innerHTML = `
      <div class="g-icon">${emoji(game.name)}</div>
      <div class="g-info">
        <div class="g-name" title="${esc(game.name)}">${esc(game.name.replace(/\.swf$/i,''))}</div>
        <div class="g-meta">${fmt(game.size)}</div>
      </div>
      <button class="rm-btn" onclick="removeGame(event,${i})" title="Remove">✕</button>
    `;
    item.addEventListener('click', e => { if (!e.target.classList.contains('rm-btn')) loadGame(i); });
    list.appendChild(item);
  });
}

// ══════════════════════════════════════════════════
//  PLAYER
// ══════════════════════════════════════════════════
async function loadGame(idx) {
  const game = games[idx];
  if (!game) return;
  currentGameIdx=idx; currentCloudGame=null;
  renderLibrary(); renderCloudList();
  await launchRuffle({url:game.url, cloudGame:null, name:game.name.replace(/\.swf$/i,''), size:game.size, file:game.file});
}

// Build Ruffle load options from current performance settings
function buildRuffleOptions(url) {
  const opts = { url, autoplay: 'on', unmuteOverlay: 'hidden' };
  if (perfSettings.renderer)  opts.preferredRenderer = perfSettings.renderer;
  if (perfSettings.quality)   opts.quality           = perfSettings.quality;
  if (perfSettings.frameRate) opts.frameRate         = parseFloat(perfSettings.frameRate);
  if (perfSettings.maxExec) {
    const secs = parseFloat(perfSettings.maxExec);
    opts.maxExecutionDuration = secs === 0 ? { secs: 999999, nanos: 0 } : { secs, nanos: 0 };
  }
  return opts;
}

async function launchRuffle({ url, cloudGame, name, size, file }) {
  document.getElementById('emptyState').style.display = 'none';
  document.getElementById('playerWrap').style.display = '';
  document.getElementById('gameTitle').textContent    = name;
  document.getElementById('fileInfo').textContent     = fmt(size);
  document.getElementById('dimInfo').textContent      = '…';
  document.getElementById('ruffleWrap').style.aspectRatio = '4 / 3';
  isPaused = false;
  document.getElementById('pauseBtn').textContent = '❚❚ Pause';

  // Set stable key for save states
  currentGameKey = name;
  renderSavesPanel();

  const wrap = document.getElementById('ruffleWrap');
  if (rufflePlayer) { try { rufflePlayer.remove(); } catch {} rufflePlayer = null; }
  if (romPlayer) { romPlayer.stop(); romPlayer = null; currentRom = null; renderRomList(); }
  wrap.innerHTML = '';

  let finalUrl = url;
  if (cloudGame) {
    const cached = await idbGet(STORE_CACHE, cloudGame.id);
    if (cached) { finalUrl = URL.createObjectURL(cached); showToast('▶ Playing from cache 💾'); }
    else {
      showToast('⟳ Fetching from cloud…');
      try {
        const blob = await fetch(cloudGame.storageUrl).then(r => r.blob());
        await idbSet(STORE_CACHE, cloudGame.id, blob);
        cachedGameIds.add(cloudGame.id);
        document.getElementById('cacheCount').textContent = cachedGameIds.size;
        finalUrl = URL.createObjectURL(blob);
        renderCloudList();
      } catch { finalUrl = cloudGame.storageUrl; showToast('Cache failed — streaming directly'); }
    }
  }

  try {
    const ruffle = getRuffle();
    if (!ruffle) throw new Error('Ruffle is still initializing — try again in a moment.');
    const player = ruffle.createPlayer();
    player.style.width = '100%'; player.style.height = '100%';
    wrap.appendChild(player);
    rufflePlayer = player;
    player.load(buildRuffleOptions(finalUrl));
    document.getElementById('sDot').className    = 's-dot on';
    document.getElementById('sText').textContent = 'RUNNING';

    // Detect native game dimensions
    const dims = file ? (await getSWFDims(file)) : null;
    applyDims(dims || await waitForRuffleMeta(player));
  } catch (err) {
    showToast('Error: ' + err.message);
    document.getElementById('sText').textContent = 'ERROR';
  }
}

function togglePause() {
  if (romPlayer) {
    isPaused = !isPaused;
    (isPaused ? romPlayer.pause() : romPlayer.resume()).catch(err => {
      isPaused = !isPaused;
      showToast('Pause unavailable: ' + err.message);
    });
    document.getElementById('pauseBtn').textContent = isPaused ? '▶ Play' : '❚❚ Pause';
    document.getElementById('sDot').className = isPaused ? 's-dot' : 's-dot on';
    document.getElementById('sText').textContent = isPaused ? 'PAUSED' : 'RUNNING';
    return;
  }
  if (!rufflePlayer) return;
  if (isPaused) {
    try { rufflePlayer.resume(); } catch {}
    isPaused=false;
    document.getElementById('pauseBtn').textContent='❚❚ Pause';
    document.getElementById('sDot').className='s-dot on';
    document.getElementById('sText').textContent='RUNNING';
  } else {
    try { rufflePlayer.suspend(); } catch {}
    isPaused=true;
    document.getElementById('pauseBtn').textContent='▶ Play';
    document.getElementById('sDot').className='s-dot';
    document.getElementById('sText').textContent='PAUSED';
  }
}

function restartGame() {
  if (currentRom?.kind === 'local')  playRom(currentRom.rec.id);
  else if (currentRom?.kind === 'cloud') playCloud(currentRom.game);
  else if (currentCloudGame)          playCloud(currentCloudGame);
  else if (currentGameIdx !== -1)     loadGame(currentGameIdx);
}
function stopGame() {
  if (rufflePlayer) { try { rufflePlayer.remove(); } catch {} rufflePlayer = null; }
  if (romPlayer) { romPlayer.stop(); romPlayer = null; }
  currentGameIdx=-1; currentCloudGame=null; currentRom=null; isPaused=false; currentGameKey=null;
  document.getElementById('pauseBtn').textContent='❚❚ Pause';
  document.getElementById('sDot').className='s-dot'; document.getElementById('sText').textContent='STOPPED';
  document.getElementById('emptyState').style.display='';
  document.getElementById('playerWrap').style.display='none';
  renderLibrary(); renderCloudList(); renderRomList(); renderSavesPanel();
}
function removeGame(e, i) {
  e.stopPropagation();
  URL.revokeObjectURL(games[i].url);
  if (currentGameIdx===i) stopGame();
  games.splice(i,1);
  if (currentGameIdx>i) currentGameIdx--;
  renderLibrary();
  showToast('Game removed');
}
function toggleFullscreen() {
  const wrap = document.getElementById('ruffleWrap');
  document.fullscreenElement ? document.exitFullscreen?.() : wrap.requestFullscreen?.();
}
document.addEventListener('keydown', e => { if (e.key==='f' && document.activeElement.tagName!=='INPUT') toggleFullscreen(); });

// ══════════════════════════════════════════════════
//  ADMIN
// ══════════════════════════════════════════════════
async function loadAdminUsers() {
  const tbody = document.getElementById('usersTbody');
  tbody.innerHTML='<tr><td colspan="5" style="text-align:center;color:var(--muted);padding:24px;font-size:0.62rem;">Loading…</td></tr>';
  try {
    allUsers = await adminApi.listUsers();
    renderUsersTable();
  } catch (err) { tbody.innerHTML=`<tr><td colspan="5" style="color:var(--accent);padding:16px;font-size:0.62rem;">Error: ${esc(err.message)}</td></tr>`; }
}
function filterUsers(f) {
  activeFilter=f;
  document.querySelectorAll('#view-admin .filter-btn').forEach(b=>b.classList.toggle('active',b.dataset.f===f));
  renderUsersTable();
}
function renderUsersTable() {
  const tbody   = document.getElementById('usersTbody');
  const visible = activeFilter==='all' ? allUsers : allUsers.filter(u=>u.status===activeFilter);
  tbody.innerHTML='';
  if (!visible.length) { tbody.innerHTML='<tr><td colspan="5" style="text-align:center;color:var(--muted);padding:24px;font-size:0.62rem;">No users found.</td></tr>'; return; }
  visible.forEach(u => {
    let date = '—';
    try { if (u.createdAt) date = new Date(u.createdAt).toLocaleDateString(); } catch {}
    const isSelf = u.uid===currentUserDoc?.uid;
    const tr = document.createElement('tr');
    tr.innerHTML=`
      <td><div class="u-name">${esc(u.username||'—')}${isSelf?' <span style="color:var(--muted);font-size:0.48rem;">(you)</span>':''}</div><div class="u-email">${esc(u.email||'—')}</div></td>
      <td><span class="tag t-${u.status}">${u.status}</span>${u.cloudBanned?'<span class="tag t-cloudbanned">☁ banned</span>':''}</td>
      <td><span class="tag t-${u.role}">${u.role}</span></td>
      <td style="font-size:0.57rem;color:var(--muted);">${date}</td>
      <td><div class="act-cell">
        ${u.status==='pending'?`<button class="btn btn-success btn-xs" onclick="setStatus('${u.uid}','approved')">✓ Approve</button><button class="btn btn-danger btn-xs" onclick="setStatus('${u.uid}','rejected')">✕ Reject</button>`:''}
        ${u.status==='approved'?`<button class="btn btn-warn btn-xs" onclick="setStatus('${u.uid}','revoked')">⊘ Revoke</button>`:''}
        ${(u.status==='revoked'||u.status==='rejected')?`<button class="btn btn-success btn-xs" onclick="setStatus('${u.uid}','approved')">↺ Restore</button>`:''}
        ${u.cloudBanned?`<button class="btn btn-success btn-xs" onclick="setCloudBan('${u.uid}',false)">☁ Unban</button>`:`<button class="btn btn-warn btn-xs" onclick="setCloudBan('${u.uid}',true)">☁ Ban</button>`}
        <button class="btn btn-ghost btn-xs" onclick="openEdit('${u.uid}')">✎ Edit</button>
        ${!isSelf?`<button class="btn btn-danger btn-xs" onclick="confirmDeleteUser('${u.uid}')">🗑</button>`:''}
      </div></td>
    `;
    tbody.appendChild(tr);
  });
}
async function setStatus(uid,status) {
  try { await adminApi.updateStatus(uid, status); const idx=allUsers.findIndex(u=>u.uid===uid); if(idx!==-1) allUsers[idx].status=status; renderUsersTable(); showToast(`Status → ${status}`); } catch(err){showToast('Error: '+err.message);}
}
async function setCloudBan(uid,banned) {
  try { await adminApi.cloudBan(uid, banned); const idx=allUsers.findIndex(u=>u.uid===uid); if(idx!==-1) allUsers[idx].cloudBanned=banned; renderUsersTable(); showToast(banned?'Cloud ban applied':'Cloud ban lifted'); } catch(err){showToast('Error: '+err.message);}
}
function openEdit(uid) {
  const u=allUsers.find(x=>x.uid===uid); if(!u) return;
  editingUid=uid;
  document.getElementById('editModalSub').textContent=`UID: ${uid}`;
  document.getElementById('eu-username').value=u.username||'';
  document.getElementById('eu-email').value=u.email||'';
  document.getElementById('eu-status').value=u.status||'pending';
  document.getElementById('eu-role').value=u.role||'user';
  document.getElementById('eu-cloudbanned').checked=!!u.cloudBanned;
  document.getElementById('editModal').classList.add('open');
}
function closeEditModal() { document.getElementById('editModal').classList.remove('open'); editingUid=null; }
async function saveUserEdit() {
  if(!editingUid) return;
  const username=document.getElementById('eu-username').value.trim(), email=document.getElementById('eu-email').value.trim(), status=document.getElementById('eu-status').value, role=document.getElementById('eu-role').value, cloudBanned=document.getElementById('eu-cloudbanned').checked;
  try {
    await adminApi.update(editingUid, {username,email,status,role,cloud_banned:cloudBanned});
    const idx=allUsers.findIndex(u=>u.uid===editingUid); if(idx!==-1) Object.assign(allUsers[idx],{username,email,status,role,cloudBanned});
    renderUsersTable(); closeEditModal(); showToast('User updated');
  } catch(err){showToast('Error: '+err.message);}
}
async function sendPwdReset() {
  showToast('Password resets are not available on the local build — ask an admin to set a new password via Edit.');
}
function confirmDeleteUser(uid) { const u=allUsers.find(x=>x.uid===uid); confirm2('Delete User',`Permanently delete "${u?.username||uid}"?`,()=>deleteUser(uid)); }
async function deleteUser(uid) {
  try { await adminApi.delete(uid); allUsers=allUsers.filter(u=>u.uid!==uid); renderUsersTable(); showToast('User deleted'); } catch(err){showToast('Error: '+err.message);}
}

// ══════════════════════════════════════════════════
//  CONFIRM MODAL
// ══════════════════════════════════════════════════
let _confirmCb=null;
function confirm2(title,body,cb) { document.getElementById('cfmTitle').textContent=title; document.getElementById('cfmBody').textContent=body; _confirmCb=cb; document.getElementById('confirmModal').classList.add('open'); }
function closeConfirm() { document.getElementById('confirmModal').classList.remove('open'); _confirmCb=null; }
document.getElementById('cfmOk').addEventListener('click',()=>{_confirmCb?.();closeConfirm();});

// ══════════════════════════════════════════════════
//  UTILITIES
// ══════════════════════════════════════════════════
function showToast(msg) { const t=document.getElementById('toast'); t.textContent=msg; t.classList.add('show'); clearTimeout(t._t); t._t=setTimeout(()=>t.classList.remove('show'),2800); }
function fmt(b) { if(!b) return '—'; if(b<1024) return b+' B'; if(b<1048576) return (b/1024).toFixed(1)+' KB'; return (b/1048576).toFixed(1)+' MB'; }
function emoji(n) {
  n=(n||'').toLowerCase();
  if (romUtils && romUtils.isRomFile(n)) return '🎮';
  if(n.includes('race')||n.includes('car')||n.includes('driv')) return '🏎️';
  if(n.includes('shoot')||n.includes('gun')||n.includes('war'))  return '🎯';
  if(n.includes('puzzle')||n.includes('tetris')||n.includes('block')) return '🧩';
  if(n.includes('jump')||n.includes('run')||n.includes('mario')) return '🏃';
  if(n.includes('zombie')||n.includes('dead')) return '🧟';
  if(n.includes('tower')||n.includes('defense')) return '🏰';
  if(n.includes('fish')||n.includes('sea'))   return '🐟';
  if(n.includes('ball')||n.includes('sport')) return '⚽';
  return '🎮';
}
function esc(s) { return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

// Init
renderLibrary();
