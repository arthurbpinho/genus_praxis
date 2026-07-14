// Gamificação: streak, missões diárias, conquistas, títulos.
// GET /api/gamification/:userId e POST /api/me/title.
//
// Organização: os testes de "forma" (existe a chave X?) são poucos de propósito — eles
// passariam mesmo com a lógica inteira quebrada. O peso está nas TABELAS abaixo, que
// exercitam cada conquista, cada missão e cada transição de streak.
const {
  app, request, resetData, readData, writeData,
  loginAs, loginVisitor, authHeader, makeLog, atLocalHour, dayKey,
} = require('./helpers');

beforeEach(() => resetData());

// Log de exercício (o makeLog do helper é freeplay por padrão).
function exLog(over = {}) {
  return makeLog({ type: 'exercise', itemId: 'ex-test-1', itemTitle: 'Exercício 1', ...over });
}

function gami(token, userId) {
  return request(app).get(`/api/gamification/${userId}`).set(authHeader(token));
}

/** Grava os logs, loga e devolve o corpo de /api/gamification. */
async function gamiWith(logs, username = 'aluno', userId = '3') {
  writeData('logs.json', logs);
  const token = await loginAs(username);
  const res = await gami(token, userId);
  expect(res.status).toBe(200);
  return res.body;
}

// =====================================================================
// FORMA DO PAYLOAD (2 testes — sem snapshot de contagem)
// =====================================================================
describe('GET /api/gamification/:userId — forma do payload', () => {
  it('devolve streak, dailyMissions, achievements e stats com os campos certos', async () => {
    const aluno = await loginAs('aluno');
    const res = await gami(aluno, '3');
    expect(res.status).toBe(200);

    // A chave é `dailyMissions` — o client lê exatamente esse nome (não "missions").
    expect(res.body.missions).toBeUndefined();
    expect(Array.isArray(res.body.dailyMissions)).toBe(true);
    expect(Array.isArray(res.body.achievements)).toBe(true);

    // Cada conquista precisa do contrato que o client consome.
    for (const a of res.body.achievements) {
      expect(a).toMatchObject({
        id: expect.any(String), icon: expect.any(String), title: expect.any(String),
        description: expect.any(String), tier: expect.any(String), earned: expect.any(Boolean),
      });
      expect(['bronze', 'silver', 'gold', 'platinum']).toContain(a.tier);
    }
    for (const m of res.body.dailyMissions) {
      expect(m).toMatchObject({
        id: expect.any(String), title: expect.any(String),
        target: expect.any(Number), progress: expect.any(Number), completed: expect.any(Boolean),
      });
    }
    expect(res.body.streak).toMatchObject({
      current: expect.any(Number), longest: expect.any(Number),
      isAlive: expect.any(Boolean), status: expect.any(String),
    });
    expect(res.body.stats).toMatchObject({
      totalSessions: expect.any(Number),
      totalExercise: expect.any(Number),
      totalFreeplay: expect.any(Number),
    });
    // O Neuro NÃO foi portado: nada de neuro pode reaparecer aqui.
    expect(res.body.stats).not.toHaveProperty('totalNeuro');
  });

  // NOTA: NÃO travamos a CONTAGEM de conquistas/missões. Um "toHaveLength(19)" quebra a
  // cada conquista nova e não pega bug nenhum de lógica. O que importa é a ausência de
  // neuro e a unicidade dos ids (um id duplicado quebraria o seletor de título).
  it('ids únicos e nenhum resquício de neuro', async () => {
    const aluno = await loginAs('aluno');
    const res = await gami(aluno, '3');
    const achIds = res.body.achievements.map((a) => a.id);
    const misIds = res.body.dailyMissions.map((m) => m.id);
    expect(new Set(achIds).size).toBe(achIds.length);
    expect(new Set(misIds).size).toBe(misIds.length);
    for (const id of [...achIds, ...misIds]) expect(id).not.toContain('neuro');
  });
});

