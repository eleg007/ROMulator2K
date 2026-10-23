// API Client for ROMulator2K Local Backend
// Replaces Firebase SDK calls with REST API to local FastAPI backend.
// Classic script (not a module) so everything is exposed on window.

(function () {
'use strict';

const API_BASE = '';

async function api(path, options = {}) {
  const res = await fetch(API_BASE + path, {
    ...options,
    credentials: 'include', // Critical: send/receive cookies
    headers: { 'Content-Type': 'application/json', ...options.headers },
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ message: res.statusText }));
    throw new Error(err.message || `HTTP ${res.status}`);
  }
  return res.json();
}

// Auth API
const authApi = {
  register: (username, email, password) =>
    api('/api/auth/register', { method: 'POST', body: JSON.stringify({ username, email, password }) }),

  login: (email, password, remember) =>
    api('/api/auth/login', { method: 'POST', body: JSON.stringify({ email, password, remember }) }),

  logout: () => api('/api/auth/logout', { method: 'POST' }),

  session: () => api('/api/auth/session'),

  updateMe: (data) => api('/api/users/me', { method: 'PUT', body: JSON.stringify(data) }),

  bootstrap: () => api('/api/users/bootstrap'),
};

// Cloud Games API
const cloudApi = {
  list: () => api('/api/cloud-games'),

  upload: (file, displayName) => {
    const fd = new FormData();
    fd.append('file', file);
    if (displayName) fd.append('displayName', displayName);
    return fetch('/api/cloud-games', { method: 'POST', credentials: 'include', body: fd }).then(r => r.json());
  },

  delete: (gid) => api(`/api/cloud-games/${gid}`, { method: 'DELETE' }),

  play: (gid) => api(`/api/cloud-games/${gid}/play`, { method: 'POST' }),
};

// Admin API
const adminApi = {
  listUsers: () => api('/api/admin/users'),

  updateStatus: (uid, status) =>
    api(`/api/admin/users/${uid}/status`, { method: 'POST', body: JSON.stringify({ status }) }),

  cloudBan: (uid, banned) =>
    api(`/api/admin/users/${uid}/cloud-ban`, { method: 'POST', body: JSON.stringify({ banned }) }),

  update: (uid, data) =>
    api(`/api/admin/users/${uid}/update`, { method: 'POST', body: JSON.stringify(data) }),

  delete: (uid) => api(`/api/admin/users/${uid}/delete`, { method: 'POST' }),
};

// Auth state management (replaces firebase.auth().onAuthStateChanged)
let authStateCallbacks = [];
let currentUser = null;
let authCheckInterval = null;

function onAuthStateChanged(callback) {
  authStateCallbacks.push(callback);
  if (currentUser !== null) {
    callback(currentUser);
  }
  if (!authCheckInterval) {
    startAuthPolling();
  }
}

function notifyAuthChange(user) {
  currentUser = user;
  authStateCallbacks.forEach(cb => cb(user));
}

async function checkAuth() {
  try {
    const user = await authApi.session();
    notifyAuthChange(user);
  } catch {
    notifyAuthChange(null);
  }
}

function startAuthPolling() {
  checkAuth();
  authCheckInterval = setInterval(checkAuth, 10000); // Poll every 10s
}

function stopAuthPolling() {
  if (authCheckInterval) {
    clearInterval(authCheckInterval);
    authCheckInterval = null;
  }
}

// Initialize auth check on load
checkAuth();

// Expose to window for the inline app script
window.api       = { api };
window.authApi   = authApi;
window.cloudApi  = cloudApi;
window.adminApi  = adminApi;
window.onAuthStateChanged = onAuthStateChanged;

})();