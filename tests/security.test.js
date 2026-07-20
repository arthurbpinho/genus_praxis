// tests/security.test.js — regressão de segurança: vazamento, IDOR, escalonamento
// de papel, deny-by-default nos logs, exclusões de visitante.
const {
  app, request,
  resetData,
  readData, writeData,
  loginAs, loginVisitor, loginVisitorFull,
  authHeader,
  makeLog,
  SECRETS,
} = require('./helpers');

beforeEach(() => resetData());

// =====================================================================
// 1. VAZAMENTO DE PROMPT / GABARITO
// =====================================================================
describe('vazamento de prompt/gabarito nos personagens', () => {
  it('GET /api/exercises como aluno NÃO vaza specificInstruction nem evaluatorPrompt', async () => {
    const token = await loginAs('aluno');
    const res = await request(app).get('/api/exercises').set(authHeader(token));
    expect(res.status).toBe(200);
    const body = JSON.stringify(res.body);
    expect(body).not.toContain(SECRETS.exercise);
    expect(body).not.toContain(SECRETS.evaluator);
    expect(body).not.toContain('OUTRO_PROMPT_SECRETO');
    expect(body).not.toContain('TERCEIRO_PROMPT_SECRETO');
    // a descrição pública DEVE aparecer (senão escondemos demais)
    expect(body).toContain('Desc pública');
  });

  it('GET /api/exercises como visitante NÃO vaza segredos', async () => {
    const token = await loginVisitor();
    const res = await request(app).get('/api/exercises').set(authHeader(token));
    expect(res.status).toBe(200);
    const body = JSON.stringify(res.body);
    expect(body).not.toContain(SECRETS.exercise);
    expect(body).not.toContain(SECRETS.evaluator);
  });

  it('GET /api/freeplay como aluno NÃO vaza specificInstruction nem evaluationCriteria', async () => {
    const token = await loginAs('aluno');
    const res = await request(app).get('/api/freeplay').set(authHeader(token));
    expect(res.status).toBe(200);
    const body = JSON.stringify(res.body);
    expect(body).not.toContain(SECRETS.freeplay);
    expect(body).not.toContain(SECRETS.gabarito);
    expect(body).not.toContain('FP2_PROMPT_SECRETO');
    expect(body).not.toContain('GABARITO_2_SECRETO');
  });

  it('GET /api/freeplay como visitante NÃO vaza segredos', async () => {
    const token = await loginVisitor();
    const res = await request(app).get('/api/freeplay').set(authHeader(token));
    expect(res.status).toBe(200);
    const body = JSON.stringify(res.body);
    expect(body).not.toContain(SECRETS.freeplay);
    expect(body).not.toContain(SECRETS.gabarito);
  });

  it('como ADMIN os campos secretos DEVEM aparecer (CRUD do admin)', async () => {
    const token = await loginAs('admin');
    const ex = await request(app).get('/api/exercises').set(authHeader(token));
    const fp = await request(app).get('/api/freeplay').set(authHeader(token));
    expect(JSON.stringify(ex.body)).toContain(SECRETS.exercise);
    expect(JSON.stringify(ex.body)).toContain(SECRETS.evaluator);
    expect(JSON.stringify(fp.body)).toContain(SECRETS.freeplay);
    expect(JSON.stringify(fp.body)).toContain(SECRETS.gabarito);
  });

  it('professor também NÃO recebe os gabaritos (não é admin)', async () => {
    const token = await loginAs('prof');
    const ex = await request(app).get('/api/exercises').set(authHeader(token));
    const fp = await request(app).get('/api/freeplay').set(authHeader(token));
    expect(JSON.stringify(ex.body)).not.toContain(SECRETS.exercise);
    expect(JSON.stringify(fp.body)).not.toContain(SECRETS.gabarito);
  });
});

