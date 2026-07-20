// Anúncios do admin (demanda #9) — pop-up no primeiro login após publicado, depois vai
// para a lista de notificações.
//
// Decisões de produto (2026-07-14): público POR PAPEL; o visitante VÊ; cada anúncio novo
// reabre para quem já viu o anterior; e é RETROATIVO (quem chega depois também vê).
const {
  app, request, resetData, readData,
  loginAs, loginVisitorFull, authHeader,
} = require('./helpers');

beforeEach(() => resetData());

const publicar = (token, body) =>
  request(app).post('/api/admin/announcements').set(authHeader(token)).send(body);
const pendentes = (token) =>
  request(app).get('/api/announcements/pending').set(authHeader(token));
const confirmar = (token, id) =>
  request(app).post(`/api/announcements/${id}/seen`).set(authHeader(token));

describe('publicação (admin)', () => {
  it('admin publica; aluno tem o pop-up pendente', async () => {
    const admin = await loginAs('admin');
    const criado = await publicar(admin, { title: 'Bem-vindos', body: 'No ar.', roles: ['therapist'] });
    expect(criado.status).toBe(200);
    expect(criado.body.id).toMatch(/^ann/);

    const aluno = await loginAs('aluno');
    const res = await pendentes(aluno);
    expect(res.status).toBe(200);
    expect(res.body.map((a) => a.title)).toEqual(['Bem-vindos']);
    // O corpo público não vaza `roles`/`createdBy` — só o que o pop-up precisa (+ o tipo,
    // demanda #12: o client decide onde o anúncio "mora" depois do pop-up).
    expect(Object.keys(res.body[0]).sort()).toEqual(['body', 'createdAt', 'id', 'title', 'type']);
  });

  it('título ou texto vazio → 400 com o campo', async () => {
    const admin = await loginAs('admin');
    expect((await publicar(admin, { title: '', body: 'x' })).body.field).toBe('title');
    expect((await publicar(admin, { title: 'x', body: '' })).body.field).toBe('body');
  });

  it('aluno não publica (rota é de admin)', async () => {
    const aluno = await loginAs('aluno');
    expect((await publicar(aluno, { title: 'x', body: 'y' })).status).toBe(403);
  });
});

describe('público por papel', () => {
  it('anúncio só para alunos NÃO aparece para o professor', async () => {
    const admin = await loginAs('admin');
    await publicar(admin, { title: 'Aos alunos', body: '...', roles: ['therapist'] });

    const prof = await loginAs('prof');
    expect((await pendentes(prof)).body).toEqual([]);
    const aluno = await loginAs('aluno');
    expect((await pendentes(aluno)).body.length).toBe(1);
  });

  it('o VISITANTE vê um anúncio dirigido a ele (decisão do usuário)', async () => {
    const admin = await loginAs('admin');
    await publicar(admin, { title: 'Aos visitantes', body: '...', roles: ['visitor'] });

    const v = await loginVisitorFull();
    expect((await pendentes(v.token)).body.map((a) => a.title)).toEqual(['Aos visitantes']);
    // E o aluno, que não é o público, não vê.
    const aluno = await loginAs('aluno');
    expect((await pendentes(aluno)).body).toEqual([]);
  });

  it('sem `roles` (lista vazia) = TODOS os papéis veem', async () => {
    const admin = await loginAs('admin');
    await publicar(admin, { title: 'Para todos', body: '...' });

    for (const who of ['aluno', 'prof', 'admin']) {
      const t = await loginAs(who);
      expect((await pendentes(t)).body.length, who).toBe(1);
    }
    const v = await loginVisitorFull();
    expect((await pendentes(v.token)).body.length).toBe(1);
  });

  it('papel inválido no `roles` é descartado', async () => {
    const admin = await loginAs('admin');
    const criado = await publicar(admin, { title: 'x', body: 'y', roles: ['therapist', 'hacker', 'root'] });
    expect(readData('announcements.json').find((a) => a.id === criado.body.id).roles).toEqual(['therapist']);
  });
});