// =====================================================================
// AUTORIZAÇÃO (tabela — a matriz completa vive em security.test.js)
// =====================================================================
describe('GET /api/gamification/:userId — acesso', () => {
  it.each([
    ['aluno',  'aluno', '3', 200, 'vê a própria'],
    ['aluno',  'aluno', '5', 403, 'IDOR: aluno de outro'],
    ['prof',   'prof',  '3', 200, 'professor vê aluno vinculado'],
    ['prof',   'prof',  '5', 403, 'professor NÃO vê aluno de outro professor'],
    ['admin',  'admin', '5', 200, 'admin vê qualquer um'],
  ])('%s -> /api/gamification/%s = %i (%s)', async (_u, username, targetId, expected) => {
    const token = await loginAs(username);
    const res = await gami(token, targetId);
    expect(res.status).toBe(expected);
  });
});

// =====================================================================
// STATS
// =====================================================================
describe('stats derivados dos logs', () => {
  it('conta sessões, exercício e freeplay separadamente', async () => {
    const b = await gamiWith([exLog(), exLog({ itemId: 'ex-test-2' }), makeLog()]);
    expect(b.stats).toMatchObject({ totalSessions: 3, totalExercise: 2, totalFreeplay: 1 });
  });

  it('averageScore e bestScore ignoram scores não numéricos', async () => {
    const b = await gamiWith([makeLog({ score: 10 }), makeLog({ score: 20 }), makeLog({ score: null })]);
    expect(b.stats.averageScore).toBe(15);
    expect(b.stats.bestScore).toBe(20);
  });

  it('sem scores válidos -> averageScore e bestScore null', async () => {
    const b = await gamiWith([makeLog({ score: null })]);
    expect(b.stats.averageScore).toBeNull();
    expect(b.stats.bestScore).toBeNull();
  });
});

// =====================================================================
// STREAK — tabela
// =====================================================================
describe('streak', () => {
  // `daysAgo` monta um log por dia listado. O esperado cobre os 4 campos que o client usa.
  it.each([
    { nome: 'sem logs',                          daysAgo: [],           current: 0, longest: 0, status: 'none',    isAlive: false },
    { nome: 'só hoje',                           daysAgo: [0],          current: 1, longest: 1, status: 'active',  isAlive: true },
    { nome: 'hoje+ontem+anteontem',              daysAgo: [0, 1, 2],    current: 3, longest: 3, status: 'active',  isAlive: true },
    // A streak sobrevive UM dia sem sessão: quem jogou ontem ainda pode salvar hoje.
    { nome: 'só ontem (sobrevive)',              daysAgo: [1],          current: 1, longest: 1, status: 'active',  isAlive: true },
    // Dois dias parados: morreu. `current` volta a 0 e `isAlive` cai — é o gatilho do aviso no client.
    { nome: 'só anteontem (morreu)',             daysAgo: [2],          current: 0, longest: 1, status: 'none',    isAlive: false },
    { nome: 'gap de 2 dias quebra',              daysAgo: [0, 3],       current: 1, longest: 1, status: 'active',  isAlive: true },
    { nome: 'dois logs no MESMO dia = 1 dia',    daysAgo: [0, 0],       current: 1, longest: 1, status: 'active',  isAlive: true },
    // Bloco antigo de 4 dias, quebra, e só hoje: `longest` guarda o recorde.
    { nome: 'longest > current',                 daysAgo: [8, 7, 6, 5, 0], current: 1, longest: 4, status: 'active', isAlive: true },
    { nome: '7 dias -> weekly',                  daysAgo: [0, 1, 2, 3, 4, 5, 6], current: 7, longest: 7, status: 'weekly', isAlive: true },
    { nome: '6 dias ainda NÃO é weekly',         daysAgo: [0, 1, 2, 3, 4, 5],    current: 6, longest: 6, status: 'active', isAlive: true },
    { nome: '30 dias -> monthly',                daysAgo: Array.from({ length: 30 }, (_, i) => i), current: 30, longest: 30, status: 'monthly', isAlive: true },
    { nome: '29 dias ainda é weekly',            daysAgo: Array.from({ length: 29 }, (_, i) => i), current: 29, longest: 29, status: 'weekly',  isAlive: true },
  ])('$nome', async ({ daysAgo, current, longest, status, isAlive }) => {
    const b = await gamiWith(daysAgo.map((d) => makeLog({ daysAgo: d })));
    expect(b.streak).toMatchObject({ current, longest, status, isAlive });
  });

  it('daysToWeekly/daysToMonthly descontam a streak atual e nunca ficam negativos', async () => {
    const b = await gamiWith([0, 1, 2].map((d) => makeLog({ daysAgo: d })));
    expect(b.streak.daysToWeekly).toBe(4);
    expect(b.streak.daysToMonthly).toBe(27);

    const longo = await gamiWith(Array.from({ length: 31 }, (_, i) => makeLog({ daysAgo: i })));
    expect(longo.streak.daysToWeekly).toBe(0);
    expect(longo.streak.daysToMonthly).toBe(0);
  });

  it('lastActiveDate é o dia LOCAL do último log (não o UTC)', async () => {
    // Sessão às 23h30 no fuso da aplicação = madrugada do dia SEGUINTE em UTC.
    // O dia que vale é o dia em que o aluno estava na frente do computador.
    const b = await gamiWith([makeLog({ timestamp: atLocalHour(23, 0) })]);
    expect(b.streak.lastActiveDate).toBe(dayKey(0));
    expect(b.streak.current).toBe(1);
  });
});

