// CRUD de personagens (freeplay) e exercícios via mountCharacterCrud,
// fotos de paciente, e progresso da trilha.
const {
  app, request, resetData, readData, writeData,
  loginAs, loginVisitor, authHeader,
} = require('./helpers');
const fs = require('fs');

beforeEach(() => resetData());

const post = (path, token, body) => request(app).post(path).set(authHeader(token)).send(body);
const put = (path, token, body) => request(app).put(path).set(authHeader(token)).send(body);
const del = (path, token) => request(app).delete(path).set(authHeader(token));
const get = (path, token) => request(app).get(path).set(authHeader(token));

// Um data URL de imagem JPEG minúsculo, mas válido para o regex do server.
const tinyJpeg = 'data:image/jpeg;base64,' + Buffer.from('fakejpeg').toString('base64');
const tinyPng = 'data:image/png;base64,' + Buffer.from('fakepng').toString('base64');

// ---------------------------------------------------------------------
// Autorização de ESCRITA — uma tabela em vez de seis `it` espalhados.
//
// ⚠ Isto FECHA UM BURACO: PUT e DELETE de /api/exercises não tinham NENHUM teste de
// autorização. O CRUD é montado por `mountCharacterCrud`, então cada rota precisa do
// `requireRole('admin')` por conta própria — um esquecimento em UMA delas deixaria
// qualquer aluno editar/apagar exercício, e nada avisaria.
describe('CRUD de personagem — todas as rotas de escrita são admin-only', () => {
  const ROTAS = [
    ['post', '/api/freeplay'],
    ['put', '/api/freeplay/fp-test-1'],
    ['delete', '/api/freeplay/fp-test-1'],
    ['put', '/api/freeplay/fp-test-1/photo'],
    ['post', '/api/exercises'],
    ['put', '/api/exercises/ex-test-1'],
    ['delete', '/api/exercises/ex-test-1'],
  ];

  it.each([['aluno'], ['prof'], ['visitante']])('%s → 403 em todas as rotas de escrita', async (papel) => {
    const token = papel === 'visitante' ? await loginVisitor() : await loginAs(papel);
    for (const [method, route] of ROTAS) {
      const res = await request(app)[method](route).set(authHeader(token))
        .send({ name: 'X', title: 'X', icon: tinyJpeg, full: tinyJpeg });
      expect(res.status, `${method.toUpperCase()} ${route}`).toBe(403);
    }
    // Nenhuma dessas tentativas pode ter mexido no disco.
    expect(readData('freeplay-characters.json').length).toBe(2);
    expect(readData('exercises.json').length).toBe(3);
    expect(readData('freeplay-characters.json').find((c) => c.id === 'fp-test-1').name).toBe('Sofia Test');
  });
});

describe('POST /api/freeplay — allowlist', () => {
  it('admin cria, o id é gerado no servidor com prefixo fp e o personagem VAI PARA O DISCO', async () => {
    const admin = await loginAs('admin');
    const antes = readData('freeplay-characters.json').length;
    const res = await post('/api/freeplay', admin, { name: 'Novo', age: 30 });
    expect(res.status).toBe(200);
    expect(res.body.id.startsWith('fp')).toBe(true);
    expect(res.body.name).toBe('Novo');

    // O 200 da resposta não prova persistência: uma rota que respondesse o objeto
    // montado sem gravar passaria no teste antigo.
    const chars = readData('freeplay-characters.json');
    expect(chars.length).toBe(antes + 1);
    const stored = chars.find((c) => c.id === res.body.id);
    expect(stored).toBeTruthy();
    expect(stored.name).toBe('Novo');
    expect(stored.age).toBe(30);
  });

  it('campos fora da allowlist (id, foo) NÃO são gravados', async () => {
    const admin = await loginAs('admin');
    const res = await post('/api/freeplay', admin, { name: 'Novo', id: 'hack', foo: 1 });
    expect(res.body.id).not.toBe('hack');
    expect(res.body.foo).toBeUndefined();
    const stored = readData('freeplay-characters.json').find((c) => c.id === res.body.id);
    expect(stored.foo).toBeUndefined();
  });

  it('grava apenas os FREEPLAY_FIELDS conhecidos', async () => {
    const admin = await loginAs('admin');
    const res = await post('/api/freeplay', admin, {
      name: 'N', age: 40, description: 'd', assistantId: 'a',
      specificInstruction: 'si', evaluationCriteria: 'ec',
    });
    const stored = readData('freeplay-characters.json').find((c) => c.id === res.body.id);
    expect(stored.name).toBe('N');
    expect(stored.evaluationCriteria).toBe('ec');
    expect(stored.specificInstruction).toBe('si');
  });
});

