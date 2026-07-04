require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const { buildSimulationPrompt, buildDirectEvaluationPrompt } = require('./prompts');
const { finalScoreFromCriteria } = require('./scoring');

const app = express();
app.set('trust proxy', 1);

// --- CORS: em produção o mesmo servidor serve o front; em dev libera o Vite. ---
const CORS_ALLOWLIST = (process.env.CORS_ALLOWLIST || 'http://localhost:5173')
  .split(',').map((s) => s.trim()).filter(Boolean);

function isLocalViteDevOrigin(origin) {
  try {
    const u = new URL(origin);
    if (u.protocol !== 'http:' || u.port !== '5173') return false;
    const h = u.hostname;
    if (h === 'localhost' || h === '127.0.0.1') return true;
    if (/^10\./.test(h)) return true;
    if (/^192\.168\./.test(h)) return true;
    if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(h)) return true;
    return false;
  } catch { return false; }
}

app.use(cors((req, cb) => {
  const origin = req.headers.origin;
  if (!origin) return cb(null, { origin: true });
  if (CORS_ALLOWLIST.includes(origin)) return cb(null, { origin: true });
  try {
    const originHost = new URL(origin).host;
    if (originHost && originHost === req.headers.host) return cb(null, { origin: true });
  } catch {}
  if (isLocalViteDevOrigin(origin)) return cb(null, { origin: true });
  return cb(new Error('Origin não permitida pelo CORS: ' + origin));
}));

app.use(express.json({ limit: '12mb' }));

// --- Persistência (JSON em arquivo) ---
const SEED_DATA_DIR = path.join(__dirname, 'data');
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : SEED_DATA_DIR;
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (DATA_DIR !== SEED_DATA_DIR && fs.existsSync(SEED_DATA_DIR)) {
  for (const f of fs.readdirSync(SEED_DATA_DIR)) {
    const src = path.join(SEED_DATA_DIR, f);
    if (!fs.statSync(src).isFile()) continue;
    const dst = path.join(DATA_DIR, f);
    if (!fs.existsSync(dst)) fs.copyFileSync(src, dst);
  }
}

// Fotos de paciente (enviadas pelo admin) — ficam no volume persistente.
const PATIENT_PHOTOS_DIR = path.join(DATA_DIR, 'patient-photos');
if (!fs.existsSync(PATIENT_PHOTOS_DIR)) fs.mkdirSync(PATIENT_PHOTOS_DIR, { recursive: true });
app.use('/patient-photos', express.static(PATIENT_PHOTOS_DIR, { maxAge: '7d' }));

// --- JWT ---
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET || JWT_SECRET.length < 32) {
  console.error('[FATAL] JWT_SECRET ausente ou curto demais (mínimo 32 chars).');
  console.error('        Gere com: node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'hex\'))"');
  process.exit(1);
}
const TOKEN_TTL = '7d';
const BCRYPT_ROUNDS = 10;

// --- Rate limiting (no-op em testes) ---
const SKIP_RATE_LIMIT = process.env.NODE_ENV === 'test';
const noopLimiter = (req, res, next) => next();
const loginLimiter = SKIP_RATE_LIMIT ? noopLimiter : rateLimit({
  windowMs: 15 * 60 * 1000, max: 20, standardHeaders: true, legacyHeaders: false,
  message: { error: 'Muitas tentativas. Tente novamente em alguns minutos.' },
});
function userKey(req) { return (req.user && req.user.id) ? `u:${req.user.id}` : `ip:${req.ip}`; }
const aiLimiter = SKIP_RATE_LIMIT ? noopLimiter : rateLimit({
  windowMs: 60 * 60 * 1000, max: 400, standardHeaders: true, legacyHeaders: false,
  keyGenerator: userKey, message: { error: 'Limite de uso da IA atingido. Tente novamente em uma hora.' },
});
const writeLimiter = SKIP_RATE_LIMIT ? noopLimiter : rateLimit({
  windowMs: 60 * 60 * 1000, max: 300, standardHeaders: true, legacyHeaders: false,
  keyGenerator: userKey, message: { error: 'Limite de operações atingido. Tente novamente mais tarde.' },
});