// =====================================================================
// MISSÕES DIÁRIAS — a lógica de cada uma das 3
// =====================================================================
describe('missões diárias (computeDailyMissions)', () => {
  const missionOf = (body, id) => body.dailyMissions.find((m) => m.id === id);

  it('sem logs hoje: as 3 missões ficam em 0/target', async () => {
    const b = await gamiWith([]);
    for (const m of b.dailyMissions) {
      expect(m.progress).toBe(0);
      expect(m.completed).toBe(false);
    }
  });

  it('daily_1exercise: QUALQUER sessão de hoje completa (inclusive freeplay)', async () => {
    const b = await gamiWith([makeLog({ daysAgo: 0 })]);
    expect(missionOf(b, 'daily_1exercise')).toMatchObject({ progress: 1, target: 1, completed: true });
  });

  it('daily_1exercise NÃO conta sessão de ontem', async () => {
    const b = await gamiWith([makeLog({ daysAgo: 1 })]);
    expect(missionOf(b, 'daily_1exercise').completed).toBe(false);
  });

  it('daily_2trilha: exige 2 EXERCÍCIOS hoje — 1 exercício não basta', async () => {
    const um = await gamiWith([exLog({ daysAgo: 0 })]);
    expect(missionOf(um, 'daily_2trilha')).toMatchObject({ progress: 1, completed: false });

    const dois = await gamiWith([exLog({ daysAgo: 0 }), exLog({ daysAgo: 0, itemId: 'ex-test-2' })]);
    expect(missionOf(dois, 'daily_2trilha')).toMatchObject({ progress: 2, target: 2, completed: true });
  });

  it('daily_2trilha: freeplay NÃO conta (é missão de trilha)', async () => {
    const b = await gamiWith([makeLog({ daysAgo: 0 }), makeLog({ daysAgo: 0 })]);
    expect(missionOf(b, 'daily_2trilha')).toMatchObject({ progress: 0, completed: false });
  });

  it('daily_2trilha: o progresso satura no target (3 exercícios -> progress 2)', async () => {
    const b = await gamiWith([
      exLog({ daysAgo: 0 }), exLog({ daysAgo: 0, itemId: 'ex-test-2' }), exLog({ daysAgo: 0, itemId: 'ex-test-3' }),
    ]);
    expect(missionOf(b, 'daily_2trilha').progress).toBe(2);
  });

  it('daily_efficiency: freeplay de hoje, <= 600s e score >= 8', async () => {
    const b = await gamiWith([makeLog({ daysAgo: 0, durationSeconds: 600, score: 8 })]);
    expect(missionOf(b, 'daily_efficiency')).toMatchObject({ progress: 1, completed: true });
  });

  it.each([
    ['duração acima de 600s', { durationSeconds: 601, score: 50 }],
    ['score abaixo de 8',     { durationSeconds: 100, score: 7 }],
    ['score ausente',         { durationSeconds: 100, score: null }],
  ])('daily_efficiency NÃO completa: %s', async (_nome, over) => {
    const b = await gamiWith([makeLog({ daysAgo: 0, ...over })]);
    expect(missionOf(b, 'daily_efficiency').completed).toBe(false);
  });

  it('daily_efficiency: EXERCÍCIO rápido e bem pontuado NÃO conta (a missão é de Simulação)', async () => {
    const b = await gamiWith([exLog({ daysAgo: 0, durationSeconds: 100, score: 90 })]);
    expect(missionOf(b, 'daily_efficiency').completed).toBe(false);
  });

  it('missão de ontem não vaza para hoje', async () => {
    const b = await gamiWith([makeLog({ daysAgo: 1, durationSeconds: 100, score: 90 })]);
    for (const m of b.dailyMissions) expect(m.completed).toBe(false);
  });
});

