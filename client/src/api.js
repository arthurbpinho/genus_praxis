import { demoApi } from './demo';

// Origem da API. Vazio (padrão) = mesma origem — funciona no dev (proxy do Vite)
// e no deploy full-stack (o Express serve o front). Para hospedar o FRONT no
// GitHub Pages com o BACKEND em outro host, defina VITE_API_BASE no build com a
// URL do backend (ex.: https://meu-backend.up.railway.app).
const API_ORIGIN = (import.meta.env.VITE_API_BASE || '').replace(/\/+$/, '');
const BASE = `${API_ORIGIN}/api`;
const TOKEN_KEY = 'gp_token';
const USER_KEY = 'gp_user';

// Modo demonstração (VITE_DEMO=1): front sem backend, com dados fictícios.
// Usado no GitHub Pages para mostrar o app sem servidor.
export const DEMO = import.meta.env.VITE_DEMO === '1';

// Resolve URLs de assets servidos pelo backend (ex.: /patient-photos/...).
// Data URLs e URLs absolutas passam direto.
export function assetUrl(p) {
  if (!p) return p;
  if (/^(https?:)?\/\//i.test(p) || p.startsWith('data:')) return p;
  return `${API_ORIGIN}${p}`;
}

export function getToken() {
  try { return localStorage.getItem(TOKEN_KEY); } catch { return null; }
}
export function setToken(token) {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {}
}
export function clearAuth() {
  try {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
  } catch {}
}

const sessionListeners = new Set();
export function onSessionExpired(fn) {
  sessionListeners.add(fn);
  return () => sessionListeners.delete(fn);
}
function notifySessionExpired() {
  for (const fn of sessionListeners) { try { fn(); } catch {} }
}

async function request(path, options = {}) {
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(BASE + path, {
    ...options,
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  if (res.status === 401) {
    clearAuth();
    notifySessionExpired();
    const err = await res.json().catch(() => ({ error: 'Sessão expirada' }));
    throw new Error(err.error || 'Sessão expirada');
  }
  if (!res.ok) {
    const err = await res.json().catch(() => null);
    throw new Error((err && err.error) || `Erro ${res.status}${res.statusText ? ' ' + res.statusText : ''}`);
  }
  return res.json();
}

const realApi = {
  // Auth
  login: async (username, password) => {
    const data = await request('/login', { method: 'POST', body: { username, password } });
    if (data && data.token) setToken(data.token);
    return data && data.user ? data.user : data;
  },
  me: () => request('/me'),
  changeMyPassword: (currentPassword, newPassword) =>
    request('/me/password', { method: 'POST', body: { currentPassword, newPassword } }),

  // Perfil
  getUser: (id) => request(`/users/${id}`),
  updateUser: (id, data) => request(`/users/${id}`, { method: 'PUT', body: data }),

  // Personagens da simulação
  getCharacters: () => request('/characters'),
  createCharacter: (data) => request('/characters', { method: 'POST', body: data }),
  updateCharacter: (id, data) => request(`/characters/${id}`, { method: 'PUT', body: data }),
  deleteCharacter: (id) => request(`/characters/${id}`, { method: 'DELETE' }),
  setCharacterPhoto: (id, data) => request(`/characters/${id}/photo`, { method: 'PUT', body: data }),

  // Logs
  getLogs: (userId) => request(`/logs${userId ? `?userId=${encodeURIComponent(userId)}` : ''}`),
  saveLog: (data) => request('/logs', { method: 'POST', body: data }),
  getLogsPolicy: () => request('/logs/policy'),
  deleteLog: (id) => request(`/logs/${id}`, { method: 'DELETE' }),

  // Chat da simulação (o servidor resolve o system prompt via context: { type, itemId })
  chat: (messages, context) => request('/chat', { method: 'POST', body: { messages, context } }),
  // Avaliação (estrutura pronta; desligada por padrão → { disabled: true })
  evaluate: (messages, context) => request('/evaluate', { method: 'POST', body: { messages, context } }),
  transcribe: (audioBase64) => request('/transcribe', { method: 'POST', body: { audio: audioBase64 } }),

  // Sessões ativas (persistência de sessão não finalizada)
  getActiveSession: (type, itemId) => request(`/active-sessions/${type}/${encodeURIComponent(itemId)}`),
  saveActiveSession: (type, itemId, data) =>
    request(`/active-sessions/${type}/${encodeURIComponent(itemId)}`, { method: 'PUT', body: data }),
  clearActiveSession: (type, itemId) =>
    request(`/active-sessions/${type}/${encodeURIComponent(itemId)}`, { method: 'DELETE' }),

  // Configurações
  getSettings: () => request('/settings'),
  adminUpdateSettings: (data) => request('/admin/settings', { method: 'PUT', body: data }),

  // Admin · Contas
  adminListUsers: () => request('/admin/users'),
  adminCreateUser: (data) => request('/admin/users', { method: 'POST', body: data }),
  adminUpdateUser: (id, data) => request(`/admin/users/${id}`, { method: 'PUT', body: data }),
  adminDeleteUser: (id) => request(`/admin/users/${id}`, { method: 'DELETE' }),
  adminResetPassword: (id, newPassword) =>
    request(`/admin/users/${id}/reset-password`, { method: 'POST', body: { newPassword } }),
  adminExportData: async () => {
    const token = getToken();
    const res = await fetch(BASE + '/admin/export', { headers: token ? { Authorization: `Bearer ${token}` } : {} });
    if (!res.ok) {
      let err = 'Erro ao exportar';
      try { const j = await res.json(); err = j.error || err; } catch {}
      throw new Error(err);
    }
    const dispo = res.headers.get('content-disposition') || '';
    const match = dispo.match(/filename="([^"]+)"/);
    const filename = match ? match[1] : `genus-praxis-export-${new Date().toISOString().slice(0, 10)}.json`;
    const blob = await res.blob();
    return { blob, filename };
  },
};

// No modo demonstração usamos a API falsa (sem backend); senão, a real.
export const api = DEMO ? demoApi : realApi;