function readJSON(file, fallback = []) {
  const p = path.join(DATA_DIR, file);
  if (!fs.existsSync(p)) return fallback;
  try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return fallback; }
}
function writeJSON(file, data) {
  const dest = path.join(DATA_DIR, file);
  const tmp = `${dest}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, dest);
}

// Mutex em memória por arquivo — serializa read-modify-write concorrente.
const fileLocks = new Map();
async function withFileLock(file, fn) {
  const prev = fileLocks.get(file) || Promise.resolve();
  let release;
  const next = new Promise((r) => (release = r));
  fileLocks.set(file, prev.then(() => next));
  await prev;
  try { return await fn(); }
  finally {
    release();
    if (fileLocks.get(file) === next) fileLocks.delete(file);
  }
}

// --- Papéis: apenas Aluno (therapist), Professor (supervisor) e Administrador (admin). ---
const VALID_ROLES = ['therapist', 'supervisor', 'admin'];
const DEFAULT_PROFILE = { email: '', profilePhoto: '' };

function hashSync(plain) { return bcrypt.hashSync(String(plain), BCRYPT_ROUNDS); }

// Seed inicial (só na primeira execução, quando users.json ainda não existe).
//
// PRODUÇÃO: defina ADMIN_INITIAL_PASSWORD (e, opcionalmente, ADMIN_INITIAL_USERNAME).
//   O app cria APENAS o admin, com essa senha. Você loga com ele e cria as demais
//   contas na tela "Contas". A senha nunca é versionada — vive só na env do servidor.
//
// DESENVOLVIMENTO LOCAL (sem ADMIN_INITIAL_PASSWORD): cria as três contas de
//   DEMONSTRAÇÃO (admin/admin123 · supervisor/supervisor123 · aluno/aluno123).
//   NÃO use essas contas em produção.
if (!fs.existsSync(path.join(DATA_DIR, 'users.json'))) {
  const adminUsername = (process.env.ADMIN_INITIAL_USERNAME || 'admin').trim();
  const adminPassword = process.env.ADMIN_INITIAL_PASSWORD;
  if (adminPassword) {
    if (String(adminPassword).length < 8) {
      console.error('[FATAL] ADMIN_INITIAL_PASSWORD curta demais (mínimo 8 caracteres).');
      process.exit(1);
    }
    writeJSON('users.json', [
      { id: '1', username: adminUsername, passwordHash: hashSync(adminPassword), name: 'Administrador', role: 'admin', teacherId: null, ...DEFAULT_PROFILE },
    ]);
    console.log(`[seed] Admin criado a partir de ADMIN_INITIAL_PASSWORD. Usuário: ${adminUsername}`);
  } else {
    writeJSON('users.json', [
      { id: '1', username: 'admin', passwordHash: hashSync('admin123'), name: 'Administrador', role: 'admin', teacherId: null, ...DEFAULT_PROFILE },
      { id: '2', username: 'supervisor', passwordHash: hashSync('supervisor123'), name: 'Supervisor', role: 'supervisor', teacherId: null, ...DEFAULT_PROFILE },
      { id: '3', username: 'aluno', passwordHash: hashSync('aluno123'), name: 'Aluno', role: 'therapist', teacherId: '2', ...DEFAULT_PROFILE },
    ]);
    console.warn('[seed] Contas de DEMONSTRAÇÃO criadas (admin/admin123 · supervisor/supervisor123 · aluno/aluno123).');
    console.warn('[seed] Em produção defina ADMIN_INITIAL_PASSWORD para criar apenas um admin seguro.');
  }
}

// Personagens de simulação de exemplo.
if (!fs.existsSync(path.join(DATA_DIR, 'characters.json'))) {
  writeJSON('characters.json', [
    { id: 'ch1', name: 'Sofia', age: 25, description: 'Jovem com queixas relacionais.', specificInstruction: 'Você é Sofia, 25 anos, designer gráfica. Veio à terapia por dificuldades nos relacionamentos amorosos. Tem um padrão de se apegar rápido e depois sentir que o parceiro não corresponde. Fale de forma expressiva e emotiva.', evaluationCriteria: '' },
    { id: 'ch2', name: 'Roberto', age: 55, description: 'Homem em crise de meia-idade.', specificInstruction: 'Você é Roberto, 55 anos, contador. Está passando por uma crise existencial: os filhos saíram de casa, sente que o casamento esfriou, questiona suas escolhas de carreira. Fale de forma contida, com dificuldade de expressar emoções.', evaluationCriteria: '' },
  ]);
}

if (!fs.existsSync(path.join(DATA_DIR, 'logs.json'))) writeJSON('logs.json', []);
if (!fs.existsSync(path.join(DATA_DIR, 'active-sessions.json'))) writeJSON('active-sessions.json', {});
if (!fs.existsSync(path.join(DATA_DIR, 'settings.json'))) {
  writeJSON('settings.json', { evaluatorEnabled: process.env.EVALUATOR_ENABLED === 'true' });
}

// --- Diagnóstico de startup ---
function envDiag(name) {
  const v = process.env[name];
  if (v === undefined) return 'NOT SET';
  if (v === '') return 'EMPTY';
  return `set (${v.length} chars)`;
}
console.log('[startup] JWT_SECRET     =', envDiag('JWT_SECRET'));
console.log('[startup] OPENAI_API_KEY =', envDiag('OPENAI_API_KEY'), '(Simulação + Whisper)');
console.log('[startup] EVALUATOR_ENABLED =', process.env.EVALUATOR_ENABLED === 'true' ? 'true' : 'false');
console.log('[startup] DATA_DIR       =', DATA_DIR);

// --- Auth helpers ---
function publicUser(u) {
  if (!u) return null;
  const { password, passwordHash, ...safe } = u;
  if (safe.role === 'therapist' && safe.teacherId) {
    try {
      const teacher = readJSON('users.json').find((t) => t.id === safe.teacherId);
      if (teacher && teacher.name) safe.teacherName = teacher.name;
    } catch {}
  }
  return safe;
}
function signToken(user) {
  return jwt.sign({ sub: user.id, role: user.role, username: user.username }, JWT_SECRET, { expiresIn: TOKEN_TTL });
}
function getTokenFromReq(req) {
  const h = req.headers.authorization || '';
  return h.startsWith('Bearer ') ? h.slice(7) : null;
}
function requireAuth(req, res, next) {
  const token = getTokenFromReq(req);
  if (!token) return res.status(401).json({ error: 'Não autenticado' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    const user = readJSON('users.json').find((u) => u.id === payload.sub);
    if (!user) return res.status(401).json({ error: 'Sessão inválida' });
    req.user = user;
    next();
  } catch {
    return res.status(401).json({ error: 'Sessão expirada' });
  }
}
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Não autenticado' });
    if (!roles.includes(req.user.role)) return res.status(403).json({ error: 'Acesso negado' });
    next();
  };
}
function isAdmin(user) { return !!(user && user.role === 'admin'); }
// Aluno vê o próprio; professor e admin veem todos (aba "Todos os logs").
function canSeeAllLogs(user) { return !!(user && (user.role === 'admin' || user.role === 'supervisor')); }

// =====================================================================
// AUTH
// =====================================================================
app.post('/api/login', loginLimiter, async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Usuário e senha são obrigatórios' });
  const user = readJSON('users.json').find((u) => u.username === username);
  const ok = user && user.passwordHash ? await bcrypt.compare(String(password), user.passwordHash) : false;
  if (!ok) return res.status(401).json({ error: 'Credenciais inválidas' });
  res.json({ token: signToken(user), user: publicUser(user) });
});

app.get('/api/me', requireAuth, (req, res) => res.json({ user: publicUser(req.user) }));

app.post('/api/me/password', requireAuth, async (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (!currentPassword || !newPassword) return res.status(400).json({ error: 'Senha atual e nova são obrigatórias' });
  if (String(newPassword).length < 6) return res.status(400).json({ error: 'Nova senha deve ter ao menos 6 caracteres' });
  const ok = await bcrypt.compare(String(currentPassword), req.user.passwordHash || '');
  if (!ok) return res.status(401).json({ error: 'Senha atual incorreta' });
  await withFileLock('users.json', () => {
    const users = readJSON('users.json');
    const idx = users.findIndex((u) => u.id === req.user.id);
    if (idx === -1) return;
    users[idx].passwordHash = bcrypt.hashSync(String(newPassword), BCRYPT_ROUNDS);
    writeJSON('users.json', users);
  });
  res.json({ ok: true });
});

// =====================================================================
// PERFIL
// =====================================================================
function canAccessUser(actor, targetId) {
  if (!actor) return false;
  if (actor.role === 'admin') return true;
  if (actor.id === targetId) return true;
  // Professor só acessa o perfil dos alunos vinculados a ele.
  if (actor.role === 'supervisor') {
    const target = readJSON('users.json').find((u) => u.id === targetId);
    return !!(target && target.teacherId === actor.id);
  }
  return false;
}

app.get('/api/users/:id', requireAuth, (req, res) => {
  if (!canAccessUser(req.user, req.params.id)) return res.status(403).json({ error: 'Acesso negado' });
  const user = readJSON('users.json').find((u) => u.id === req.params.id);
  if (!user) return res.status(404).json({ error: 'Usuário não encontrado' });
  res.json(publicUser(user));
});

app.put('/api/users/:id', requireAuth, async (req, res) => {
  if (req.user.id !== req.params.id && req.user.role !== 'admin') return res.status(403).json({ error: 'Acesso negado' });
  const result = await withFileLock('users.json', () => {
    const users = readJSON('users.json');
    const idx = users.findIndex((u) => u.id === req.params.id);
    if (idx === -1) return { status: 404, error: 'Usuário não encontrado' };
    const allowed = ['name', 'email', 'profilePhoto'];
    const patch = {};
    for (const k of allowed) if (k in req.body) patch[k] = req.body[k];
    users[idx] = { ...users[idx], ...patch };
    writeJSON('users.json', users);
    return { user: publicUser(users[idx]) };
  });
  if (result.error) return res.status(result.status).json({ error: result.error });
  res.json(result.user);
});

// =====================================================================
// ADMIN · CONTAS
// =====================================================================
const usernameRegex = /^[a-zA-Z0-9._-]{3,32}$/;
function nextUserId(users) {
  const max = users.reduce((m, u) => {
    const n = Number(u.id);
    return Number.isFinite(n) && n > m ? n : m;
  }, 0);
  return String(max + 1);
}
function validateUserPayload(body, users, { isUpdate = false, currentUser = null } = {}) {
  const errors = [];
  const username = (body.username || '').trim();
  const role = body.role;
  const teacherId = body.teacherId || null;
  if (!isUpdate || body.username !== undefined) {
    if (!usernameRegex.test(username)) errors.push('Usuário inválido (3-32 caracteres: letras, números, . _ -)');
    const dup = users.find((u) => u.username === username && (!currentUser || u.id !== currentUser.id));
    if (dup) errors.push('Usuário já existe');
  }
  if (!isUpdate && (!body.password || String(body.password).length < 6)) errors.push('Senha deve ter ao menos 6 caracteres');
  if (body.password !== undefined && body.password !== '' && String(body.password).length < 6) errors.push('Senha deve ter ao menos 6 caracteres');
  if (!isUpdate && !VALID_ROLES.includes(role)) errors.push('Função inválida');
  if (teacherId) {
    const t = users.find((u) => u.id === teacherId);
    if (!t || t.role !== 'supervisor') errors.push('Professor inválido');
  }
  return errors;
}

app.get('/api/admin/users', requireAuth, requireRole('admin'), (req, res) => {
  res.json(readJSON('users.json').map(publicUser));
});

app.post('/api/admin/users', requireAuth, requireRole('admin'), async (req, res) => {
  const result = await withFileLock('users.json', () => {
    const users = readJSON('users.json');
    const errors = validateUserPayload(req.body, users);
    if (errors.length) return { status: 400, error: errors.join('; ') };
    const role = req.body.role;
    const newUser = {
      id: nextUserId(users),
      username: req.body.username.trim(),
      name: (req.body.name || req.body.username).trim(),
      role,
      teacherId: role === 'therapist' ? (req.body.teacherId || null) : null,
      passwordHash: bcrypt.hashSync(String(req.body.password), BCRYPT_ROUNDS),
      ...DEFAULT_PROFILE,
      email: req.body.email || '',
    };
    users.push(newUser);
    writeJSON('users.json', users);
    return { user: publicUser(newUser) };
  });
  if (result.error) return res.status(result.status).json({ error: result.error });
  res.json(result.user);
});

app.put('/api/admin/users/:id', requireAuth, requireRole('admin'), async (req, res) => {
  const result = await withFileLock('users.json', () => {
    const users = readJSON('users.json');
    const idx = users.findIndex((u) => u.id === req.params.id);
    if (idx === -1) return { status: 404, error: 'Usuário não encontrado' };
    const current = users[idx];
    if (current.id === req.user.id && req.body.role && req.body.role !== current.role) {
      return { status: 400, error: 'Você não pode alterar a sua própria função.' };
    }
    const merged = {
      ...current,
      ...(req.body.username !== undefined ? { username: String(req.body.username).trim() } : {}),
      ...(req.body.name !== undefined ? { name: String(req.body.name).trim() } : {}),
      ...(req.body.role !== undefined ? { role: req.body.role } : {}),
      ...(req.body.email !== undefined ? { email: req.body.email } : {}),
    };
    merged.teacherId = merged.role === 'therapist'
      ? (req.body.teacherId !== undefined ? (req.body.teacherId || null) : current.teacherId)
      : null;
    if (!VALID_ROLES.includes(merged.role)) return { status: 400, error: 'Função inválida' };
    const errors = validateUserPayload(merged, users, { isUpdate: true, currentUser: current });
    if (errors.length) return { status: 400, error: errors.join('; ') };
    if (req.body.password) {
      if (String(req.body.password).length < 6) return { status: 400, error: 'Senha deve ter ao menos 6 caracteres' };
      merged.passwordHash = bcrypt.hashSync(String(req.body.password), BCRYPT_ROUNDS);
    }
    // Professor rebaixado → desvincula alunos.
    if (current.role === 'supervisor' && merged.role !== 'supervisor') {
      for (const u of users) if (u.teacherId === current.id) u.teacherId = null;
    }
    users[idx] = merged;
    writeJSON('users.json', users);
    return { user: publicUser(merged) };
  });
  if (result.error) return res.status(result.status).json({ error: result.error });
  res.json(result.user);
});

app.delete('/api/admin/users/:id', requireAuth, requireRole('admin'), async (req, res) => {
  if (req.params.id === req.user.id) return res.status(400).json({ error: 'Você não pode excluir a própria conta.' });
  const result = await withFileLock('users.json', () => {
    const users = readJSON('users.json');
    const idx = users.findIndex((u) => u.id === req.params.id);
    if (idx === -1) return { status: 404, error: 'Usuário não encontrado' };
    const target = users[idx];
    if (target.role === 'supervisor') {
      const linked = users.filter((u) => u.teacherId === target.id);
      if (linked.length > 0) return { status: 400, error: `Este professor tem ${linked.length} aluno(s) vinculado(s). Reatribua-os antes de excluir.` };
    }
    users.splice(idx, 1);
    writeJSON('users.json', users);
    return { ok: true };
  });
  if (result.error) return res.status(result.status).json({ error: result.error });
  res.json({ ok: true });
});

app.post('/api/admin/users/:id/reset-password', requireAuth, requireRole('admin'), async (req, res) => {
  const newPassword = req.body && req.body.newPassword;
  if (!newPassword || String(newPassword).length < 6) return res.status(400).json({ error: 'Senha deve ter ao menos 6 caracteres' });
  const result = await withFileLock('users.json', () => {
    const users = readJSON('users.json');
    const idx = users.findIndex((u) => u.id === req.params.id);
    if (idx === -1) return { status: 404, error: 'Usuário não encontrado' };
    users[idx].passwordHash = bcrypt.hashSync(String(newPassword), BCRYPT_ROUNDS);
    writeJSON('users.json', users);
    return { ok: true };
  });
  if (result.error) return res.status(result.status).json({ error: result.error });
  res.json({ ok: true });
});

// Backup completo (admin) — baixa um JSON com todos os dados.
app.get('/api/admin/export', requireAuth, requireRole('admin'), (req, res) => {
  const payload = {
    exportedAt: new Date().toISOString(),
    exportedBy: req.user.username,
    data: {
      users: readJSON('users.json'),
      characters: readJSON('characters.json'),
      logs: readJSON('logs.json'),
      settings: readJSON('settings.json', {}),
    },
  };
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="genus-praxis-export-${stamp}.json"`);
  res.send(JSON.stringify(payload, null, 2));
});

