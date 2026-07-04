// Persistência de sessão ativa (não finalizada): localStorage (instantâneo) +
// servidor (sincroniza entre dispositivos). A fonte mais recente vence.

import { api } from './api';

const LS_PREFIX = 'gp_active_session__';
function lsKey(userId, type, itemId) { return `${LS_PREFIX}${userId}__${type}__${itemId}`; }

export function loadLocal(userId, type, itemId) {
  try {
    const raw = localStorage.getItem(lsKey(userId, type, itemId));
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}
export function saveLocal(userId, type, itemId, data) {
  try {
    const payload = { ...data, lastSavedAt: new Date().toISOString() };
    localStorage.setItem(lsKey(userId, type, itemId), JSON.stringify(payload));
    return payload;
  } catch { return null; }
}
export function clearLocal(userId, type, itemId) {
  try { localStorage.removeItem(lsKey(userId, type, itemId)); } catch {}
}

export async function loadActiveSession(userId, type, itemId) {
  const local = loadLocal(userId, type, itemId);
  let remote = null;
  try { remote = await api.getActiveSession(type, itemId); } catch {}
  if (!local && !remote) return null;
  if (local && !remote) return local;
  if (remote && !local) return remote;
  const localTime = new Date(local.lastSavedAt || 0).getTime();
  const remoteTime = new Date(remote.lastSavedAt || 0).getTime();
  return remoteTime > localTime ? remote : local;
}

export async function clearActiveSession(userId, type, itemId) {
  clearLocal(userId, type, itemId);
  try { await api.clearActiveSession(type, itemId); } catch {}
}
