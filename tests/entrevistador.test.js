// Entrevistador: parser puro de blocos.js (require direto) + rotas HTTP admin-only.
const fs = require('fs');
const path = require('path');
const {
  app, request, resetData, loginAs, loginVisitor, authHeader,
} = require('./helpers');
const { extractBloco1, extractBloco2, extractMeta, extractBlocos } = require('../server/entrevistador/blocos');

beforeEach(() => resetData());

// Template REAL como fixture (do "## [I." em diante). Tem seções I..V (sem VI).
const REAL_PROMPT = fs.readFileSync(
  path.join(__dirname, '..', 'server', 'entrevistador', 'promptentrevistador.md'), 'utf-8',
);
const REAL_FROM_I = REAL_PROMPT.slice(REAL_PROMPT.indexOf('## [I. CONTENÇÃO]'));

// Entradas que NENHUMA das três funções pode aceitar. Cada uma degrada do seu jeito
// (null / '' / meta vazia), mas nenhuma pode lançar.
const ENTRADAS_INVALIDAS = [
  ['null', null],
  ['undefined', undefined],
  ['número', 42],
  ['objeto', {}],
  ['array', []],
  ['string vazia', ''],
];

// =====================================================================
// UNITÁRIO — extractBloco2 (a persona: seção I até o fim)
// =====================================================================
describe('extractBloco2', () => {
  it('template REAL: começa em "## [I. CONTENÇÃO]" e descarta o preâmbulo da conversa', () => {
    expect(extractBloco2(REAL_FROM_I).startsWith('## [I. CONTENÇÃO]')).toBe(true);

    const comPreambulo = 'blá blá conversa\n\n## [I. CONTENÇÃO]\nconteúdo';
    const b2 = extractBloco2(comPreambulo);
    expect(b2.startsWith('## [I. CONTENÇÃO]')).toBe(true);
    expect(b2).not.toContain('blá blá conversa');
  });

  // O entrevistador se despede depois de cuspir o prompt. Sem cortar aí, a despedida
  // entraria no `specificInstruction` — e o paciente "leria" a conversa do admin.
  it.each([
    ['Pronto. É só colar',            'Pronto. É só colar no simulador.',            'É só colar'],
    ['Pronto. Obrigado pela construção', 'Pronto. Obrigado pela construção do caso.', 'Obrigado pela construção'],
    ['Pronto. Bloco 1…',             'Pronto. Bloco 1 vai a seguir.',                'Bloco 1 vai a seguir'],
    ['--- + Pronto. É só colar',     '---\nPronto. É só colar no simulador.',         'É só colar'],
  ])('corta na frase de encerramento: %s', (_nome, despedida, naoPodeConter) => {
    const b2 = extractBloco2(`## [I. CONTENÇÃO]\ncorpo do prompt\n\n${despedida}`);
    expect(b2).toContain('corpo do prompt');
    expect(b2).not.toContain(naoPodeConter);
  });

  it('formato antigo "BLOCO 2 — PROMPT PARA O SIMULADOR"', () => {
    const b2 = extractBloco2('intro\n\nBLOCO 2 — PROMPT PARA O SIMULADOR\ncorpo antigo');
    expect(b2).toContain('BLOCO 2');
    expect(b2).toContain('corpo antigo');
    expect(b2).not.toContain('intro');
  });

  it('sem marcador nenhum -> null (a conversa ainda não gerou o prompt)', () => {
    expect(extractBloco2('só uma conversa sem prompt gerado')).toBeNull();
  });

  it.each(ENTRADAS_INVALIDAS)('entrada inválida (%s) -> null', (_nome, valor) => {
    expect(extractBloco2(valor)).toBeNull();
  });
});

