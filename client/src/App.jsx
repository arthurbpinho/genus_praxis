import { useState, useEffect } from 'react';
import { Routes, Route, Navigate, Link, useLocation, useNavigate } from 'react-router-dom';
import Login from './pages/Login';
import Home from './pages/Home';
import Simulacao from './pages/Simulacao';
import ChatSession from './pages/ChatSession';
import AdminCharacters from './pages/AdminCharacters';
import AdminUsers from './pages/AdminUsers';
import Logs from './pages/Logs';
import Profile from './pages/Profile';
import { api, getToken, clearAuth, onSessionExpired, DEMO } from './api';
import { ICONS } from './icons';

const USER_KEY = 'gp_user';

export default function App() {
  const [user, setUser] = useState(() => {
    if (!getToken()) return null;
    const saved = localStorage.getItem(USER_KEY);
    return saved ? JSON.parse(saved) : null;
  });
  const [authChecked, setAuthChecked] = useState(!getToken());
  const location = useLocation();
  const navigate = useNavigate();
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  // Barra lateral recolhível (só desktop) — estado lembrado entre sessões.
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    try { return localStorage.getItem('gp_sidebar_collapsed') === '1'; } catch { return false; }
  });
  function toggleSidebar() {
    setSidebarCollapsed((v) => {
      const next = !v;
      try { localStorage.setItem('gp_sidebar_collapsed', next ? '1' : '0'); } catch {}
      return next;
    });
  }

  useEffect(() => { setMobileNavOpen(false); }, [location.pathname]);

  // Revalida token no boot.
  useEffect(() => {
    if (!getToken()) { setAuthChecked(true); return; }
    let cancelled = false;
    api.me()
      .then((data) => {
        if (cancelled) return;
        if (data && data.user) {
          setUser(data.user);
          localStorage.setItem(USER_KEY, JSON.stringify(data.user));
        }
      })
      .catch(() => { if (!cancelled) { clearAuth(); setUser(null); } })
      .finally(() => { if (!cancelled) setAuthChecked(true); });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => onSessionExpired(() => { setUser(null); navigate('/'); }), [navigate]);

  const handleLogin = (u) => { setUser(u); localStorage.setItem(USER_KEY, JSON.stringify(u)); };
  const handleUpdateUser = (u) => { setUser(u); localStorage.setItem(USER_KEY, JSON.stringify(u)); };
  const handleLogout = () => { clearAuth(); setUser(null); navigate('/'); };

  if (!authChecked) return null;
  if (!user) return <Login onLogin={handleLogin} />;

  const isActive = (path) => location.pathname === path || location.pathname.startsWith(path + '/');
  const isTherapist = user.role === 'therapist';
  const isSupervisor = user.role === 'supervisor';
  const isAdmin = user.role === 'admin';
  const roleLabel = isTherapist ? 'Aluno' : isSupervisor ? 'Professor' : 'Administrador';

  return (
    <div className={`app-layout ${sidebarCollapsed ? 'sidebar-collapsed' : ''}`}>
      <header className="mobile-topbar">
        <button className="hamburger-btn" onClick={() => setMobileNavOpen((v) => !v)} aria-label="Abrir menu" aria-expanded={mobileNavOpen}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <line x1="3" y1="6" x2="21" y2="6" /><line x1="3" y1="12" x2="21" y2="12" /><line x1="3" y1="18" x2="21" y2="18" />
          </svg>
        </button>
        <div className="mobile-topbar-logo">
          <img src={`${import.meta.env.BASE_URL}logo.png`} alt="" className="brand-mark-sm" />
          <span>Genus <span className="accent">Práxis</span></span>
        </div>
        <Link to="/perfil" className="mobile-topbar-avatar" aria-label="Perfil">
          {user.profilePhoto ? <img src={user.profilePhoto} alt={user.name} /> : ICONS.user}
        </Link>
      </header>

      <div className={`mobile-nav-backdrop ${mobileNavOpen ? 'open' : ''}`} onClick={() => setMobileNavOpen(false)} aria-hidden="true" />

      <aside className={`sidebar ${mobileNavOpen ? 'open' : ''}`}>
        <button
          className="sidebar-toggle"
          onClick={toggleSidebar}
          aria-label={sidebarCollapsed ? 'Expandir menu' : 'Recolher menu'}
          title={sidebarCollapsed ? 'Expandir menu' : 'Recolher menu'}
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
            <polyline points={sidebarCollapsed ? '9 18 15 12 9 6' : '15 18 9 12 15 6'} />
          </svg>
        </button>
        <div className="sidebar-logo">
          <img src={`${import.meta.env.BASE_URL}logo.png`} alt="Genus Práxis" className="brand-mark" />
          <h1>Genus <span className="accent">Práxis</span></h1>
          <p>Simulação Clínica</p>
          {DEMO && <span className="sidebar-demo">Demonstração</span>}
        </div>

        <nav className="sidebar-nav">
          <div className="nav-section">Prática</div>
          <Link to="/inicio" title="Início" className={isActive('/inicio') ? 'active' : ''}>{ICONS.home}<span>Início</span></Link>
          <Link to="/simulacao" title="Simulação" className={isActive('/simulacao') ? 'active' : ''}>{ICONS.simulation}<span>Simulação</span></Link>

          <div className="nav-section">Histórico</div>
          <Link to="/logs" title={isTherapist ? 'Meus logs' : 'Todos os logs'} className={isActive('/logs') ? 'active' : ''}>
            {ICONS.log}<span>{isTherapist ? 'Meus logs' : 'Todos os logs'}</span>
          </Link>

          {isAdmin && (
            <>
              <div className="nav-section">Administração</div>
              <Link to="/admin/personagens" title="Criação de Personagens" className={isActive('/admin/personagens') ? 'active' : ''}>
                {ICONS.characters}<span>Criação de Personagens</span>
              </Link>
              <Link to="/admin/contas" title="Contas" className={isActive('/admin/contas') ? 'active' : ''}>
                {ICONS.users}<span>Contas</span>
              </Link>
            </>
          )}
        </nav>

        <div className="sidebar-user">
          <Link to="/perfil" className="profile-mini" title="Editar perfil">
            <span className="profile-mini-avatar">
              {user.profilePhoto ? <img src={user.profilePhoto} alt={user.name} /> : ICONS.user}
            </span>
            <div className="profile-mini-info">
              <div className="profile-mini-name">{user.name}</div>
              <div className="profile-mini-role">{roleLabel}</div>
            </div>
          </Link>
          <button onClick={handleLogout} className="btn btn-ghost btn-sm" title="Sair">{ICONS.exit}</button>
        </div>
      </aside>

      <main className="main-content">
        <Routes>
          <Route path="/inicio" element={<Home user={user} />} />
          <Route path="/simulacao" element={<Simulacao user={user} />} />
          <Route path="/chat/simulacao/:id" element={<ChatSession user={user} />} />
          <Route path="/logs" element={<Logs user={user} />} />
          <Route path="/perfil" element={<Profile user={user} onUpdate={handleUpdateUser} />} />
          {isAdmin && <Route path="/admin/personagens" element={<AdminCharacters />} />}
          {isAdmin && <Route path="/admin/contas" element={<AdminUsers user={user} />} />}
          <Route path="*" element={<Navigate to="/inicio" replace />} />
        </Routes>
      </main>
    </div>
  );
}