// =====================================================================
// 2. IDOR — recurso de outro usuário
// =====================================================================
describe('IDOR — GET/PUT /api/users/:id', () => {
  it('aluno(3) lendo o perfil do aluno2(5) → 403', async () => {
    const token = await loginAs('aluno');
    const res = await request(app).get('/api/users/5').set(authHeader(token));
    expect(res.status).toBe(403);
  });

  it('aluno lê o próprio perfil → 200', async () => {
    const token = await loginAs('aluno');
    const res = await request(app).get('/api/users/3').set(authHeader(token));
    expect(res.status).toBe(200);
    expect(res.body.username).toBe('aluno');
  });

  it('admin lê qualquer perfil → 200', async () => {
    const token = await loginAs('admin');
    const res = await request(app).get('/api/users/5').set(authHeader(token));
    expect(res.status).toBe(200);
  });

  it('professor lê perfil do próprio aluno, não do aluno de outro prof', async () => {
    const token = await loginAs('prof'); // prof de aluno(3)
    const meu = await request(app).get('/api/users/3').set(authHeader(token));
    const alheio = await request(app).get('/api/users/5').set(authHeader(token));
    expect(meu.status).toBe(200);
    expect(alheio.status).toBe(403);
  });

  it('aluno(3) tentando ESCREVER no perfil do aluno2(5) → 403', async () => {
    const token = await loginAs('aluno');
    const res = await request(app).put('/api/users/5').set(authHeader(token)).send({ name: 'Hackeado' });
    expect(res.status).toBe(403);
    expect(readData('users.json').find((u) => u.id === '5').name).not.toBe('Hackeado');
  });

  it('professor NÃO escreve no perfil do aluno (só admin/próprio) → 403', async () => {
    // canAccessUser deixaria ler, mas o PUT exige id próprio ou admin.
    const token = await loginAs('prof');
    const res = await request(app).put('/api/users/3').set(authHeader(token)).send({ name: 'X' });
    expect(res.status).toBe(403);
  });
});

// A autorização "feliz" desta rota (dono lê, admin lê qualquer um, POST faz merge) vive
// em crud.test.js — é semântica de rota. Aqui ficam só os testes que conferem o DISCO:
// um 403 que ainda assim gravasse o arquivo seria um vazamento silencioso, e o status
// sozinho não pegaria isso.
describe('IDOR — GET/POST /api/progress/:userId (efeito no disco)', () => {
  it('aluno(3) lendo progresso do aluno2(5) → 403', async () => {
    const token = await loginAs('aluno');
    const res = await request(app).get('/api/progress/5').set(authHeader(token));
    expect(res.status).toBe(403);
  });

  it('aluno(3) escrevendo progresso do aluno2(5) → 403 e NADA é gravado', async () => {
    writeData('progress.json', { '5': { 'ex-test-2': true } });
    const token = await loginAs('aluno');
    const res = await request(app).post('/api/progress/5').set(authHeader(token)).send({ 'ex-test-1': true });
    expect(res.status).toBe(403);
    // O progresso do alvo continua exatamente como estava — sem a chave injetada.
    expect(readData('progress.json')['5']).toEqual({ 'ex-test-2': true });
  });
});

describe('IDOR — GET /api/gamification/:userId', () => {
  it('aluno(3) lendo gamificação do aluno2(5) → 403', async () => {
    const token = await loginAs('aluno');
    const res = await request(app).get('/api/gamification/5').set(authHeader(token));
    expect(res.status).toBe(403);
  });

  it('aluno lê a própria gamificação → 200', async () => {
    const token = await loginAs('aluno');
    const res = await request(app).get('/api/gamification/3').set(authHeader(token));
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('achievements');
  });

  it('professor lê a do aluno de OUTRO prof → 403', async () => {
    const token = await loginAs('prof');
    const res = await request(app).get('/api/gamification/5').set(authHeader(token));
    expect(res.status).toBe(403);
  });
});

// =====================================================================
// 2b. ESCALONAMENTO via PUT /api/users/:id — allowlist
// =====================================================================
describe('PUT /api/users/:id — allowlist bloqueia escalonamento de privilégio', () => {
  it('aluno tentando virar admin (role no body) → o role NÃO muda', async () => {
    const token = await loginAs('aluno');
    const res = await request(app).put('/api/users/3').set(authHeader(token)).send({
      name: 'Aluno A', role: 'admin', passwordHash: 'x', activeTitle: 'y', id: '1',
    });
    expect(res.status).toBe(200); // request aceita, mas ignora os campos proibidos
    const u = readData('users.json').find((x) => x.id === '3');
    expect(u.role).toBe('therapist');
    expect(u.passwordHash).not.toBe('x');
    expect(u.activeTitle).toBeUndefined();
    expect(u.id).toBe('3');
    // o corpo devolvido também não pode expor a escalada
    expect(res.body.role).toBe('therapist');
  });

  it('campo proibido junto com um permitido: o permitido aplica, o proibido é ignorado', async () => {
    const token = await loginAs('aluno');
    const res = await request(app).put('/api/users/3').set(authHeader(token)).send({
      name: 'Nome Novo', role: 'admin', email: 'novo@x.com',
    });
    expect(res.status).toBe(200);
    const u = readData('users.json').find((x) => x.id === '3');
    expect(u.name).toBe('Nome Novo');    // permitido
    expect(u.email).toBe('novo@x.com');  // permitido
    expect(u.role).toBe('therapist');    // proibido → ignorado
  });

  it('aluno NÃO consegue setar activeTitle por essa rota', async () => {
    const token = await loginAs('aluno');
    await request(app).put('/api/users/3').set(authHeader(token)).send({ activeTitle: 'centena' });
    expect(readData('users.json').find((x) => x.id === '3').activeTitle).toBeUndefined();
  });
});

