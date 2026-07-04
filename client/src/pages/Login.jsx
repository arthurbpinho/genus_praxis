import { useState } from 'react';
import { api } from '../api';

export default function Login({ onLogin }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const user = await api.login(username, password);
      onLogin(user);
    } catch (err) {
      setError(err.message || 'Credenciais inválidas');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="login-container">
      <div className="login-card">
        <img src="/logo.png" alt="Genus Práxis" className="login-mark" />
        <div className="login-eyebrow">Plataforma de Simulação Clínica</div>
        <h1>Genus <span className="accent">Práxis</span></h1>
        <p className="subtitle">todo ser humano é único e possui um potencial ilimitado</p>
        <div className="login-ornament" />

        <form onSubmit={handleSubmit}>
          <div>
            <label htmlFor="username">Usuário</label>
            <input id="username" type="text" value={username} onChange={(e) => setUsername(e.target.value)} placeholder="seu usuário" autoComplete="username" required />
          </div>
          <div>
            <label htmlFor="password">Senha</label>
            <input id="password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="sua senha" autoComplete="current-password" required />
          </div>
          {error && <div className="alert error">{error}</div>}
          <button type="submit" className="btn btn-primary" disabled={loading}>
            {loading ? 'Entrando…' : 'Entrar'}
          </button>
        </form>
      </div>
    </div>
  );
}
