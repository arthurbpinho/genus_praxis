import { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import '../styles/NotificationBell.css';

// Sino de notificações no canto superior direito. Faz polling das notificações
// (convite de duelo / resultado de duelo) e abre um painel ao clicar.
// Visitante não recebe notificações — o App.jsx nem renderiza o sino pra ele.
const POLL_MS = 20000;

function timeAgo(iso) {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return '';
  const diff = Math.max(0, Date.now() - t);
  const min = Math.floor(diff / 60000);
  if (min < 1) return 'agora';
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  return `${d}d`;
}

export default function NotificationBell({ user }) {
  const [items, setItems] = useState([]);
  const [unread, setUnread] = useState(0);
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  const panelRef = useRef(null);

  async function load() {
    try {
      // Duas fontes: as notificações de duelo (com read/unread por usuário) e os anúncios
      // do admin do tipo `notification` (demanda #12) — que, depois do pop-up, moram aqui.
      const [data, history] = await Promise.all([
        api.getNotifications(),
        api.getAnnouncementsHistory().catch(() => ({ notifications: [] })),
      ]);

      const duelItems = data.items || [];
      // O anúncio já foi confirmado no pop-up; no sino ele é HISTÓRICO informativo — entra
      // como "lido" e NÃO conta para o badge de não-lidos (senão o contador nunca zeraria).
      const annItems = (history.notifications || []).map((a) => ({
        id: a.id, kind: 'announcement', title: a.title, body: a.body,
        createdAt: a.createdAt, read: true,
      }));

      // Ordena tudo por data, mais recente primeiro.
      const all = [...duelItems, ...annItems]
        .sort((x, y) => new Date(y.createdAt || 0) - new Date(x.createdAt || 0));

      setItems(all);
      setUnread(data.unread || 0);   // só os duelos contam para o badge
    } catch {
      // silêncio — sino é best-effort
    }
  }

  useEffect(() => {
    load();
    const t = setInterval(load, POLL_MS);
    return () => clearInterval(t);
  }, [user?.id]);

  // Fecha o painel ao clicar fora.
  useEffect(() => {
    if (!open) return;
    function onDown(e) {
      if (panelRef.current && !panelRef.current.contains(e.target)) setOpen(false);
    }
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  async function handleClick(n) {
    setOpen(false);
    // Anúncio do admin: é só informativo, não tem rota nem estado de leitura no servidor.
    if (n.kind === 'announcement') return;
    try { await api.markNotificationRead(n.id); } catch {}
    load();
    if (n.type === 'duel_invite') {
      navigate(`/duelo/aceitar/${n.duelId}`);
    } else if (n.type === 'duel_result') {
      navigate(`/duelo/sessao/${n.duelId}`);
    }
  }

  async function markAll() {
    try { await api.markAllNotificationsRead(); } catch {}
    load();
  }

  return (
    <div className="notif-bell" ref={panelRef}>
      <button
        className="notif-bell-btn"
        onClick={() => setOpen((v) => !v)}
        aria-label="Notificações"
        title="Notificações"
      >
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
          <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
          <path d="M13.73 21a2 2 0 0 1-3.46 0" />
        </svg>
        {unread > 0 && <span className="notif-badge">{unread > 9 ? '9+' : unread}</span>}
      </button>

      {open && (
        <div className="notif-panel">
          <div className="notif-panel-header">
            <span>Notificações</span>
            {unread > 0 && (
              <button className="notif-markall" onClick={markAll}>marcar todas lidas</button>
            )}
          </div>
          <div className="notif-list">
            {items.length === 0 ? (
              <div className="notif-empty">Nenhuma notificação ainda.</div>
            ) : (
              items.map((n) => (
                <button
                  key={n.id}
                  className={`notif-item ${n.read ? '' : 'unread'} ${n.kind === 'announcement' ? 'is-announcement' : ''}`}
                  onClick={() => handleClick(n)}
                >
                  <span className="notif-item-icon">
                    {n.kind === 'announcement' ? '📢'
                      : n.type === 'duel_invite' ? '⚔'
                      : n.outcome === 'win' ? '★' : n.outcome === 'loss' ? '◇' : '='}
                  </span>
                  <span className="notif-item-body">
                    {n.kind === 'announcement' ? (
                      <>
                        <strong>{n.title}</strong>
                        {n.body ? <span className="notif-ann-body">{n.body}</span> : null}
                        <span className="notif-item-time">{timeAgo(n.createdAt)}</span>
                      </>
                    ) : (
                    <>
                    {/* O backend do Genus já monta a frase completa em `title`
                        (ex.: "Fulano desafiou você para um duelo"), então usamos
                        `title` como texto principal em vez de remontar a partir
                        de campos separados (não existem fromName/opponentName). */}
                    {n.title || (n.type === 'duel_invite' ? 'Novo convite de duelo' : 'Duelo finalizado')}
                    {n.type === 'duel_invite' && n.characterName ? (
                      <> · atender <em>{n.characterName}</em></>
                    ) : null}
                    {n.type === 'duel_result'
                      && Number.isFinite(n.scoreMine) && Number.isFinite(n.scoreTheirs) ? (
                      <> ({n.scoreMine} × {n.scoreTheirs})</>
                    ) : null}
                    {/* `mmrDelta` só vem em duelo ranqueado (competitivo, dois usuários
                        reais fora da calibração). É o mesmo delta do card pós-duelo —
                        senão o sino e a tela mostrariam números diferentes. Um empate
                        dá 0, e 0 é informação válida: por isso `Number.isFinite`. */}
                    {n.type === 'duel_result' && Number.isFinite(n.mmrDelta) ? (
                      <>
                        {' · '}
                        <span className={`notif-mmr ${n.mmrDelta >= 0 ? 'up' : 'down'}`}>
                          MMR {n.mmrDelta >= 0 ? '+' : '−'}{Math.abs(n.mmrDelta)}
                        </span>
                      </>
                    ) : null}
                    <span className="notif-item-time">{timeAgo(n.createdAt)}</span>
                    </>
                    )}
                  </span>
                </button>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