// =====================================================================
// UNITÁRIO — extractBloco1 (o gabarito: seções II..V)
// =====================================================================
describe('extractBloco1', () => {
  it('das seções [II] até [VI] (exclusivo)', () => {
    const b1 = extractBloco1([
      '## [I. CONTENÇÃO]', 'i', '',
      '## [II. IDENTIDADE]', 'ii', '',
      '## [III. VOZ]', 'iii', '',
      '## [VI. EXTRA]', 'nao deve entrar',
    ].join('\n'));
    expect(b1.startsWith('## [II. IDENTIDADE]')).toBe(true);
    expect(b1).toContain('iii');
    expect(b1).not.toContain('nao deve entrar');
    expect(b1).not.toContain('[VI');
  });

  it('sem seção VI: corta no "---" depois da seção V', () => {
    const b1 = extractBloco1([
      '## [II. IDENTIDADE]', 'ii', '',
      '## [V. ABERTURA]', 'conteudo da V', '',
      '---', '', 'rodapé que não entra no gabarito',
    ].join('\n'));
    expect(b1).toContain('conteudo da V');
    expect(b1).not.toContain('rodapé');
    expect(b1.trim().endsWith('conteudo da V')).toBe(true);
  });

  // Ponto sutil: o numeral tem de casar por completo. "[V" NÃO pode casar dentro de
  // "[VI" — se casasse, o corte de VI aconteceria no header da PRÓPRIA seção V, e o
  // gabarito perderia a seção inteira.
  it('[V] não casa dentro de [VI]: a seção V permanece inteira no bloco 1', () => {
    const b1 = extractBloco1([
      '## [II. IDENTIDADE]', 'ii', '',
      '## [V. ABERTURA E CONTINUIDADE]', 'texto exclusivo da V', '',
      '## [VI. FECHAMENTO]', 'texto da VI fora do gabarito',
    ].join('\n'));
    expect(b1).toContain('## [V. ABERTURA E CONTINUIDADE]');
    expect(b1).toContain('texto exclusivo da V');
    expect(b1).not.toContain('texto da VI fora do gabarito');
    expect(b1).not.toContain('## [VI');
  });

  it('template REAL (I..V, sem VI): começa em [II], leva a V, e NÃO leva a I', () => {
    const b1 = extractBloco1(REAL_FROM_I);
    expect(b1.startsWith('## [II. IDENTIDADE]')).toBe(true);
    expect(b1).toContain('## [V. ABERTURA E CONTINUIDADE]');
    // A seção I é a CONTENÇÃO — instrução de atuação do paciente, não gabarito.
    expect(b1).not.toContain('## [I. CONTENÇÃO]');
  });

  it('sem [II] -> string vazia (não há gabarito a extrair)', () => {
    expect(extractBloco1('## [I. CONTENÇÃO]\nsem identidade')).toBe('');
  });

  it.each(ENTRADAS_INVALIDAS)('entrada inválida (%s) -> string vazia', (_nome, valor) => {
    expect(extractBloco1(valor)).toBe('');
  });
});

// =====================================================================
// UNITÁRIO — extractMeta (melhor esforço: nome, idade, descrição)
// =====================================================================
describe('extractMeta', () => {
  it('nome de "Você representa NOME,"', () => {
    expect(extractMeta('Você representa Maria Silva, uma mulher de meia-idade.').name).toBe('Maria Silva');
  });

  // A idade sai DO parágrafo descritivo — que só é capturado quando delimitado por um
  // próximo "###"/"##"/"**Camada". Sem delimitador, não há descrição e portanto nem idade.
  it.each([
    ['### Quem ela é (feminino)', '### Quem ela é\n\nUma advogada de 40 anos, ansiosa.\n\n### Outra', 'advogada', 40],
    ['### Quem ele é (masculino)', '### Quem ele é\n\nUm homem de 50 anos, aposentado.\n\n### Fim', 'aposentado', 50],
    // O terminador do formato antigo é uma linha em CAIXA ALTA ASCII (sem acentos).
    ['formato antigo em caixa alta', 'QUEM ESSA PESSOA É\nUma jovem de 22 anos.\n\nOUTRA SECAO EM CAIXA\ntexto', 'jovem', 22],
  ])('descrição + idade: %s', (_nome, txt, trecho, idade) => {
    const meta = extractMeta(txt);
    expect(meta.description).toContain(trecho);
    expect(meta.age).toBe(idade);
  });

  it('sem delimitador de seção não há descrição (e portanto nem idade)', () => {
    const meta = extractMeta('### Quem ela é\n\nMaria tem 34 anos e mora sozinha.');
    expect(meta.description).toBe('');
    expect(meta.age).toBeNull();
  });

  it('idade fora de 1..120 é ignorada (o parser não inventa)', () => {
    expect(extractMeta('### Quem ela é\n\nUma pessoa de 200 anos.\n\n### Fim').age).toBeNull();
  });

  it('descrição truncada em 240 chars (é o que cabe no card)', () => {
    const meta = extractMeta(`### Quem ela é\n\n${'x'.repeat(500)}\n\n### Fim`);
    expect(meta.description.length).toBe(240);
  });

  it.each(ENTRADAS_INVALIDAS)('entrada inválida (%s) -> meta vazia', (_nome, valor) => {
    expect(extractMeta(valor)).toEqual({ name: '', age: null, description: '' });
  });
});