// =====================================================================
// CONQUISTAS — tabela (uma linha por conquista)
// =====================================================================
describe('conquistas (achievements)', () => {
  const earnedIds = async (logs, username = 'aluno', userId = '3') => {
    const b = await gamiWith(logs, username, userId);
    return new Set(b.achievements.filter((a) => a.earned).map((a) => a.id));
  };

  // Os exercícios de fixture cobrem só as competências 1, 2 e 3 (helpers.js). Para
  // `trilha_skill_4/5` e `trilha_master` precisamos de exercícios das 5 competências.
  function exercisesFor5Skills() {
    return [1, 2, 3, 4, 5].map((s) => ({
      id: `ex-s${s}`, title: `Exercício skill ${s}`, description: 'd',
      skillId: s, difficulty: 'iniciante', specificInstruction: 'SEGREDO',
    }));
  }
  const logsFor5Skills = () => [1, 2, 3, 4, 5].map((s) => exLog({ itemId: `ex-s${s}` }));

  const dias = (n) => Array.from({ length: n }, (_, i) => makeLog({ daysAgo: i }));
  const destaques = (n) => makeLog({
    messages: Array.from({ length: n }, () => ({ role: 'user', content: 'x', highlighted: true })),
  });

  it('nenhum log -> nenhuma conquista', async () => {
    expect((await earnedIds([])).size).toBe(0);
  });

  // Tabela: [id, logs que DEVEM desbloquear, logs que NÃO devem (o caso-limite)].
  // Cada linha checa os dois lados — sem o lado negativo, um `earned.add(id)`
  // incondicional passaria.
  it.each([
    {
      id: 'first_session',
      ok: () => [makeLog()],
      // (o lado negativo de first_session é o "nenhum log" acima)
      nao: () => [],
    },
    {
      // O limiar era 25 — herdado do All_OS (escala −9..+9 da trilha). Numa escala 0–100
      // unificada, 25 é nota FRACA e "Excelência técnica" (ouro) saía quase de graça.
      id: 'high_score',
      ok: () => [makeLog({ score: 85 })],
      nao: () => [makeLog({ score: 84 })],
    },
    {
      id: 'speed_demon',
      ok: () => [makeLog({ durationSeconds: 299, score: 1 })],
      nao: () => [makeLog({ durationSeconds: 300, score: 5 })],  // é < 300, estrito
    },
    {
      id: 'speed_demon (exige score > 0)',
      achId: 'speed_demon',
      ok: () => [makeLog({ durationSeconds: 100, score: 1 })],
      nao: () => [makeLog({ durationSeconds: 100, score: 0 })],
    },
    {
      // ANTES SEM COBERTURA: sessão antes das 7h, no fuso da aplicação.
      id: 'early_bird',
      ok: () => [makeLog({ timestamp: atLocalHour(6, 0) })],
      nao: () => [makeLog({ timestamp: atLocalHour(7, 0) })],   // 7h já não conta (h < 7)
    },
    {
      // ANTES SEM COBERTURA: sessão a partir das 23h, no fuso da aplicação.
      id: 'night_owl',
      ok: () => [makeLog({ timestamp: atLocalHour(23, 0) })],
      nao: () => [makeLog({ timestamp: atLocalHour(22, 0) })],  // 22h não conta (h >= 23)
    },
    {
      // A descrição promete "em dias DIFERENTES" e o código só exigia que as duas sessões
      // existissem — uma vigília única das 23h às 6h desbloqueava esta conquista de OURO.
      // Alinhado ao texto (que é o contrato com o aluno); o caso da vigília está logo abaixo.
      id: 'lua_cheia',
      ok: () => [makeLog({ timestamp: atLocalHour(6, 1) }), makeLog({ timestamp: atLocalHour(23, 0) })],
      nao: () => [makeLog({ timestamp: atLocalHour(6, 1) })],   // só a madrugada: falta a noite
    },
    {
      id: 'centena',
      ok: () => Array.from({ length: 100 }, (_, i) => makeLog({ id: 'log-' + i })),
      nao: () => Array.from({ length: 99 }, (_, i) => makeLog({ id: 'log-' + i })),
    },
    {
      id: 'polivalente',
      ok: () => [exLog({ daysAgo: 0 }), makeLog({ daysAgo: 0 })],
      nao: () => [exLog({ daysAgo: 0 }), makeLog({ daysAgo: 1 })],   // dias diferentes não valem
    },
    {
      id: 'streak_7_ever',
      ok: () => dias(7),
      nao: () => dias(6),
    },
    {
      id: 'streak_30_ever',
      ok: () => dias(30),
      nao: () => dias(29),
    },
    {
      id: 'highlights_10',
      ok: () => [destaques(10)],
      nao: () => [destaques(9)],
    },
    {
      // Destaques SOMAM entre logs — não precisam estar todos na mesma sessão.
      id: 'highlights_10 (somando sessões)',
      achId: 'highlights_10',
      ok: () => [destaques(6), destaques(4)],
      nao: () => [destaques(6), destaques(3)],
    },
    {
      id: 'all_difficulties',
      ok: () => [
        exLog({ difficulty: 'iniciante' }),
        exLog({ itemId: 'ex-test-2', difficulty: 'intermediario' }),
        exLog({ itemId: 'ex-test-3', difficulty: 'avancado' }),
      ],
      nao: () => [   // faltando 'avancado'
        exLog({ difficulty: 'iniciante' }),
        exLog({ itemId: 'ex-test-2', difficulty: 'intermediario' }),
      ],
    },
    {
      // Freeplay tem `difficulty`, mas a conquista é de TRILHA: só exercício conta.
      id: 'all_difficulties (freeplay não conta)',
      achId: 'all_difficulties',
      ok: () => [
        exLog({ difficulty: 'iniciante' }),
        exLog({ itemId: 'ex-test-2', difficulty: 'intermediario' }),
        exLog({ itemId: 'ex-test-3', difficulty: 'avancado' }),
      ],
      nao: () => [
        exLog({ difficulty: 'iniciante' }),
        exLog({ itemId: 'ex-test-2', difficulty: 'intermediario' }),
        makeLog({ difficulty: 'avancado' }),   // freeplay: ignorado
      ],
    },
    {
      id: 'simulacao_complete',
      ok: () => [makeLog({ itemId: 'fp-test-1' }), makeLog({ itemId: 'fp-test-2' })],
      nao: () => [makeLog({ itemId: 'fp-test-1' })],   // falta o fp-test-2
    },
    {
      id: 'trilha_skill_1',   // ex-test-1 é a única da skill 1
      ok: () => [exLog({ itemId: 'ex-test-1' })],
      nao: () => [exLog({ itemId: 'ex-test-2' })],     // essa é da skill 2
    },
    {
      id: 'trilha_skill_2',   // ANTES SEM COBERTURA
      ok: () => [exLog({ itemId: 'ex-test-2' })],
      nao: () => [exLog({ itemId: 'ex-test-1' })],
    },
    {
      id: 'trilha_skill_3',   // ANTES SEM COBERTURA
      ok: () => [exLog({ itemId: 'ex-test-3' })],
      nao: () => [exLog({ itemId: 'ex-test-1' })],
    },
  ])('$id', async ({ id, achId, ok, nao }) => {
    const target = achId || id;
    expect(await earnedIds(ok())).toContain(target);
    const semTarget = await earnedIds(nao());
    expect(semTarget.has(target)).toBe(false);
  });

  // As competências 4 e 5 (e portanto o `trilha_master`) precisam de exercícios que a
  // fixture padrão não tem — daí ficarem fora da tabela acima.
  it.each([
    ['trilha_skill_4', 4],   // ANTES SEM COBERTURA
    ['trilha_skill_5', 5],   // ANTES SEM COBERTURA
  ])('%s: exige todos os exercícios da competência', async (achId, skill) => {
    writeData('exercises.json', exercisesFor5Skills());
    const e = await earnedIds([exLog({ itemId: `ex-s${skill}` })]);
    expect(e.has(achId)).toBe(true);
    // Só essa competência foi concluída: as outras 4 (e o master) continuam bloqueadas.
    expect(e.has('trilha_master')).toBe(false);
  });

  it('trilha_master: as 5 competências concluídas', async () => {   // ANTES SEM COBERTURA
    writeData('exercises.json', exercisesFor5Skills());
    const todas = await earnedIds(logsFor5Skills());
    expect(todas.has('trilha_master')).toBe(true);
    for (let s = 1; s <= 5; s++) expect(todas.has(`trilha_skill_${s}`)).toBe(true);

    // Faltando UMA competência, o master não sai.
    const quase = await earnedIds(logsFor5Skills().slice(0, 4));
    expect(quase.has('trilha_master')).toBe(false);
  });

  it('conquista de trilha ignora exercícios que já não existem (log órfão)', async () => {
    // O admin apagou o exercício; o log antigo continua lá. A conquista da competência
    // não pode ser dada "de graça" por um id que não está mais no catálogo.
    const e = await earnedIds([exLog({ itemId: 'ex-APAGADO' })]);
    expect(e.has('trilha_skill_1')).toBe(false);
  });

  it('logs de OUTRO usuário não contam', async () => {
    // Os logs são do aluno 5; o aluno 3 não pode herdar nada deles.
    const e = await earnedIds([makeLog({ userId: '5' }), makeLog({ userId: '5' })]);
    expect(e.size).toBe(0);
  });
});