describe('POST /api/exercises — allowlist', () => {
  it('admin cria com prefixo ex e grava só EXERCISE_FIELDS', async () => {
    const admin = await loginAs('admin');
    const res = await post('/api/exercises', admin, {
      skillId: 2, title: 'T', description: 'd', difficulty: 'iniciante',
      specificInstruction: 'si', evaluatorPrompt: 'ep', name: 'IGNORADO',
    });
    expect(res.status).toBe(200);
    expect(res.body.id.startsWith('ex')).toBe(true);
    const stored = readData('exercises.json').find((c) => c.id === res.body.id);
    expect(stored.title).toBe('T');
    expect(stored.evaluatorPrompt).toBe('ep');
    // 'name' não pertence a EXERCISE_FIELDS.
    expect(stored.name).toBeUndefined();
  });
});

describe('PUT /api/freeplay/:id — atualização', () => {
  it('admin atualiza campo permitido', async () => {
    const admin = await loginAs('admin');
    const res = await put('/api/freeplay/fp-test-1', admin, { name: 'Renomeado' });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Renomeado');
    expect(readData('freeplay-characters.json').find((c) => c.id === 'fp-test-1').name).toBe('Renomeado');
  });

  it('PUT ignora campos fora da allowlist', async () => {
    const admin = await loginAs('admin');
    await put('/api/freeplay/fp-test-1', admin, { hacked: true, role: 'admin' });
    const stored = readData('freeplay-characters.json').find((c) => c.id === 'fp-test-1');
    expect(stored.hacked).toBeUndefined();
    expect(stored.role).toBeUndefined();
  });

  it('PUT em id inexistente -> 404', async () => {
    const admin = await loginAs('admin');
    expect((await put('/api/freeplay/nao-existe', admin, { name: 'X' })).status).toBe(404);
  });
});

describe('DELETE /api/freeplay/:id', () => {
  it('admin remove só o alvo', async () => {
    const admin = await loginAs('admin');
    const res = await del('/api/freeplay/fp-test-1', admin);
    expect(res.status).toBe(200);
    const chars = readData('freeplay-characters.json');
    expect(chars.find((c) => c.id === 'fp-test-1')).toBeUndefined();
    expect(chars.map((c) => c.id)).toEqual(['fp-test-2']); // o outro sobrevive
  });

  // "200" sozinho não prova idempotência: um `filter` com o predicado invertido apagaria
  // TODOS os personagens e ainda responderia 200. A asserção que vale é o comprimento.
  it('DELETE em id inexistente -> 200 e NENHUM personagem é apagado', async () => {
    const admin = await loginAs('admin');
    expect((await del('/api/freeplay/nao-existe', admin)).status).toBe(200);
    const chars = readData('freeplay-characters.json');
    expect(chars.length).toBe(2);
    expect(chars.map((c) => c.id).sort()).toEqual(['fp-test-1', 'fp-test-2']);
  });
});

describe('GET /api/freeplay — decoração com MMR', () => {
  it('injeta difficulty e competitiveMatches', async () => {
    const admin = await loginAs('admin');
    const res = await get('/api/freeplay', admin);
    expect(res.status).toBe(200);
    for (const c of res.body) {
      expect(c).toHaveProperty('difficulty');
      expect(c).toHaveProperty('competitiveMatches');
    }
  });

  it('competitiveMatches reflete o mmr.json', async () => {
    writeData('mmr.json', { players: {}, characters: { 'fp-test-1': { n: 4 } } });
    const admin = await loginAs('admin');
    const res = await get('/api/freeplay', admin);
    const sofia = res.body.find((c) => c.id === 'fp-test-1');
    expect(sofia.competitiveMatches).toBe(4);
  });

  it('sem dados de MMR, competitiveMatches é 0', async () => {
    const admin = await loginAs('admin');
    const res = await get('/api/freeplay', admin);
    expect(res.body.find((c) => c.id === 'fp-test-2').competitiveMatches).toBe(0);
  });

  it('exercícios NÃO ganham decoração de MMR', async () => {
    const admin = await loginAs('admin');
    const res = await get('/api/exercises', admin);
    expect(res.body[0].competitiveMatches).toBeUndefined();
  });
});