describe('confirmar (fecha o pop-up)', () => {
  it('depois de confirmar, o pop-up para de aparecer', async () => {
    const admin = await loginAs('admin');
    const criado = await publicar(admin, { title: 'Aviso', body: '...', roles: ['therapist'] });

    const aluno = await loginAs('aluno');
    expect((await pendentes(aluno)).body.length).toBe(1);

    expect((await confirmar(aluno, criado.body.id)).status).toBe(200);
    expect((await pendentes(aluno)).body).toEqual([]);
  });

  it('confirmar de um aluno NÃO fecha o pop-up de outro', async () => {
    const admin = await loginAs('admin');
    const criado = await publicar(admin, { title: 'Aviso', body: '...', roles: ['therapist'] });

    const aluno = await loginAs('aluno');
    await confirmar(aluno, criado.body.id);

    const aluno2 = await loginAs('aluno2');
    expect((await pendentes(aluno2)).body.length).toBe(1);
  });

  it('`seenAnnouncements` não vaza no /api/me nem em lugar nenhum', async () => {
    const admin = await loginAs('admin');
    const criado = await publicar(admin, { title: 'x', body: 'y' });
    const aluno = await loginAs('aluno');
    await confirmar(aluno, criado.body.id);

    const me = await request(app).get('/api/me').set(authHeader(aluno));
    expect(me.body.user.seenAnnouncements).toBeUndefined();
  });
});

// A parte que mais tem "regra": cada anúncio novo é um evento próprio, e um usuário novo
// vê o que estiver ativo. Se estes testes caírem, o segundo anúncio nunca apareceria para
// quem já viu o primeiro.
describe('reabertura e retroatividade', () => {
  it('um anúncio NOVO reabre para quem já viu o anterior', async () => {
    const admin = await loginAs('admin');
    const a1 = await publicar(admin, { title: 'Anúncio 1', body: '...', roles: ['therapist'] });

    const aluno = await loginAs('aluno');
    await confirmar(aluno, a1.body.id);
    expect((await pendentes(aluno)).body).toEqual([]);   // viu o 1, está limpo

    await publicar(admin, { title: 'Anúncio 2', body: '...', roles: ['therapist'] });

    // O 2 reabre; o 1 (já confirmado) não volta.
    expect((await pendentes(aluno)).body.map((a) => a.title)).toEqual(['Anúncio 2']);
  });

  it('um usuário NOVO vê todos os anúncios ativos (retroativo)', async () => {
    const admin = await loginAs('admin');
    await publicar(admin, { title: 'Anúncio 1', body: '...', roles: ['therapist'] });
    await publicar(admin, { title: 'Anúncio 2', body: '...', roles: ['therapist'] });

    // Criado DEPOIS dos anúncios.
    await request(app).post('/api/admin/users').set(authHeader(admin))
      .send({ username: 'bob', password: 'bob123456', name: 'Bob', role: 'therapist' });
    const bob = await loginAs('bob', 'bob123456');

    expect((await pendentes(bob)).body.map((a) => a.title).sort()).toEqual(['Anúncio 1', 'Anúncio 2']);
  });

  it('anúncio DESPUBLICADO (active:false) some dos pop-ups', async () => {
    const admin = await loginAs('admin');
    const criado = await publicar(admin, { title: 'Temporário', body: '...', roles: ['therapist'] });

    await request(app).put(`/api/admin/announcements/${criado.body.id}`).set(authHeader(admin))
      .send({ active: false });

    const aluno = await loginAs('aluno');
    expect((await pendentes(aluno)).body).toEqual([]);
  });

  it('anúncios saem em ordem de criação (o mais antigo primeiro)', async () => {
    const admin = await loginAs('admin');
    await publicar(admin, { title: 'Primeiro', body: '...' });
    await publicar(admin, { title: 'Segundo', body: '...' });

    const aluno = await loginAs('aluno');
    expect((await pendentes(aluno)).body.map((a) => a.title)).toEqual(['Primeiro', 'Segundo']);
  });
});

describe('admin: gerenciar', () => {
  it('lista, edita e apaga', async () => {
    const admin = await loginAs('admin');
    const criado = await publicar(admin, { title: 'Original', body: '...' });

    const lista = await request(app).get('/api/admin/announcements').set(authHeader(admin));
    expect(lista.body.length).toBe(1);
    expect(lista.body[0].createdBy).toBe('admin');   // o admin VÊ os metadados

    await request(app).put(`/api/admin/announcements/${criado.body.id}`).set(authHeader(admin))
      .send({ title: 'Editado' });
    expect(readData('announcements.json')[0].title).toBe('Editado');

    await request(app).delete(`/api/admin/announcements/${criado.body.id}`).set(authHeader(admin));
    expect(readData('announcements.json')).toEqual([]);
  });

  it('aluno não lista nem apaga', async () => {
    const admin = await loginAs('admin');
    const criado = await publicar(admin, { title: 'x', body: 'y' });
    const aluno = await loginAs('aluno');
    expect((await request(app).get('/api/admin/announcements').set(authHeader(aluno))).status).toBe(403);
    expect((await request(app).delete(`/api/admin/announcements/${criado.body.id}`).set(authHeader(aluno))).status).toBe(403);
  });
});