// =====================================================================
// UNITÁRIO — extractBlocos (composição)
// =====================================================================
// As três funções acima já estão cobertas; aqui só travamos a COMPOSIÇÃO: o contrato
// do payload, o `ready`, e a relação (bloco1 ⊂ bloco2) — que é o que o cliente assume
// ao mostrar os dois campos editáveis lado a lado.
describe('extractBlocos (composição)', () => {
  it('prompt gerado: ready=true, bloco1 é SUBCONJUNTO do bloco2, meta preenchida', () => {
    const r = extractBlocos(REAL_FROM_I);
    expect(r).toEqual({
      ready: true,
      bloco1: expect.any(String),
      bloco2: expect.any(String),
      meta: expect.objectContaining({ name: expect.any(String) }),
    });
    expect(r.bloco2).toContain(r.bloco1);
    expect(r.bloco1.length).toBeGreaterThan(0);
  });

  it('sem prompt: ready=false, bloco2 null, bloco1 vazio', () => {
    expect(extractBlocos('apenas uma conversa')).toEqual({
      ready: false, bloco2: null, bloco1: '', meta: { name: '', age: null, description: '' },
    });
  });
});

// =====================================================================
// BUG REAL (CORRIGIDO) — duas gerações de prompt na MESMA conversa
// =====================================================================
// Cenário: o admin entrevista, recebe o prompt da Ana, e na mesma conversa pede um
// segundo caso — o entrevistador cospe o prompt do Bruno. A transcrição passa a ter
// DOIS "## [I. CONTENÇÃO]".
//
// ANTES: `extractBloco2` cortava no PRIMEIRO "## [I." e seguia ATÉ O FIM do texto. Sem a
// frase de despedida entre os dois casos (as END_PATTERNS são heurística, não garantia),
// os dois personagens eram FUNDIDOS num só: a persona da Ana carregava o prompt do Bruno
// junto, mais a fala do admin que veio no meio — e o `meta.name` dizia "Ana",
// contradizendo o conteúdo.
//
// AGORA: o corte ancora na ÚLTIMA seção `[I.` — a geração que o admin acabou de pedir é a
// que ele quer salvar.
describe('duas gerações de prompt na mesma transcrição', () => {
  const CASO_A = ['## [I. CONTENÇÃO]', 'Você representa Ana, primeira paciente.', '',
    '## [II. IDENTIDADE]', 'identidade da Ana', '',
    '## [V. ABERTURA E CONTINUIDADE]', 'abertura Ana'].join('\n');
  const CASO_B = ['## [I. CONTENÇÃO]', 'Você representa Bruno, segundo paciente.', '',
    '## [II. IDENTIDADE]', 'identidade do Bruno', '',
    '## [V. ABERTURA E CONTINUIDADE]', 'abertura Bruno'].join('\n');

  it('SEM a frase de encerramento: fica a ÚLTIMA geração, não as duas fundidas', () => {
    const txt = `${CASO_A}\n\nÓtimo, agora quero um segundo caso.\n\n${CASO_B}`;
    const r = extractBlocos(txt);

    expect(r.bloco2).toContain('Bruno');
    expect(r.bloco2).not.toContain('Ana');                          // a paciente anterior saiu
    expect(r.bloco2).not.toContain('agora quero um segundo caso');  // e a conversa do admin também
    expect(r.bloco1).toContain('identidade do Bruno');
    expect(r.bloco1).not.toContain('identidade da Ana');
    expect(r.meta.name).toBe('Bruno');                              // o nome bate com o conteúdo
  });

  it('COM a frase de encerramento entre os dois: idem (a última geração vence)', () => {
    const txt = `${CASO_A}\n\n---\nPronto. É só colar no simulador.\n\nQuero um segundo caso.\n\n${CASO_B}`;
    const r = extractBlocos(txt);
    expect(r.bloco2).toContain('Bruno');
    expect(r.bloco2).not.toContain('Ana');
    expect(r.meta.name).toBe('Bruno');
  });

  it('uma geração só continua funcionando (o caso normal não regrediu)', () => {
    const r = extractBlocos(`${CASO_A}\n\n---\nPronto. É só colar no simulador.`);
    expect(r.bloco2).toContain('Ana');
    expect(r.bloco2).not.toContain('Pronto');
    expect(r.meta.name).toBe('Ana');
  });
});