// =====================================================================
// 3. ESCALONAMENTO DE PAPEL — rotas admin-only
// =====================================================================
describe('rotas /api/admin/* exigem admin', () => {
  // Uma linha por rota, um teste por papel — em vez de 24 `it()` que só diziam "deu 403".
  //
  // A asserção é mais forte que a anterior: `requireFeature` (demanda #4) TAMBÉM responde
  // 403, com `{locked: true}`. Um erro de ordem de middleware faria a rota negar pelo
  // motivo errado, e o teste antigo não notaria. Aqui exigimos o 403 do PAPEL.
  const ROTAS = [
    ['get', '/api/admin/users'],
    ['post', '/api/admin/users'],
    ['put', '/api/admin/users/3'],
    ['delete', '/api/admin/users/3'],
    ['post', '/api/admin/users/3/reset-password'],
    ['get', '/api/admin/export'],
    ['put', '/api/admin/settings'],
    ['post', '/api/admin/ranking/reset'],
    // Rotas das demandas novas — nenhuma delas era coberta por este bloco.
    ['post', '/api/admin/skills'],
    ['put', '/api/admin/skills/1'],
    ['delete', '/api/admin/skills/1'],
    ['post', '/api/admin/skills/reorder'],
    ['get', '/api/admin/skills/orphans'],
    ['post', '/api/admin/users/3/visitor-access'],
  ];

  it.each([['aluno'], ['prof'], ['visitante']])('%s → 403 (por papel) em todas as rotas admin', async (papel) => {
    const token = papel === 'visitante' ? await loginVisitor() : await loginAs(papel);

    for (const [method, route] of ROTAS) {
      const res = await request(app)[method](route).set(authHeader(token)).send({});
      expect(res.status, `${method.toUpperCase()} ${route}`).toBe(403);
      // Negado pelo PAPEL, não pela matriz de features (que também dá 403).
      expect(res.body.locked, `${method.toUpperCase()} ${route}`).toBeUndefined();
    }
  });

  it('GET /api/admin/users como admin → 200', async () => {
    const token = await loginAs('admin');
    const res = await request(app).get('/api/admin/users').set(authHeader(token));
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  // O status 200 de GET /api/admin/export vive em settings.test.js, que também
  // confere o CONTEÚDO do backup. Um `expect(200)` solto aqui era ruído.
});

// O gate admin-only de `POST /api/chat mode:entrevistador` (403 p/ aluno, professor e
// visitante; 200 p/ admin, inclusive SEM `context`) vive em chat.test.js — lá é mais
// forte e fica junto do resto do contrato da rota. Aqui sobram os endpoints que só
// existem para o entrevistador.
describe('escalonamento — rotas do entrevistador são admin-only', () => {
  it('GET /api/entrevistador-prompt → 403 não-admin', async () => {
    for (const who of ['aluno', 'prof']) {
      const token = await loginAs(who);
      const res = await request(app).get('/api/entrevistador-prompt').set(authHeader(token));
      expect(res.status).toBe(403);
    }
    const vtoken = await loginVisitor();
    const vres = await request(app).get('/api/entrevistador-prompt').set(authHeader(vtoken));
    expect(vres.status).toBe(403);
  });

  it('POST /api/entrevistador/extract → 403 não-admin', async () => {
    const token = await loginAs('aluno');
    const res = await request(app).post('/api/entrevistador/extract').set(authHeader(token)).send({ text: 'x' });
    expect(res.status).toBe(403);
  });

  it('POST /api/entrevistador/character → 403 não-admin', async () => {
    const token = await loginAs('prof');
    const res = await request(app).post('/api/entrevistador/character').set(authHeader(token)).send({ name: 'X' });
    expect(res.status).toBe(403);
  });
});

// O anti prompt-injection (`systemPrompt` no body → 400, para aluno E admin) vive em
// chat.test.js, que cobre também `systemPrompt: ''` — o único caso que trava o guard no
// `hasOwnProperty` em vez de num teste de truthiness.

// =====================================================================
// 4. LOGS — deny-by-default
// =====================================================================
describe('GET /api/logs — deny-by-default', () => {
  // Monta logs de vários donos:
  //  aluno(3) do prof(2); aluno2(5) do prof2(4); prof(2) e prof2(4) têm log próprio;
  //  solo(6) é aluno SEM professor.
  //
  // O log do `solo` fecha um buraco real: o filtro do professor é
  // `users.filter(u => u.teacherId === req.user.id)`. Um bug clássico ali (comparar com
  // `!=` frouxo, ou aceitar `teacherId` nulo/undefined como "meu") entregaria os logs do
  // aluno órfão para QUALQUER professor — e sem um log dele no seed, nenhum teste veria.
  function seedLogs(extras = []) {
    writeData('logs.json', [
      makeLog({ id: 'log-a3', userId: '3', userName: 'Aluno A', criteriaScores: { '1': 8 }, score: 8 }),
      makeLog({ id: 'log-a5', userId: '5', userName: 'Aluno B', criteriaScores: { '1': 7 }, score: 7 }),
      makeLog({ id: 'log-p2', userId: '2', userName: 'Professor A' }),
      makeLog({ id: 'log-p4', userId: '4', userName: 'Professor B' }),
      makeLog({ id: 'log-s6', userId: '6', userName: 'Aluno Sem Prof' }),
      ...extras,
    ]);
  }

  // O teste antigo afirmava `length === 0` — mas o seed não tinha NENHUM log do
  // visitante, então ele passaria mesmo se a rota devolvesse `[]` para todo mundo.
  // Agora semeamos um log DELE: desde a demanda #2 o visitante tem permissões de aluno,
  // ou seja, precisa RECEBER o próprio log e NÃO os dos outros. As duas metades importam.
  it('VISITANTE vê o próprio log e SÓ ele (permissões de aluno, demanda #2)', async () => {
    const v = await loginVisitorFull();
    seedLogs([makeLog({ id: 'log-visit', userId: v.id, userName: v.user.name })]);

    const res = await request(app).get('/api/logs').set(authHeader(v.token));
    expect(res.status).toBe(200);
    expect(res.body.map((l) => l.id)).toEqual(['log-visit']);
    // E o gabarito de notas continua escondido dele (não é canSeeAllLogs).
    expect(res.body.every((l) => !('criteriaScores' in l))).toBe(true);
  });

  it('aluno(3) só vê os próprios logs', async () => {
    seedLogs();
    const token = await loginAs('aluno');
    const res = await request(app).get('/api/logs').set(authHeader(token));
    expect(res.status).toBe(200);
    expect(res.body.map((l) => l.userId).sort()).toEqual(['3']);
  });

  it('professor(2) vê os do seu aluno(3) e os próprios — NÃO os do aluno de outro prof nem os do aluno SEM prof', async () => {
    seedLogs();
    const token = await loginAs('prof');
    const res = await request(app).get('/api/logs').set(authHeader(token));
    const owners = [...new Set(res.body.map((l) => l.userId))].sort();
    expect(owners).toEqual(['2', '3']);
    expect(owners).not.toContain('5'); // aluno de outro professor
    expect(owners).not.toContain('6'); // aluno órfão: não é "de ninguém", logo não é dele
  });

  it('?userId=6 (aluno sem professor) como prof → 403', async () => {
    seedLogs();
    const token = await loginAs('prof');
    const res = await request(app).get('/api/logs?userId=6').set(authHeader(token));
    expect(res.status).toBe(403);
  });

  it('admin vê todos os logs', async () => {
    seedLogs();
    const token = await loginAs('admin');
    const res = await request(app).get('/api/logs').set(authHeader(token));
    const owners = [...new Set(res.body.map((l) => l.userId))].sort();
    expect(owners).toEqual(['2', '3', '4', '5', '6']);
  });

  it('?userId=5 como prof(2) → 403 (aluno de outro prof)', async () => {
    seedLogs();
    const token = await loginAs('prof');
    const res = await request(app).get('/api/logs?userId=5').set(authHeader(token));
    expect(res.status).toBe(403);
  });

  it('?userId=5 como prof2(4) → 200 (seu aluno)', async () => {
    seedLogs();
    const token = await loginAs('prof2');
    const res = await request(app).get('/api/logs?userId=5').set(authHeader(token));
    expect(res.status).toBe(200);
    expect(res.body.every((l) => l.userId === '5')).toBe(true);
  });

  it('?userId=5 como admin → 200', async () => {
    seedLogs();
    const token = await loginAs('admin');
    const res = await request(app).get('/api/logs?userId=5').set(authHeader(token));
    expect(res.status).toBe(200);
  });

  it('aluno NÃO consegue ler logs de outro via ?userId (cai no deny-by-default, vê só os próprios)', async () => {
    seedLogs();
    const token = await loginAs('aluno');
    const res = await request(app).get('/api/logs?userId=5').set(authHeader(token));
    // aluno não é canSeeAllLogs → o filtro por userId é ignorado, retorna só os dele.
    expect(res.status).toBe(200);
    expect(res.body.every((l) => l.userId === '3')).toBe(true);
  });

  it('criteriaScores some para aluno e visitante, aparece para prof/admin', async () => {
    seedLogs();
    const alunoTok = await loginAs('aluno');
    const alunoRes = await request(app).get('/api/logs').set(authHeader(alunoTok));
    expect(alunoRes.body.every((l) => !('criteriaScores' in l))).toBe(true);

    const profTok = await loginAs('prof');
    const profRes = await request(app).get('/api/logs').set(authHeader(profTok));
    const meuAluno = profRes.body.find((l) => l.userId === '3');
    expect(meuAluno).toHaveProperty('criteriaScores');

    const adminTok = await loginAs('admin');
    const adminRes = await request(app).get('/api/logs').set(authHeader(adminTok));
    expect(adminRes.body.find((l) => l.userId === '3')).toHaveProperty('criteriaScores');
  });
});

// =====================================================================
// 5. VISITANTE EXCLUÍDO
// =====================================================================
// A demanda #2 DERRUBOU as exclusões do visitante: ele agora tem as mesmas permissões
// de um aluno. O que sobrou de fronteira é a ARENA (D3/D9) — e é isso que travamos aqui.
// Os 403 antigos (ranking, duelo, título, MMR) foram removidos DE PROPÓSITO.
describe('visitante — permissões de aluno (demanda #2)', () => {
  it('GET /api/ranking → 200 (só que na arena dele)', async () => {
    const token = await loginVisitor();
    const res = await request(app).get('/api/ranking').set(authHeader(token));
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it('GET /api/me/mmr → MMR real, sem a flag `visitor` de fachada', async () => {
    const token = await loginVisitor();
    const res = await request(app).get('/api/me/mmr').set(authHeader(token));
    expect(res.status).toBe(200);
    expect(res.body.visitor).toBeUndefined();
  });

  it('GET /api/duel/opponents → 200', async () => {
    const token = await loginVisitor();
    const res = await request(app).get('/api/duel/opponents').set(authHeader(token));
    expect(res.status).toBe(200);
  });

  it('POST /api/duel (link) → cria', async () => {
    const token = await loginVisitor();
    const res = await request(app).post('/api/duel').set(authHeader(token))
      .send({ characterId: 'fp-test-1', inviteMethod: 'link' });
    expect(res.status).toBe(200);
  });

  it('GET /api/notifications → lista real (não mais o vazio de fachada)', async () => {
    const token = await loginVisitor();
    const res = await request(app).get('/api/notifications').set(authHeader(token));
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.items)).toBe(true);
  });

  it('POST /api/me/title → 403 só se NÃO desbloqueou (mesma regra do aluno)', async () => {
    const token = await loginVisitor();
    const res = await request(app).post('/api/me/title').set(authHeader(token)).send({ titleId: 'centena' });
    // 403 pelo motivo certo — posse do título —, não por ser visitante.
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/desbloqueou/i);
  });
});

// D9 — a fronteira que SUBSTITUIU os 403. As duas arenas não podem se cruzar, senão
// um único duelo alimenta os dois rankings de uma vez.
describe('D9 — visitante duela só com visitante', () => {
  it('lista de oponentes não atravessa a arena', async () => {
    const v = await loginVisitorFull();
    const aluno = await loginAs('aluno');

    const paraVisitante = (await request(app).get('/api/duel/opponents').set(authHeader(v.token))).body;
    expect(paraVisitante.every((o) => o.userId !== '3' && o.userId !== '5')).toBe(true);

    const paraAluno = (await request(app).get('/api/duel/opponents').set(authHeader(aluno))).body;
    expect(paraAluno.every((o) => o.userId !== v.id)).toBe(true);
  });

  it('convite direto por id forjado → 403 (visitante desafiando aluno)', async () => {
    const v = await loginVisitorFull();
    const res = await request(app).post('/api/duel').set(authHeader(v.token))
      .send({ characterId: 'fp-test-1', inviteMethod: 'system', opponentUserId: '3' });
    expect(res.status).toBe(403);
  });

  it('convite direto por id forjado → 403 (aluno desafiando visitante)', async () => {
    const v = await loginVisitorFull();
    const aluno = await loginAs('aluno');
    const res = await request(app).post('/api/duel').set(authHeader(aluno))
      .send({ characterId: 'fp-test-1', inviteMethod: 'system', opponentUserId: v.id });
    expect(res.status).toBe(403);
  });

  // O furo de verdade: no convite por LINK ninguém escolhe o oponente — quem abre o
  // link se auto-adiciona. Sem o guard no `acceptDuel`, era por aqui que as arenas
  // se cruzavam.
  it('aceite por LINK cruzando a arena → 403 (aluno abre link de visitante)', async () => {
    const v = await loginVisitorFull();
    const criado = await request(app).post('/api/duel').set(authHeader(v.token))
      .send({ characterId: 'fp-test-1', inviteMethod: 'link', mode: 'competitive' });
    const token = readData('duels.json').find((d) => d.id === criado.body.id).token;

    const aluno = await loginAs('aluno');
    const res = await request(app).post(`/api/duel/by-token/${token}/accept`).set(authHeader(aluno));
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/mesmo grupo/i);
  });

  it('aceite por LINK cruzando a arena → 403 (visitante abre link de aluno)', async () => {
    const aluno = await loginAs('aluno');
    const criado = await request(app).post('/api/duel').set(authHeader(aluno))
      .send({ characterId: 'fp-test-1', inviteMethod: 'link', mode: 'competitive' });
    const token = readData('duels.json').find((d) => d.id === criado.body.id).token;

    const v = await loginVisitorFull();
    const res = await request(app).post(`/api/duel/by-token/${token}/accept`).set(authHeader(v.token));
    expect(res.status).toBe(403);
  });

  it('visitante × visitante por LINK → aceita normalmente', async () => {
    const v1 = await loginVisitorFull();
    const criado = await request(app).post('/api/duel').set(authHeader(v1.token))
      .send({ characterId: 'fp-test-1', inviteMethod: 'link', mode: 'competitive' });
    const token = readData('duels.json').find((d) => d.id === criado.body.id).token;

    const v2 = await loginVisitorFull();
    const res = await request(app).post(`/api/duel/by-token/${token}/accept`).set(authHeader(v2.token));
    expect(res.status).toBe(200);
  });
});