// ---------------------------------------------------------------------
// Demanda #12: o anúncio tem TIPO (notificação × atualização do sistema).
// ---------------------------------------------------------------------
describe('tipo do anúncio (demanda #12)', () => {
  it('sem type → padrão "notification"; com type → respeitado', async () => {
    const admin = await loginAs('admin');
    expect((await publicar(admin, { title: 'a', body: 'b' })).body.type).toBe('notification');
    expect((await publicar(admin, { title: 'c', body: 'd', type: 'update' })).body.type).toBe('update');
  });

  it('type inválido cai no padrão "notification"', async () => {
    const admin = await loginAs('admin');
    expect((await publicar(admin, { title: 'x', body: 'y', type: 'hacker' })).body.type).toBe('notification');
  });

  it('o histórico separa por tipo: notificação → sino, atualização → updates', async () => {
    const admin = await loginAs('admin');
    await publicar(admin, { title: 'Aviso', body: '.', type: 'notification', roles: ['therapist'] });
    await publicar(admin, { title: 'Novidade', body: '.', type: 'update', roles: ['therapist'] });

    const aluno = await loginAs('aluno');
    const h = await request(app).get('/api/announcements/history').set(authHeader(aluno));
    expect(h.status).toBe(200);
    expect(h.body.notifications.map((a) => a.title)).toEqual(['Aviso']);
    expect(h.body.updates.map((a) => a.title)).toEqual(['Novidade']);
  });

  it('o histórico respeita o PAPEL (o aluno não vê o que é só de visitante)', async () => {
    const admin = await loginAs('admin');
    await publicar(admin, { title: 'Só visitante', body: '.', type: 'update', roles: ['visitor'] });

    const aluno = await loginAs('aluno');
    const h = await request(app).get('/api/announcements/history').set(authHeader(aluno));
    expect(h.body.updates).toEqual([]);
  });

  it('o histórico mostra o anúncio mesmo depois de confirmado no pop-up', async () => {
    const admin = await loginAs('admin');
    const criado = await publicar(admin, { title: 'Persiste', body: '.', type: 'notification', roles: ['therapist'] });

    const aluno = await loginAs('aluno');
    await confirmar(aluno, criado.body.id);   // fecha o pop-up

    // Some do pop-up…
    expect((await pendentes(aluno)).body).toEqual([]);
    // …mas continua no histórico do sino.
    const h = await request(app).get('/api/announcements/history').set(authHeader(aluno));
    expect(h.body.notifications.map((a) => a.title)).toEqual(['Persiste']);
  });

  it('despublicar (active:false) tira o anúncio do histórico também', async () => {
    const admin = await loginAs('admin');
    const criado = await publicar(admin, { title: 'Temporário', body: '.', type: 'update', roles: ['therapist'] });

    const aluno = await loginAs('aluno');
    expect((await request(app).get('/api/announcements/history').set(authHeader(aluno))).body.updates.length).toBe(1);

    await request(app).put(`/api/admin/announcements/${criado.body.id}`).set(authHeader(admin)).send({ active: false });
    expect((await request(app).get('/api/announcements/history').set(authHeader(aluno))).body.updates).toEqual([]);
  });

  it('o admin pode MUDAR o tipo depois (notificação ↔ atualização)', async () => {
    const admin = await loginAs('admin');
    const criado = await publicar(admin, { title: 'Muda', body: '.', type: 'notification', roles: ['therapist'] });

    await request(app).put(`/api/admin/announcements/${criado.body.id}`).set(authHeader(admin)).send({ type: 'update' });

    const aluno = await loginAs('aluno');
    const h = await request(app).get('/api/announcements/history').set(authHeader(aluno));
    expect(h.body.notifications).toEqual([]);
    expect(h.body.updates.map((a) => a.title)).toEqual(['Muda']);
  });
});
