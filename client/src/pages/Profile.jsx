import { useState, useRef } from 'react';
import { api } from '../api';
import Typewriter from '../components/Typewriter';
import { ICONS } from '../icons';

const ROLE_LABELS = { admin: 'Administrador', supervisor: 'Professor', therapist: 'Aluno' };

// Redimensiona a foto de perfil para um quadrado de 256px (data URL JPEG).
function fileToSquareDataUrl(file, size = 256) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      const side = Math.min(img.width, img.height);
      const sx = (img.width - side) / 2;
      const sy = (img.height - side) / 2;
      const c = document.createElement('canvas');
      c.width = size; c.height = size;
      c.getContext('2d').drawImage(img, sx, sy, side, side, 0, 0, size, size);
      resolve(c.toDataURL('image/jpeg', 0.85));
    };
    img.onerror = (e) => { URL.revokeObjectURL(url); reject(e); };
    img.src = url;
  });
}

export default function Profile({ user, onUpdate }) {
  const [name, setName] = useState(user.name || '');
  const [email, setEmail] = useState(user.email || '');
  const [photo, setPhoto] = useState(user.profilePhoto || '');
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const fileRef = useRef(null);

  const [curPwd, setCurPwd] = useState('');
  const [newPwd, setNewPwd] = useState('');
  const [pwdSaving, setPwdSaving] = useState(false);
  const [pwdMsg, setPwdMsg] = useState('');
  const [pwdErr, setPwdErr] = useState('');

  async function handlePhoto(e) {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try { setPhoto(await fileToSquareDataUrl(file)); }
    catch { setErr('Não foi possível processar a imagem.'); }
  }

  async function saveProfile(e) {
    e.preventDefault();
    setSaving(true); setMsg(''); setErr('');
    try {
      const updated = await api.updateUser(user.id, { name: name.trim(), email: email.trim(), profilePhoto: photo });
      onUpdate({ ...user, ...updated });
      setMsg('Perfil atualizado.');
      setTimeout(() => setMsg(''), 3000);
    } catch (e2) {
      setErr(e2.message || 'Erro ao salvar perfil.');
    } finally {
      setSaving(false);
    }
  }

  async function savePassword(e) {
    e.preventDefault();
    setPwdSaving(true); setPwdMsg(''); setPwdErr('');
    if (newPwd.length < 6) { setPwdErr('A nova senha deve ter ao menos 6 caracteres.'); setPwdSaving(false); return; }
    try {
      await api.changeMyPassword(curPwd, newPwd);
      setPwdMsg('Senha alterada com sucesso.');
      setCurPwd(''); setNewPwd('');
      setTimeout(() => setPwdMsg(''), 3000);
    } catch (e2) {
      setPwdErr(e2.message || 'Erro ao alterar a senha.');
    } finally {
      setPwdSaving(false);
    }
  }

  return (
    <div>
      <div className="page-header">
        <div className="eyebrow">Conta</div>
        <h2><Typewriter text="Meu " /><span className="accent"><Typewriter text="Perfil" delayStart={280} /></span></h2>
        <p>Gerencie seus dados, sua foto e sua senha.</p>
        <div className="ornament" />
      </div>

      <div className="profile-grid">
        <form className="card admin-form" onSubmit={saveProfile}>
          <div className="profile-photo-row">
            <span className="profile-photo-avatar">
              {photo ? <img src={photo} alt={name} /> : ICONS.user}
            </span>
            <div>
              <div className="profile-photo-name">{user.name}</div>
              <div className="muted">{ROLE_LABELS[user.role] || user.role}{user.teacherName ? ` · Professor: ${user.teacherName}` : ''}</div>
              <div style={{ marginTop: 8, display: 'flex', gap: 8 }}>
                <button type="button" className="btn btn-outline btn-sm" onClick={() => fileRef.current?.click()}>Trocar foto</button>
                {photo && <button type="button" className="btn btn-ghost btn-sm" onClick={() => setPhoto('')}>Remover</button>}
                <input ref={fileRef} type="file" accept="image/*" onChange={handlePhoto} style={{ display: 'none' }} />
              </div>
            </div>
          </div>
          <div>
            <label htmlFor="pname">Nome</label>
            <input id="pname" value={name} onChange={(e) => setName(e.target.value)} required />
          </div>
          <div>
            <label htmlFor="pemail">E-mail</label>
            <input id="pemail" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="seu@email.com" />
          </div>
          <div>
            <label>Usuário</label>
            <input value={user.username} disabled />
          </div>
          {err && <div className="alert error">{err}</div>}
          {msg && <div className="alert success">{msg}</div>}
          <div><button type="submit" className="btn btn-primary" disabled={saving}>{saving ? 'Salvando…' : 'Salvar perfil'}</button></div>
        </form>

        <form className="card admin-form" onSubmit={savePassword}>
          <h3 className="card-title">Alterar senha</h3>
          <div>
            <label htmlFor="curpwd">Senha atual</label>
            <input id="curpwd" type="password" value={curPwd} onChange={(e) => setCurPwd(e.target.value)} autoComplete="current-password" required />
          </div>
          <div>
            <label htmlFor="newpwd">Nova senha</label>
            <input id="newpwd" type="password" value={newPwd} onChange={(e) => setNewPwd(e.target.value)} autoComplete="new-password" placeholder="Mínimo 6 caracteres" required />
          </div>
          {pwdErr && <div className="alert error">{pwdErr}</div>}
          {pwdMsg && <div className="alert success">{pwdMsg}</div>}
          <div><button type="submit" className="btn btn-primary" disabled={pwdSaving}>{pwdSaving ? 'Salvando…' : 'Alterar senha'}</button></div>
        </form>
      </div>
    </div>
  );
}