// =====================================================================
// PERSONAGENS DA SIMULAÇÃO
// =====================================================================
// O cliente (não-admin) recebe só metadados de exibição; specificInstruction e
// evaluationCriteria (gabarito) NUNCA vão pro cliente — são resolvidos server-side
// em /api/chat e /api/evaluate.
function publicCharacter(c) {
  const { specificInstruction, evaluationCriteria, ...safe } = c;
  return safe;
}
const CHARACTER_FIELDS = ['name', 'age', 'description', 'specificInstruction', 'evaluationCriteria'];
function pickFields(body, fields) {
  const out = {};
  for (const f of fields) if (body && Object.prototype.hasOwnProperty.call(body, f)) out[f] = body[f];
  return out;
}

app.get('/api/characters', requireAuth, (req, res) => {
  const list = readJSON('characters.json');
  res.json(list.map((c) => (isAdmin(req.user) ? c : publicCharacter(c))));
});

app.post('/api/characters', requireAuth, requireRole('admin'), async (req, res) => {
  const c = await withFileLock('characters.json', () => {
    const chars = readJSON('characters.json');
    const created = { id: 'ch' + Date.now() + '-' + crypto.randomBytes(3).toString('hex'), ...pickFields(req.body, CHARACTER_FIELDS) };
    chars.push(created);
    writeJSON('characters.json', chars);
    return created;
  });
  res.json(c);
});