// =====================================================================
// HTTP — as três rotas são ADMIN-ONLY
// =====================================================================
// Uma tabela [rota, papel]: qualquer rota nova do entrevistador que escape do
// `requireRole('admin')` cai aqui. O prompt do entrevistador é IP da Allos (46 KB) e
// já vazou uma vez para aluno/visitante — ver CLAUDE.md, "correções de segurança".
describe('rotas do entrevistador: admin-only', () => {
  const ROTAS = [
    ['GET',  '/api/entrevistador-prompt',     null],
    ['POST', '/api/entrevistador/extract',    { text: REAL_FROM_I }],
    ['POST', '/api/entrevistador/character',  { specificInstruction: '## [I. CONTENÇÃO]\ncorpo', name: 'X' }],
  ];
  const PAPEIS = ['aluno', 'prof', 'visitante'];

  const call = async (metodo, rota, body, token) => {
    const req = metodo === 'GET'
      ? request(app).get(rota)
      : request(app).post(rota).send(body || {});
    return req.set(authHeader(token));
  };

  const casos = [];
  for (const [metodo, rota, body] of ROTAS) for (const papel of PAPEIS) casos.push([metodo, rota, body, papel]);

  it.each(casos)('%s %s — %s -> 403', async (metodo, rota, body, papel) => {
    const token = papel === 'visitante' ? await loginVisitor() : await loginAs(papel);
    const res = await call(metodo, rota, body, token);
    expect(res.status).toBe(403);
  });

  it.each(ROTAS)('%s %s — sem token -> 401', async (metodo, rota, body) => {
    const res = metodo === 'GET'
      ? await request(app).get(rota)
      : await request(app).post(rota).send(body || {});
    expect(res.status).toBe(401);
  });
});

// =====================================================================
// HTTP — GET /api/entrevistador-prompt
// =====================================================================
describe('GET /api/entrevistador-prompt', () => {
  it('admin -> 200 com o prompt do agente', async () => {
    const admin = await loginAs('admin');
    const res = await request(app).get('/api/entrevistador-prompt').set(authHeader(admin));
    expect(res.status).toBe(200);
    expect(typeof res.body.prompt).toBe('string');
    expect(res.body.prompt.length).toBeGreaterThan(0);
  });
});

// =====================================================================
// HTTP — POST /api/entrevistador/extract (parsing puro, sem IA)
// =====================================================================
describe('POST /api/entrevistador/extract', () => {
  const extract = (token, body) =>
    request(app).post('/api/entrevistador/extract').set(authHeader(token)).send(body);

  it('admin com { text } -> 200 { ready, bloco1, bloco2, meta }', async () => {
    const admin = await loginAs('admin');
    const res = await extract(admin, { text: REAL_FROM_I });
    expect(res.status).toBe(200);
    expect(res.body.ready).toBe(true);
    expect(res.body.bloco2).toContain('## [I. CONTENÇÃO]');
    expect(res.body.bloco1).toContain('## [II. IDENTIDADE]');
  });

  it('admin com { messages }: só as do ASSISTANT entram na extração', async () => {
    // O que o ADMIN digitou não pode virar prompt do paciente.
    //
    // ⚠ O turno do admin vem DEPOIS do prompt gerado de propósito. Se viesse antes, o
    // teste seria VÁCUO: `extractBloco2` fatia do "## [I." em diante e descartaria o
    // preâmbulo de qualquer jeito — mesmo que o servidor parasse de filtrar por
    // `role === 'assistant'`. Depois do prompt, o filtro é a ÚNICA defesa: sem ele, o
    // texto do admin entraria na persona (verificado por mutação).
    const admin = await loginAs('admin');
    const res = await extract(admin, {
      messages: [
        { role: 'user', content: 'quero um caso' },
        { role: 'assistant', content: REAL_FROM_I },
        { role: 'user', content: 'MENSAGEM_DO_ADMIN_NAO_PODE_ENTRAR' },
      ],
    });
    expect(res.status).toBe(200);
    expect(res.body.ready).toBe(true);
    expect(res.body.bloco2).not.toContain('MENSAGEM_DO_ADMIN_NAO_PODE_ENTRAR');
  });

  it('transcrição sem prompt gerado -> 200 com ready:false (não é erro)', async () => {
    const admin = await loginAs('admin');
    const res = await extract(admin, { text: 'ainda estamos conversando' });
    expect(res.status).toBe(200);
    expect(res.body.ready).toBe(false);
    expect(res.body.bloco2).toBeNull();
  });

  it('sem text nem messages -> 400', async () => {
    const admin = await loginAs('admin');
    expect((await extract(admin, {})).status).toBe(400);
  });
});