// =====================================================================
// earnedAt / persistência
// =====================================================================
describe('earnedAt e persistência', () => {
  it('earnedAt presente só nas desbloqueadas, e persiste em achievements.json', async () => {
    const b = await gamiWith([makeLog()]);
    const first = b.achievements.find((a) => a.id === 'first_session');
    const centena = b.achievements.find((a) => a.id === 'centena');
    expect(first).toMatchObject({ earned: true });
    expect(first.earnedAt).toBeTruthy();
    expect(centena).toMatchObject({ earned: false, earnedAt: null });

    const ach = readData('achievements.json');
    expect(ach['3'].first_session).toBeTruthy();
  });

  it('a data de desbloqueio NÃO é reescrita numa segunda chamada', async () => {
    // Se fosse, a conquista "rejuvenesceria" a cada visita à tela de Objetivos.
    writeData('logs.json', [makeLog()]);
    const aluno = await loginAs('aluno');
    await gami(aluno, '3');
    const primeira = readData('achievements.json')['3'].first_session;

    await new Promise((r) => setTimeout(r, 5));
    const res = await gami(aluno, '3');
    expect(readData('achievements.json')['3'].first_session).toBe(primeira);
    expect(res.body.achievements.find((a) => a.id === 'first_session').earnedAt).toBe(primeira);
  });
});