app.put('/api/characters/:id', requireAuth, requireRole('admin'), async (req, res) => {
  const result = await withFileLock('characters.json', () => {
    const chars = readJSON('characters.json');
    const idx = chars.findIndex((c) => c.id === req.params.id);
    if (idx === -1) return { status: 404, error: 'Personagem não encontrado' };
    chars[idx] = { ...chars[idx], ...pickFields(req.body, CHARACTER_FIELDS) };
    writeJSON('characters.json', chars);
    return { char: chars[idx] };
  });
  if (result.error) return res.status(result.status).json({ error: result.error });
  res.json(result.char);
});

// IDs de personagem são gerados no servidor (ch<ts>-<hex>), mas validamos antes
// de qualquer operação de arquivo para blindar contra path traversal.
function isSafeId(id) { return typeof id === 'string' && /^[a-zA-Z0-9_-]+$/.test(id); }
function removePatientPhotoFiles(id) {
  if (!isSafeId(id)) return;
  for (const suf of ['-icon.jpg', '-full.jpg']) {
    try {
      const p = path.join(PATIENT_PHOTOS_DIR, id + suf);
      if (fs.existsSync(p)) fs.unlinkSync(p);
    } catch {}
  }
}

app.delete('/api/characters/:id', requireAuth, requireRole('admin'), async (req, res) => {
  await withFileLock('characters.json', () => {
    const chars = readJSON('characters.json').filter((c) => c.id !== req.params.id);
    writeJSON('characters.json', chars);
  });
  removePatientPhotoFiles(req.params.id);
  res.json({ ok: true });
});