describe('PUT /api/freeplay/:id/photo', () => {
  const photo = (token, id, body) =>
    request(app).put(`/api/freeplay/${id}/photo`).set(authHeader(token)).send(body);

  it('admin com data URL JPEG válido -> 200 e grava referências', async () => {
    const admin = await loginAs('admin');
    const res = await photo(admin, 'fp-test-1', { icon: tinyJpeg, full: tinyJpeg });
    expect(res.status).toBe(200);
    const stored = readData('freeplay-characters.json').find((c) => c.id === 'fp-test-1');
    expect(stored.photoIcon).toBeTruthy();
    expect(stored.photoFull).toBeTruthy();
  });

  // O regex do servidor aceita jpeg|png|webp, mas só o JPEG era testado — se alguém
  // apertasse o regex para `image/jpeg`, o AdminFreeplay quebraria com PNG e nenhum
  // teste avisaria.
  it('admin com data URL PNG válido -> 200 (o regex aceita png/webp, não só jpeg)', async () => {
    const admin = await loginAs('admin');
    const res = await photo(admin, 'fp-test-1', { icon: tinyPng, full: tinyPng });
    expect(res.status).toBe(200);
  });

  // Uma tabela: cada linha é uma forma diferente de o `decodeImageDataUrl` recusar.
  // O caso do "caractere fora do alfabeto" é o que separa um regex ancorado de um
  // `startsWith('data:image/')` ingênuo: `!` não é base64 e não pode passar.
  it.each([
    ['string qualquer, sem data URL → 400',          'lixo',                                                        400],
    ['MIME não-imagem → 400',                        'data:text/plain;base64,' + Buffer.from('x').toString('base64'), 400],
    ['MIME de imagem não suportado (svg+xml) → 400', 'data:image/svg+xml;base64,' + Buffer.from('<svg/>').toString('base64'), 400],
    ['base64 com caractere fora do alfabeto → 400',  'data:image/jpeg;base64,abc!def',                              400],
    ['payload > 6MB → 413',                          'data:image/jpeg;base64,' + Buffer.alloc(7 * 1024 * 1024, 0x41).toString('base64'), 413],
  ])('%s', async (_nome, payload, esperado) => {
    const admin = await loginAs('admin');
    const res = await photo(admin, 'fp-test-1', { icon: payload, full: payload });
    expect(res.status).toBe(esperado);
    // Recusa não pode gravar meia foto no personagem.
    const stored = readData('freeplay-characters.json').find((c) => c.id === 'fp-test-1');
    expect(stored.photoIcon).toBeUndefined();
    expect(stored.photoFull).toBeUndefined();
  });

  it('{clear:true} remove as fotos', async () => {
    const admin = await loginAs('admin');
    await photo(admin, 'fp-test-1', { icon: tinyJpeg, full: tinyJpeg });
    const res = await photo(admin, 'fp-test-1', { clear: true });
    expect(res.status).toBe(200);
    const stored = readData('freeplay-characters.json').find((c) => c.id === 'fp-test-1');
    expect(stored.photoIcon).toBeUndefined();
    expect(stored.photoFull).toBeUndefined();
  });

  // ⚠ O teste ANTIGO daqui era falsa confiança: mandava `../../etc/passwd` como id, o
  // `findIndex` não achava nada e devolvia 404 — **antes** de o `isSafeId` sequer rodar.
  // Ele passava com o guard DELETADO. O `isSafeId` só importa para um id que EXISTE no
  // JSON (semeado, importado, ou vindo de um bug de criação), porque é aí que o fluxo
  // chega ao `fs.writeFileSync(path.join(PATIENT_PHOTOS_DIR, id + '-icon.jpg'))`.
  it('id perigoso que EXISTE no JSON → 400 e não escreve fora do diretório de fotos', async () => {
    const chars = readData('freeplay-characters.json');
    chars.push({ id: '../../../tmp/genus-pwned', name: 'Malicioso', age: 30, description: '' });
    writeData('freeplay-characters.json', chars);

    const admin = await loginAs('admin');
    const res = await photo(admin, encodeURIComponent('../../../tmp/genus-pwned'), { icon: tinyJpeg, full: tinyJpeg });

    expect(res.status).toBe(400);
    expect(fs.existsSync('/tmp/genus-pwned-icon.jpg')).toBe(false);
  });

  it('id inexistente → 404 (e nada é gravado)', async () => {
    const admin = await loginAs('admin');
    const res = await photo(admin, 'nao-existe', { icon: tinyJpeg, full: tinyJpeg });
    expect(res.status).toBe(404);
  });

  it('exercício NÃO tem rota de foto', async () => {
    const admin = await loginAs('admin');
    const res = await request(app).put('/api/exercises/ex-test-1/photo')
      .set(authHeader(admin)).send({ icon: tinyJpeg, full: tinyJpeg });
    expect(res.status).toBe(404);
  });
});

// A AUTORIZAÇÃO desta rota (403 cruzado, admin lê qualquer um) e o efeito no disco de um
// POST negado vivem em security.test.js — este bloco cobre só a SEMÂNTICA: o POST faz
// merge, não substitui. Um `Object.assign({}, body)` no lugar do merge apagaria todo o
// progresso do aluno a cada exercício concluído, e nenhum teste de status pegaria.
describe('POST /api/progress/:userId — semântica de merge', () => {
  it('POST faz merge (não apaga chaves anteriores) e persiste', async () => {
    writeData('progress.json', { '3': { a: 1 } });
    const aluno = await loginAs('aluno');
    const res = await post('/api/progress/3', aluno, { b: 2 });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ a: 1, b: 2 });
    expect(readData('progress.json')['3']).toEqual({ a: 1, b: 2 });
  });

  it('POST no próprio progresso não toca no progresso de OUTRO usuário', async () => {
    writeData('progress.json', { '3': {}, '5': { intocado: true } });
    const aluno = await loginAs('aluno');
    await post('/api/progress/3', aluno, { novo: 1 });
    expect(readData('progress.json')['5']).toEqual({ intocado: true });
  });
});