// =====================================================================
// POST /api/me/title
// =====================================================================
describe('POST /api/me/title', () => {
  const setTitle = (token, titleId) =>
    request(app).post('/api/me/title').set(authHeader(token)).send({ titleId });

  it('título não desbloqueado -> 403 (a posse é revalidada no servidor)', async () => {
    const aluno = await loginAs('aluno');
    const res = await setTitle(aluno, 'centena');
    expect(res.status).toBe(403);
    expect('activeTitle' in readData('users.json').find((u) => u.id === '3')).toBe(false);
  });

  it('id de título inexistente -> 403 (não vira um activeTitle fantasma)', async () => {
    writeData('logs.json', [makeLog()]);
    const aluno = await loginAs('aluno');
    const res = await setTitle(aluno, 'titulo_que_nao_existe');
    expect(res.status).toBe(403);
    expect('activeTitle' in readData('users.json').find((u) => u.id === '3')).toBe(false);
  });

  it('título desbloqueado -> 200, grava, e /api/me devolve', async () => {
    writeData('logs.json', [makeLog()]);
    const aluno = await loginAs('aluno');
    expect((await setTitle(aluno, 'first_session')).status).toBe(200);
    expect(readData('users.json').find((u) => u.id === '3').activeTitle).toBe('first_session');

    const me = await request(app).get('/api/me').set(authHeader(aluno));
    expect(me.body.user.activeTitle).toBe('first_session');
  });

  it("titleId '' REMOVE a chave activeTitle (não grava string vazia)", async () => {
    // O client normaliza `activeTitle: updated.activeTitle || ''` justamente porque o
    // servidor faz `delete` — a chave some do payload em vez de vir vazia.
    writeData('logs.json', [makeLog()]);
    const aluno = await loginAs('aluno');
    await setTitle(aluno, 'first_session');
    const res = await setTitle(aluno, '');
    expect(res.status).toBe(200);
    expect('activeTitle' in readData('users.json').find((u) => u.id === '3')).toBe(false);
  });

  it('visitante -> 403', async () => {
    const v = await loginVisitor();
    const res = await setTitle(v, 'first_session');
    expect(res.status).toBe(403);
  });
});

