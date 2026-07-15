import { useState, useEffect, useRef } from 'react';
import { api } from '../api';
import '../styles/SystemUpdates.css';

// Painel "Atualizações do sistema" — ícone de bloco de notas com exclamação, à esquerda do
// sino. Desde a demanda #12, o conteúdo vem do SERVIDOR: são os anúncios do tipo `update`
// que o admin publica. O `changelog.js` hardcoded foi aposentado (ele mostrava notas de
// desenvolvimento que não deviam aparecer para os usuários reais).
//
// O ponto de "novidade" aparece até o usuário abrir a atualização mais recente. Rastreado
// em localStorage por dispositivo (o conteúdo é público para o papel; não é dado sensível).
const SEEN_KEY = 'genus_updates_seen';

function formatDate(iso) {
  try {
    return new Date(iso).toLocaleDateString('pt-BR', { day: 'numeric', month: 'long', year: 'numeric' });
  } catch {
    return iso;
  }
}

export default function SystemUpdates({ userId }) {
  const [updates, setUpdates] = useState([]);
  const [open, setOpen] = useState(false);
  const [seen, setSeen] = useState(() => {
    try { return localStorage.getItem(SEEN_KEY); } catch { return null; }
  });
  const panelRef = useRef(null);

  // Carrega os anúncios do tipo "update" ao entrar/trocar de conta.
  useEffect(() => {
    if (!userId) { setUpdates([]); return; }
    api.getAnnouncementsHistory()
      .then((h) => setUpdates(Array.isArray(h?.updates) ? h.updates : []))
      .catch(() => setUpdates([]));
  }, [userId]);

  const latest = updates[0]?.id || null;   // a lista vem do servidor com a mais recente primeiro
  const hasNew = latest && seen !== latest;

  useEffect(() => {
    if (!open) return undefined;
    function onDown(e) {
      if (panelRef.current && !panelRef.current.contains(e.target)) setOpen(false);
    }
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  function toggle() {
    setOpen((v) => {
      const next = !v;
      if (next && latest) {
        try { localStorage.setItem(SEEN_KEY, latest); } catch {}
        setSeen(latest);
      }
      return next;
    });
  }

  return (
    <div className="sys-updates" ref={panelRef}>
      <button
        className="sys-updates-btn"
        onClick={toggle}
        aria-label="Atualizações do sistema"
        title="Atualizações do sistema"
      >
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" />
          <polyline points="14 3 14 9 20 9" />
          <line x1="11" y1="12.5" x2="11" y2="15.5" />
          <line x1="11" y1="18" x2="11" y2="18" />
        </svg>
        {hasNew && <span className="sys-updates-dot" aria-label="Há novidades" />}
      </button>

      {open && (
        <div className="sys-updates-panel">
          <div className="sys-updates-header">Atualizações do sistema</div>
          <div className="sys-updates-list">
            {updates.length === 0 ? (
              <div className="sys-update-item" style={{ color: 'var(--text-muted)' }}>
                Nenhuma atualização por aqui ainda.
              </div>
            ) : updates.map((entry) => (
              <div key={entry.id} className="sys-update-item">
                <div className="sys-update-date">{formatDate(entry.createdAt)}</div>
                {entry.title && <div className="sys-update-title">{entry.title}</div>}
                <div className="sys-update-body">{entry.body}</div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
