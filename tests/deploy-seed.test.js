// Boot de DEPLOY — o cenário do Railway, que o harness normal nunca exercita (ele sempre
// injeta usuários de teste). Aqui subimos processos reais com volume VAZIO e envs
// diferentes, e olhamos o users.json que nasce.
//
// Isto protege o pior acidente possível: subir em produção com `admin/admin123`.
require('./helpers');

const fs = require('fs');
const os = require('os');
const path = require('path');
const bcrypt = require('bcryptjs');
const { execFileSync } = require('child_process');

// Sobe o app num volume vazio novo, com as envs dadas, e devolve o users.json resultante.
// `throwOnExit` deixa capturar o caso em que o boot ABORTA de propósito (senha curta).
function bootFresh(env = {}, { expectExit = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'genus-deploy-'));
  const base = {
    ...process.env,
    DATA_DIR: dir,
    JWT_SECRET: 'x'.repeat(48),
    OPENAI_API_KEY: '',
    NODE_ENV: 'test',
    // Limpa qualquer ADMIN_* herdado do .env do dev, senão o teste não isola nada.
    ADMIN_INITIAL_USERNAME: '',
    ADMIN_INITIAL_PASSWORD: '',
    ...env,
  };
  let threw = false;
  try {
    execFileSync(process.execPath, ['-e', "require('./server/index.js')"], {
      cwd: path.join(__dirname, '..'), env: base, stdio: 'pipe',
    });
  } catch {
    threw = true;
  }
  const usersPath = path.join(dir, 'users.json');
  const users = fs.existsSync(usersPath) ? JSON.parse(fs.readFileSync(usersPath, 'utf8')) : null;
  if (expectExit) return { threw, users };
  expect(threw, 'o boot não devia ter abortado').toBe(false);
  return users;
}

describe('boot de deploy: o admin seguro do Railway', () => {
  // O CAMINHO QUE O USUÁRIO VAI USAR: definir usuário + senha fortes no .env do Railway.
  it('com ADMIN_INITIAL_PASSWORD → cria SÓ um admin, com o usuário e a senha dados', () => {
    const users = bootFresh({
      ADMIN_INITIAL_USERNAME: 'chefe_supremo',
      ADMIN_INITIAL_PASSWORD: 'S3nh4-mui-t0-f0rte',
    });

    // Um único usuário. NENHUMA conta de demonstração.
    expect(users.length).toBe(1);
    const admin = users[0];
    expect(admin.role).toBe('admin');
    expect(admin.username).toBe('chefe_supremo');
    // A senha foi hasheada (nunca guardada em texto) e é a que ele definiu.
    expect(admin.passwordHash).toBeTruthy();
    expect(bcrypt.compareSync('S3nh4-mui-t0-f0rte', admin.passwordHash)).toBe(true);
    // E a senha de demonstração NÃO funciona.
    expect(bcrypt.compareSync('admin123', admin.passwordHash)).toBe(false);
  });

  it('sem ADMIN_INITIAL_USERNAME → o usuário do admin é "admin", mas a senha é a forte', () => {
    const users = bootFresh({ ADMIN_INITIAL_PASSWORD: 'outra-senha-forte' });
    expect(users.length).toBe(1);
    expect(users[0].username).toBe('admin');
    expect(bcrypt.compareSync('outra-senha-forte', users[0].passwordHash)).toBe(true);
  });

  // A rede de proteção contra o acidente clássico: senha curta ABORTA o boot em vez de
  // cair no modo demonstração (que criaria admin/admin123).
  it('ADMIN_INITIAL_PASSWORD curta (< 8) → o boot ABORTA, não cria nada', () => {
    const { threw, users } = bootFresh({ ADMIN_INITIAL_PASSWORD: 'curta' }, { expectExit: true });
    expect(threw).toBe(true);
    // Não deixou um users.json meia-boca para trás.
    expect(users === null || users.length === 0).toBe(true);
  });
});

describe('boot de desenvolvimento: as contas de demonstração', () => {
  // Sem ADMIN_INITIAL_PASSWORD é o modo DEV — e é aqui que o admin123 pode aparecer. Este
  // teste documenta que ele SÓ aparece sem a env, para ninguém confundir os dois mundos.
  it('sem ADMIN_INITIAL_PASSWORD → cria as contas de demonstração (admin/supervisor/aluno)', () => {
    const users = bootFresh();
    const nomes = users.map((u) => u.username).sort();
    expect(nomes).toEqual(['aluno', 'admin', 'supervisor'].sort());
    // admin123 vale AQUI — e só aqui.
    const admin = users.find((u) => u.username === 'admin');
    expect(bcrypt.compareSync('admin123', admin.passwordHash)).toBe(true);
  });
});

describe('o volume sobrevive: dados antigos permanecem entre deploys', () => {
  // Simula "subir código novo sobre um volume que já tem dados": o boot NÃO deve recriar
  // o admin nem apagar os usuários existentes.
  it('users.json que já existe NÃO é sobrescrito (nem pela env de admin)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'genus-deploy2-'));
    const existente = [
      { id: '1', username: 'admin_real', passwordHash: bcrypt.hashSync('a-senha-de-producao', 4), name: 'Chefe', role: 'admin', teacherId: null, email: '', profilePhoto: '' },
      { id: '9', username: 'maria', passwordHash: bcrypt.hashSync('maria12345', 4), name: 'Maria', role: 'therapist', teacherId: null, email: '', profilePhoto: '' },
    ];
    fs.writeFileSync(path.join(dir, 'users.json'), JSON.stringify(existente));

    // Novo deploy, com uma env de admin DIFERENTE — não deve valer nada.
    execFileSync(process.execPath, ['-e', "require('./server/index.js')"], {
      cwd: path.join(__dirname, '..'),
      env: {
        ...process.env, DATA_DIR: dir, JWT_SECRET: 'x'.repeat(48), OPENAI_API_KEY: '', NODE_ENV: 'test',
        ADMIN_INITIAL_USERNAME: 'invasor', ADMIN_INITIAL_PASSWORD: 'tentando-invadir-123',
      },
      stdio: 'pipe',
    });

    const users = JSON.parse(fs.readFileSync(path.join(dir, 'users.json'), 'utf8'));
    // Os dois continuam lá, intactos. A env de admin foi ignorada (o volume já tinha dados).
    expect(users.map((u) => u.username).sort()).toEqual(['admin_real', 'maria']);
    expect(users.find((u) => u.username === 'invasor')).toBeUndefined();
    // A senha de produção continua valendo; a do "invasor", não.
    const admin = users.find((u) => u.username === 'admin_real');
    expect(bcrypt.compareSync('a-senha-de-producao', admin.passwordHash)).toBe(true);
  });
});