describe('lua_cheia exige DIAS diferentes (não uma vigília única)', () => {
  // A descrição diz "em dias diferentes", mas o código só checava que existiam as duas
  // sessões. Uma vigília das 23h às 6h da MESMA madrugada desbloqueava uma conquista de
  // ouro — o aluno lia uma regra e o sistema aplicava outra.
  it('23h e 6h do MESMO dia local NÃO desbloqueiam', async () => {
    writeData('logs.json', [
      makeLog({ userId: '3', timestamp: atLocalHour(23, 0) }),
      makeLog({ userId: '3', timestamp: atLocalHour(6, 0) }),   // mesmo dia local
    ]);
    const aluno = await loginAs('aluno');
    const res = await request(app).get('/api/gamification/3').set(authHeader(aluno));

    const ids = res.body.achievements.filter((a) => a.earned).map((a) => a.id);
    expect(ids).toContain('night_owl');    // as duas individuais valem
    expect(ids).toContain('early_bird');
    expect(ids).not.toContain('lua_cheia'); // mas a de ouro, não
  });

  it('23h de um dia e 6h de OUTRO desbloqueiam', async () => {
    writeData('logs.json', [
      makeLog({ userId: '3', timestamp: atLocalHour(23, 2) }),
      makeLog({ userId: '3', timestamp: atLocalHour(6, 0) }),
    ]);
    const aluno = await loginAs('aluno');
    const res = await request(app).get('/api/gamification/3').set(authHeader(aluno));
    expect(res.body.achievements.filter((a) => a.earned).map((a) => a.id)).toContain('lua_cheia');
  });
});