// data:image/jpeg;base64,XXXX → Buffer (só imagem).
function decodeImageDataUrl(s) {
  if (typeof s !== 'string') return null;
  const m = s.match(/^data:image\/(?:jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/);
  if (!m) return null;
  try { return Buffer.from(m[1], 'base64'); } catch { return null; }
}

app.put('/api/characters/:id/photo', requireAuth, requireRole('admin'), writeLimiter, async (req, res) => {
  const result = await withFileLock('characters.json', () => {
    const chars = readJSON('characters.json');
    const idx = chars.findIndex((c) => c.id === req.params.id);
    if (idx === -1) return { status: 404, error: 'Personagem não encontrado' };

    if (req.body && req.body.clear) {
      removePatientPhotoFiles(req.params.id);
      delete chars[idx].photoIcon;
      delete chars[idx].photoFull;
      writeJSON('characters.json', chars);
      return { char: chars[idx] };
    }
    const icon = decodeImageDataUrl(req.body && req.body.icon);
    const full = decodeImageDataUrl(req.body && req.body.full);
    if (!icon || !full) return { status: 400, error: 'Envie a foto (icon e full) como data URL de imagem.' };
    const MAX = 6 * 1024 * 1024;
    if (icon.length > MAX || full.length > MAX) return { status: 413, error: 'Imagem muito grande.' };
    if (!isSafeId(req.params.id)) return { status: 400, error: 'ID inválido.' };
    try {
      fs.writeFileSync(path.join(PATIENT_PHOTOS_DIR, `${req.params.id}-icon.jpg`), icon);
      fs.writeFileSync(path.join(PATIENT_PHOTOS_DIR, `${req.params.id}-full.jpg`), full);
    } catch (err) {
      return { status: 500, error: 'Erro ao gravar a foto: ' + err.message };
    }
    const v = Date.now();
    chars[idx].photoIcon = `/patient-photos/${req.params.id}-icon.jpg?v=${v}`;
    chars[idx].photoFull = `/patient-photos/${req.params.id}-full.jpg?v=${v}`;
    writeJSON('characters.json', chars);
    return { char: chars[idx] };
  });
  if (result.error) return res.status(result.status).json({ error: result.error });
  res.json(result.char);
});

// =====================================================================
// LOGS
// =====================================================================
const LOG_TTL_DAYS = 30;
const LOG_TTL_MS = LOG_TTL_DAYS * 24 * 60 * 60 * 1000;
const LOG_MAX_MESSAGES = 500;
const LOG_MAX_MESSAGE_LEN = 20000;
const LOG_MAX_EVAL_LEN = 50000;
const LOG_MAX_TITLE = 200;

function clampStr(v, max) { return v == null ? '' : String(v).slice(0, max); }
function logExpiresAt(log) {
  const t = new Date(log.timestamp || 0).getTime();
  if (!Number.isFinite(t) || t === 0) return null;
  return new Date(t + LOG_TTL_MS).toISOString();
}
function pruneExpiredLogs() {
  let logs;
  try { logs = readJSON('logs.json'); } catch { return 0; }
  if (!Array.isArray(logs) || logs.length === 0) return 0;
  const cutoff = Date.now() - LOG_TTL_MS;
  const kept = logs.filter((l) => {
    const t = new Date(l.timestamp || 0).getTime();
    if (!Number.isFinite(t) || t === 0) return true;
    return t >= cutoff;
  });
  if (kept.length === logs.length) return 0;
  writeJSON('logs.json', kept);
  return logs.length - kept.length;
}
function decorateLogs(arr) { return arr.map((l) => ({ ...l, expiresAt: logExpiresAt(l) })); }

app.get('/api/logs', requireAuth, (req, res) => {
  pruneExpiredLogs();
  const logs = readJSON('logs.json');
  // criteriaScores é só para professor/admin (o aluno não recebe o gabarito de notas).
  const serve = (arr) => {
    const decorated = decorateLogs(arr);
    if (canSeeAllLogs(req.user)) return decorated;
    return decorated.map(({ criteriaScores, ...rest }) => rest);
  };
  // Aluno: só os próprios.
  if (req.user.role === 'therapist') {
    return res.json(serve(logs.filter((l) => l.userId === req.user.id)));
  }
  // Filtro por userId específico (admin/professor abrindo um aluno).
  if (req.query.userId) {
    return res.json(serve(logs.filter((l) => l.userId === req.query.userId)));
  }
  // Professor e admin: todos os logs.
  res.json(serve(logs));
});

app.get('/api/logs/policy', requireAuth, (req, res) => res.json({ ttlDays: LOG_TTL_DAYS }));

app.post('/api/logs', requireAuth, writeLimiter, async (req, res) => {
  const body = req.body || {};
  const rawMessages = Array.isArray(body.messages) ? body.messages : [];
  if (rawMessages.length > LOG_MAX_MESSAGES) return res.status(400).json({ error: `messages excede limite de ${LOG_MAX_MESSAGES}` });
  const cleanMessages = rawMessages.map((m) => ({
    role: m && (m.role === 'user' || m.role === 'assistant') ? m.role : 'user',
    content: clampStr(m && m.content, LOG_MAX_MESSAGE_LEN),
    highlighted: !!(m && m.highlighted),
    comment: clampStr(m && m.comment, 2000),
  }));

  const explicitCriteria = (body.criteriaScores && typeof body.criteriaScores === 'object') ? body.criteriaScores : null;
  let finalScore = Number.isFinite(body.score) ? Number(body.score) : null;
  if (explicitCriteria && finalScore === null) {
    const computed = finalScoreFromCriteria(explicitCriteria);
    if (computed !== null) finalScore = computed;
  }

  const log = {
    id: 'log' + Date.now() + '-' + crypto.randomBytes(3).toString('hex'),
    timestamp: new Date().toISOString(),
    type: 'simulacao',
    itemId: clampStr(body.itemId, 200),
    itemTitle: clampStr(body.itemTitle, LOG_MAX_TITLE),
    durationSeconds: Number.isFinite(body.durationSeconds) ? Math.max(0, Math.floor(body.durationSeconds)) : 0,
    sessionCount: Number.isFinite(body.sessionCount) ? Math.max(1, Math.floor(body.sessionCount)) : 1,
    score: finalScore,
    criteriaScores: explicitCriteria || null,
    evaluation: clampStr(body.evaluation, LOG_MAX_EVAL_LEN),
    messages: cleanMessages,
    userId: req.user.id,
    userName: req.user.name,
  };
  await withFileLock('logs.json', () => {
    const logs = readJSON('logs.json');
    logs.push(log);
    writeJSON('logs.json', logs);
  });
  res.json({ ...log, expiresAt: logExpiresAt(log) });
});

app.delete('/api/logs/:id', requireAuth, requireRole('admin'), async (req, res) => {
  await withFileLock('logs.json', () => {
    const logs = readJSON('logs.json').filter((l) => l.id !== req.params.id);
    writeJSON('logs.json', logs);
  });
  res.json({ ok: true });
});

// =====================================================================
// SESSÕES ATIVAS (persistência de sessão não finalizada)
// =====================================================================
const VALID_SESSION_TYPES = ['simulacao'];
function activeSessionKey(userId, type, itemId) { return `${userId}__${type}__${itemId}`; }
function readActiveSessions() { return readJSON('active-sessions.json', {}); }

app.get('/api/active-sessions', requireAuth, (req, res) => {
  const all = readActiveSessions();
  res.json(Object.values(all).filter((s) => s.userId === req.user.id));
});
app.get('/api/active-sessions/:type/:itemId', requireAuth, (req, res) => {
  const { type, itemId } = req.params;
  if (!VALID_SESSION_TYPES.includes(type)) return res.status(400).json({ error: 'Tipo de sessão inválido' });
  const all = readActiveSessions();
  res.json(all[activeSessionKey(req.user.id, type, itemId)] || null);
});
app.put('/api/active-sessions/:type/:itemId', requireAuth, async (req, res) => {
  const { type, itemId } = req.params;
  if (!VALID_SESSION_TYPES.includes(type)) return res.status(400).json({ error: 'Tipo de sessão inválido' });
  const body = req.body || {};
  const saved = await withFileLock('active-sessions.json', () => {
    const all = readActiveSessions();
    const key = activeSessionKey(req.user.id, type, itemId);
    all[key] = {
      userId: req.user.id, type, itemId,
      messages: Array.isArray(body.messages) ? body.messages : [],
      elapsedSeconds: Number.isFinite(body.elapsedSeconds) ? Math.max(0, Math.floor(body.elapsedSeconds)) : 0,
      itemTitle: body.itemTitle || '',
      sessionNumber: Number.isFinite(body.sessionNumber) ? body.sessionNumber : 1,
      lastSavedAt: new Date().toISOString(),
    };
    writeJSON('active-sessions.json', all);
    return all[key];
  });
  res.json(saved);
});
app.delete('/api/active-sessions/:type/:itemId', requireAuth, async (req, res) => {
  const { type, itemId } = req.params;
  if (!VALID_SESSION_TYPES.includes(type)) return res.status(400).json({ error: 'Tipo de sessão inválido' });
  await withFileLock('active-sessions.json', () => {
    const all = readActiveSessions();
    const key = activeSessionKey(req.user.id, type, itemId);
    if (key in all) { delete all[key]; writeJSON('active-sessions.json', all); }
  });
  res.json({ ok: true });
});

// =====================================================================
// IA — SIMULAÇÃO (paciente), AVALIAÇÃO (estrutura pronta) e WHISPER
// =====================================================================
const PATIENT_MODEL = process.env.OPENAI_PATIENT_MODEL || 'gpt-4o-mini';
const PATIENT_EFFORT = process.env.OPENAI_PATIENT_EFFORT || 'none';
const EVAL_MODEL = process.env.OPENAI_EVAL_MODEL || 'gpt-4o';
const WHISPER_MODEL = process.env.OPENAI_WHISPER_MODEL || 'whisper-1';

function getOpenAI() {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;
  const OpenAI = require('openai').OpenAI || require('openai').default || require('openai');
  return new OpenAI({ apiKey });
}
// Modelos de reasoning (o-series / gpt-5.x) usam max_completion_tokens e não
// aceitam temperature; os demais (gpt-4o etc.) usam max_tokens. Detecta pelo nome.
function isReasoningModel(model) {
  return /^(o\d|gpt-5)/i.test(String(model || ''));
}
async function openaiChat({ openai, model, systemPrompt, messages, maxTokens, effort }) {
  const turns = (messages || [])
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant'))
    .map((m) => ({ role: m.role, content: typeof m.content === 'string' ? m.content : String(m.content || '') }))
    .filter((m) => m.content);
  const params = { model, messages: [{ role: 'system', content: systemPrompt }, ...turns] };
  if (isReasoningModel(model)) {
    params.max_completion_tokens = maxTokens;
    if (effort && effort !== 'none') params.reasoning_effort = effort;
  } else {
    params.max_tokens = maxTokens;
    params.temperature = 0.8;
  }
  const resp = await openai.chat.completions.create(params);
  return resp.choices?.[0]?.message?.content || '';
}

// Resolve o system prompt do paciente server-side (nunca confia no cliente).
function resolveSimulationPrompt(itemId) {
  const c = readJSON('characters.json').find((x) => String(x.id) === String(itemId));
  if (!c) return { status: 404, error: 'Personagem não encontrado' };
  return { systemPrompt: buildSimulationPrompt(c.specificInstruction), character: c };
}

app.post('/api/chat', requireAuth, aiLimiter, async (req, res) => {
  const { messages, context } = req.body || {};
  if (!context || typeof context !== 'object' || !context.itemId) {
    return res.status(400).json({ error: 'context é obrigatório (type + itemId)' });
  }
  if (!Array.isArray(messages)) return res.status(400).json({ error: 'messages deve ser uma lista' });

  const resolved = resolveSimulationPrompt(context.itemId);
  if (resolved.error) return res.status(resolved.status).json({ error: resolved.error });

  const openai = getOpenAI();
  if (!openai) {
    return res.json({ role: 'assistant', content: '[Modo demonstração — OPENAI_API_KEY não configurada] Olá, obrigado por me receber. Podemos começar quando você quiser.' });
  }
  const validTurns = (messages || []).filter((m) => m && (m.role === 'user' || m.role === 'assistant') && (typeof m.content === 'string' ? m.content : String(m.content || '')));
  if (!validTurns.length) return res.status(400).json({ error: 'messages não contém turnos válidos (user/assistant)' });

  try {
    const content = await openaiChat({ openai, model: PATIENT_MODEL, systemPrompt: resolved.systemPrompt, messages, maxTokens: 1200, effort: PATIENT_EFFORT });
    res.json({ role: 'assistant', content });
  } catch (err) {
    console.error('OpenAI paciente error:', err.message);
    res.status(500).json({ error: 'Erro ao comunicar com a IA: ' + err.message });
  }
});

// --- AVALIAÇÃO (estrutura pronta; DESLIGADA por padrão) ---
// Quando quiser ligar o avaliador:
//   1. defina EVALUATOR_ENABLED=true (ou ligue pela tela de Contas),
//   2. coloque o prompt em server/avaliacao/avaliador.md,
//   3. escolha OPENAI_EVAL_MODEL.
// O fluxo de log (POST /api/logs) e o contexto do gabarito (evaluationCriteria,
// injetado server-side) já estão prontos — nada mais precisa mudar no cliente.
const AVALIACAO_DIR = path.join(__dirname, 'avaliacao');
function loadEvaluatorPrompt() {
  const p = path.join(AVALIACAO_DIR, 'avaliador.md');
  if (!fs.existsSync(p)) return null;
  return fs.readFileSync(p, 'utf-8');
}
function evaluatorEnabled() {
  const s = readJSON('settings.json', {});
  return !!s.evaluatorEnabled;
}
function resolveEvaluationCriteria(itemId) {
  const c = readJSON('characters.json').find((x) => String(x.id) === String(itemId));
  return c && c.evaluationCriteria && String(c.evaluationCriteria).trim() ? String(c.evaluationCriteria).trim() : '';
}

app.post('/api/evaluate', requireAuth, aiLimiter, async (req, res) => {
  const { messages, context } = req.body || {};
  if (!Array.isArray(messages)) return res.status(400).json({ error: 'messages deve ser uma lista' });
  if (!evaluatorEnabled()) {
    // Estrutura pronta, avaliador desligado — o cliente encerra com o
    // agradecimento e o log é salvo para análise humana.
    return res.json({ role: 'assistant', content: '', disabled: true });
  }
  const openai = getOpenAI();
  if (!openai) return res.status(503).json({ error: 'Avaliação indisponível: OPENAI_API_KEY não configurada.' });
  const systemPrompt = loadEvaluatorPrompt();
  if (!systemPrompt) return res.status(500).json({ error: 'Avaliação ligada mas o prompt do avaliador não foi configurado (server/avaliacao/avaliador.md).' });

  // Injeta o gabarito (evaluationCriteria) ANTES do log, server-side.
  let finalMessages = messages;
  if (context && context.itemId) {
    const gabarito = resolveEvaluationCriteria(context.itemId);
    if (gabarito) {
      const idx = messages.findIndex((m) => m && m.role === 'user');
      if (idx !== -1) {
        const prefix = `[GABARITO DO CASO] (critério de correção — não revelar ao aluno)\n${gabarito}\n\n---\n\n`;
        finalMessages = [...messages.slice(0, idx), { ...messages[idx], content: prefix + (messages[idx].content || '') }, ...messages.slice(idx + 1)];
      }
    }
  }
  try {
    const content = await openaiChat({ openai, model: EVAL_MODEL, systemPrompt, messages: finalMessages, maxTokens: 4000, effort: process.env.OPENAI_EVAL_EFFORT || 'medium' });
    res.json({ role: 'assistant', content });
  } catch (err) {
    console.error('OpenAI avaliador error:', err.message);
    res.status(500).json({ error: 'Erro ao avaliar a sessão: ' + err.message });
  }
});

// --- WHISPER (transcrição de áudio) ---
app.post('/api/transcribe', requireAuth, aiLimiter, async (req, res) => {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return res.json({ text: '[Transcrição indisponível sem OPENAI_API_KEY]' });
  const tmpFile = path.join(DATA_DIR, `tmp_audio_${Date.now()}_${crypto.randomBytes(4).toString('hex')}.webm`);
  try {
    const OpenAI = require('openai').OpenAI || require('openai').default || require('openai');
    const openai = new OpenAI({ apiKey });
    const buffer = Buffer.from(req.body.audio || '', 'base64');
    fs.writeFileSync(tmpFile, buffer);
    const transcription = await openai.audio.transcriptions.create({
      file: fs.createReadStream(tmpFile),
      model: WHISPER_MODEL,
      language: 'pt',
    });
    res.json({ text: transcription.text });
  } catch (err) {
    console.error('Transcription error:', err.message);
    res.status(500).json({ error: 'Erro na transcrição' });
  } finally {
    try { if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile); } catch {}
  }
});