// =====================================================================
// 6. DELETE /api/logs/:id → só admin
// =====================================================================
describe('DELETE /api/logs/:id — só admin', () => {
  beforeEach(() => {
    writeData('logs.json', [makeLog({ id: 'log-del', userId: '3' })]);
  });

  it('aluno tentando apagar → 403 e o log continua', async () => {
    const token = await loginAs('aluno');
    const res = await request(app).delete('/api/logs/log-del').set(authHeader(token));
    expect(res.status).toBe(403);
    expect(readData('logs.json').some((l) => l.id === 'log-del')).toBe(true);
  });

  it('professor tentando apagar → 403', async () => {
    const token = await loginAs('prof');
    const res = await request(app).delete('/api/logs/log-del').set(authHeader(token));
    expect(res.status).toBe(403);
    expect(readData('logs.json').some((l) => l.id === 'log-del')).toBe(true);
  });

  it('visitante tentando apagar → 403', async () => {
    const token = await loginVisitor();
    const res = await request(app).delete('/api/logs/log-del').set(authHeader(token));
    expect(res.status).toBe(403);
  });

  it('admin apaga → 200 e o log some', async () => {
    const token = await loginAs('admin');
    const res = await request(app).delete('/api/logs/log-del').set(authHeader(token));
    expect(res.status).toBe(200);
    expect(readData('logs.json').some((l) => l.id === 'log-del')).toBe(false);
  });
});