// =====================================================================
// HTTP — POST /api/entrevistador/character
// =====================================================================
describe('POST /api/entrevistador/character', () => {
  const create = (token, body) =>
    request(app).post('/api/entrevistador/character').set(authHeader(token)).send(body);

  it('a partir da transcrição: Bloco2 -> specificInstruction, Bloco1 -> evaluationCriteria', async () => {
    const admin = await loginAs('admin');
    const res = await create(admin, { text: REAL_FROM_I, name: 'Paciente Real' });
    expect(res.status).toBe(200);
    expect(res.body.id).toMatch(/^fp/);
    // A persona (o que o paciente "é") e o gabarito (o que o avaliador confere) são
    // campos DIFERENTES — trocá-los entregaria o gabarito ao paciente.
    expect(res.body.specificInstruction).toContain('## [I. CONTENÇÃO]');
    expect(res.body.evaluationCriteria).toContain('## [II. IDENTIDADE]');
    expect(res.body.evaluationCriteria).not.toContain('## [I. CONTENÇÃO]');
  });

  it('specificInstruction/evaluationCriteria explícitos (o admin editou no modal)', async () => {
    const admin = await loginAs('admin');
    const res = await create(admin, {
      specificInstruction: '## [I. CONTENÇÃO]\npersona',
      evaluationCriteria: '## [II. IDENTIDADE]\ngabarito',
      name: 'Maria', age: 30, description: 'desc',
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ name: 'Maria', age: 30 });
    expect(res.body.specificInstruction).toContain('persona');
    expect(res.body.evaluationCriteria).toContain('gabarito');
  });

  it.each([
    ['transcrição sem "## [I." (prompt não gerado)', { text: 'só uma conversa', name: 'Maria' }, 422],
    ['specificInstruction sem name',                 { specificInstruction: '## [I. CONTENÇÃO]\npersona' }, 400],
  ])('%s -> %i', async (_nome, body, esperado) => {
    const admin = await loginAs('admin');
    expect((await create(admin, body)).status).toBe(esperado);
  });

  it('age fora de 1..120 -> null (não grava idade absurda)', async () => {
    const admin = await loginAs('admin');
    const res = await create(admin, {
      specificInstruction: '## [I. CONTENÇÃO]\npersona', name: 'Zé', age: 999,
    });
    expect(res.status).toBe(200);
    expect(res.body.age).toBeNull();
  });

  it('o personagem criado entra em GET /api/freeplay — e o ALUNO não vê persona nem gabarito', async () => {
    const admin = await loginAs('admin');
    const criado = await create(admin, {
      specificInstruction: '## [I. CONTENÇÃO]\nSEGREDO_PERSONA',
      evaluationCriteria: '## [II.]\nSEGREDO_GABARITO',
      name: 'Novo',
    });
    const id = criado.body.id;

    const aluno = await loginAs('aluno');
    const list = await request(app).get('/api/freeplay').set(authHeader(aluno));
    expect(list.status).toBe(200);
    const found = list.body.find((c) => c.id === id);
    expect(found).toBeTruthy();
    expect(found.name).toBe('Novo');
    expect(found).not.toHaveProperty('specificInstruction');
    expect(found).not.toHaveProperty('evaluationCriteria');
    expect(JSON.stringify(list.body)).not.toContain('SEGREDO_PERSONA');
    expect(JSON.stringify(list.body)).not.toContain('SEGREDO_GABARITO');
  });
});