// =====================================================================
// CONFIGURAÇÕES
// =====================================================================
app.get('/api/settings', requireAuth, (req, res) => {
  const s = readJSON('settings.json', {});
  res.json({ evaluatorEnabled: !!s.evaluatorEnabled });
});
app.put('/api/admin/settings', requireAuth, requireRole('admin'), async (req, res) => {
  const saved = await withFileLock('settings.json', () => {
    const s = readJSON('settings.json', {});
    if ('evaluatorEnabled' in (req.body || {})) s.evaluatorEnabled = !!req.body.evaluatorEnabled;
    writeJSON('settings.json', s);
    return s;
  });
  res.json({ evaluatorEnabled: !!saved.evaluatorEnabled });
});

// =====================================================================
// SERVIR O FRONT (build do React) + fallback SPA
// =====================================================================
const clientDist = path.join(__dirname, '..', 'client', 'dist');
if (fs.existsSync(clientDist)) {
  app.use(express.static(clientDist));
  app.get('*', (req, res) => {
    if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Rota não encontrada' });
    res.sendFile(path.join(clientDist, 'index.html'));
  });
}

if (require.main === module) {
  const removed = pruneExpiredLogs();
  if (removed > 0) console.log(`[logs] ${removed} log(s) expirado(s) removido(s) no boot.`);
  const PORT = process.env.PORT || 3001;
  app.listen(PORT, () => console.log(`Servidor Genus Práxis rodando na porta ${PORT}`));
}

module.exports = app;
