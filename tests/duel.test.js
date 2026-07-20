// IMPORTANTE: helpers seta as envs antes de importar o app — manter como 1º require.
//
// Helpers de duelo (`seedMmr`, `waitCompleted`, `fullDuel`, as mensagens marcadas) moram
// em tests/helpers.js — estavam duplicados byte-a-byte aqui e em duel-notification.test.js.
const {
  app, request, resetData, writeData, readData,
  loginAs, loginVisitor, loginVisitorFull, authHeader,
  seedMmr, waitCompleted, fullDuel,
  DUEL_CHAR: CHAR, DUEL_MSGS_A: msgsA, DUEL_MSGS_B: msgsB,
} = require('./helpers');
const fs = require('fs');
const path = require('path');

describe('duelos', () => {
  beforeEach(() => resetData());

  // -------------------------------------------------------------------
  describe('criação', () => {
    it('cria duelo por convite in-app com status pending e campos esperados', async () => {
      const aluno = await loginAs('aluno');
      const res = await request(app).post('/api/duel').set(authHeader(aluno))
        .send({ characterId: CHAR, opponentUserId: '5', inviteMethod: 'system' });
      expect(res.status).toBe(200);
      expect(res.body.id).toBeTruthy();
      expect(res.body.token).toBeTruthy();
      expect(res.body.status).toBe('pending');
      expect(res.body.mode).toBe('training');
      expect(res.body.side).toBe('challenger');
      expect(res.body.character).toEqual({ id: CHAR, name: 'Sofia Test' });
      expect(res.body.opponent.userId).toBe('5');
      expect(res.body.opponent.accepted).toBe(false);
      expect(res.body.challenger.userId).toBe('3');
      // duelo gravado no disco
      expect(readData('duels.json').length).toBe(1);
    });

    it('modo competitive é PERSISTIDO (não só ecoado na resposta)', async () => {
      const aluno = await loginAs('aluno');
      const res = await request(app).post('/api/duel').set(authHeader(aluno))
        .send({ characterId: CHAR, opponentUserId: '5', inviteMethod: 'system', mode: 'competitive' });
      expect(res.body.mode).toBe('competitive');
      // O eco da resposta não prova nada: um `mode` lido do body e devolvido sem gravar
      // passaria. É o disco que decide se o duelo vai ranquear no finalizeDuel.
      expect(readData('duels.json')[0].mode).toBe('competitive');
    });

    it('modo inválido/ausente cai em training — no disco', async () => {
      const aluno = await loginAs('aluno');
      await request(app).post('/api/duel').set(authHeader(aluno))
        .send({ characterId: CHAR, opponentUserId: '5', inviteMethod: 'system', mode: 'ranqueado_hackeado' });
      expect(readData('duels.json')[0].mode).toBe('training');
    });

    it('duelo aberto (link/whatsapp) não tem oponente e vem taken=false pelo token', async () => {
      const aluno = await loginAs('aluno');
      const res = await request(app).post('/api/duel').set(authHeader(aluno))
        .send({ characterId: CHAR, inviteMethod: 'whatsapp' });
      expect(res.status).toBe(200);
      expect(res.body.opponent).toBe(null);
      const byTok = await request(app).get(`/api/duel/by-token/${res.body.token}`).set(authHeader(aluno));
      expect(byTok.body.taken).toBe(false);
      expect(byTok.body.challengerName).toBe('Aluno A');
    });

    // Demanda #2: o visitante CRIA duelo. O 403 que sobrou é da D9 — ele desafiou um
    // ALUNO (id '5'), e isso continua proibido. Os testes de arena vivem em security.
    it('visitante cria duelo entre visitantes; contra ALUNO → 403 (D9)', async () => {
      const v1 = await loginVisitorFull();

      const contraAluno = await request(app).post('/api/duel').set(authHeader(v1.token))
        .send({ characterId: CHAR, opponentUserId: '5', inviteMethod: 'system' });
      expect(contraAluno.status).toBe(403);

      const v2 = await loginVisitorFull();
      const contraVisitante = await request(app).post('/api/duel').set(authHeader(v1.token))
        .send({ characterId: CHAR, opponentUserId: v2.id, inviteMethod: 'system' });
      expect(contraVisitante.status).toBe(200);
    });

    it('characterId inexistente → 404', async () => {
      const aluno = await loginAs('aluno');
      const res = await request(app).post('/api/duel').set(authHeader(aluno))
        .send({ characterId: 'nao-existe', opponentUserId: '5', inviteMethod: 'system' });
      expect(res.status).toBe(404);
    });

    it('convidar a si mesmo → 400', async () => {
      const aluno = await loginAs('aluno');
      const res = await request(app).post('/api/duel').set(authHeader(aluno))
        .send({ characterId: CHAR, opponentUserId: '3', inviteMethod: 'system' });
      expect(res.status).toBe(400);
    });

    it('oponente inexistente (system) → 404', async () => {
      const aluno = await loginAs('aluno');
      const res = await request(app).post('/api/duel').set(authHeader(aluno))
        .send({ characterId: CHAR, opponentUserId: '999', inviteMethod: 'system' });
      expect(res.status).toBe(404);
    });

    it('lista de oponentes traz os pares da MESMA arena (D9)', async () => {
      const v = await loginVisitorFull();

      const aluno = await loginAs('aluno');
      const res = await request(app).get('/api/duel/opponents').set(authHeader(aluno));
      expect(res.status).toBe(200);
      const ids = res.body.map((o) => o.userId);
      expect(ids).toContain('5');
      expect(ids).toContain('6');
      expect(ids).not.toContain('3');    // você mesmo
      expect(ids).not.toContain('2');    // supervisor não entra
      expect(ids).not.toContain(v.id);   // visitante é de outra arena (D9)

      // E o visitante enxerga a arena dele: só visitantes, nunca alunos.
      const doVisitante = (await request(app).get('/api/duel/opponents').set(authHeader(v.token))).body;
      expect(doVisitante.map((o) => o.userId)).not.toContain('5');
    });
  });

  // -------------------------------------------------------------------
  describe('aceite', () => {
    it('oponente convidado aceita e o convite fica marcado como lido', async () => {
      const aluno = await loginAs('aluno');
      const aluno2 = await loginAs('aluno2');
      const create = await request(app).post('/api/duel').set(authHeader(aluno))
        .send({ characterId: CHAR, opponentUserId: '5', inviteMethod: 'system' });
      const duelId = create.body.id;

      // aluno2 recebe convite não lido
      const notif = await request(app).get('/api/notifications').set(authHeader(aluno2));
      expect(notif.body.unread).toBe(1);
      expect(notif.body.items.some((n) => n.type === 'duel_invite' && n.duelId === duelId)).toBe(true);

      const accept = await request(app).post(`/api/duel/${duelId}/accept`).set(authHeader(aluno2));
      expect(accept.status).toBe(200);
      expect(accept.body.side).toBe('opponent');
      expect(accept.body.opponent.accepted).toBe(true);
    });

    it('aceitar duas vezes pelo mesmo oponente é idempotente (ok)', async () => {
      const aluno = await loginAs('aluno');
      const aluno2 = await loginAs('aluno2');
      const create = await request(app).post('/api/duel').set(authHeader(aluno))
        .send({ characterId: CHAR, opponentUserId: '5', inviteMethod: 'system' });
      const duelId = create.body.id;
      expect((await request(app).post(`/api/duel/${duelId}/accept`).set(authHeader(aluno2))).status).toBe(200);
      const again = await request(app).post(`/api/duel/${duelId}/accept`).set(authHeader(aluno2));
      expect(again.status).toBe(200);
      expect(again.body.opponent.accepted).toBe(true);
    });

    it('challenger não pode aceitar o próprio duelo → 400', async () => {
      const aluno = await loginAs('aluno');
      const create = await request(app).post('/api/duel').set(authHeader(aluno))
        .send({ characterId: CHAR, opponentUserId: '5', inviteMethod: 'system' });
      const res = await request(app).post(`/api/duel/${create.body.id}/accept`).set(authHeader(aluno));
      expect(res.status).toBe(400);
    });

    it('aceite por token válido; token inválido → 404', async () => {
      const aluno = await loginAs('aluno');
      const create = await request(app).post('/api/duel').set(authHeader(aluno))
        .send({ characterId: CHAR, inviteMethod: 'whatsapp' });
      const token = create.body.token;

      const view = await request(app).get(`/api/duel/by-token/${token}`).set(authHeader(aluno));
      expect(view.status).toBe(200);

      const aluno2 = await loginAs('aluno2');
      const accept = await request(app).post(`/api/duel/by-token/${token}/accept`).set(authHeader(aluno2));
      expect(accept.status).toBe(200);
      expect(accept.body.opponent.userId).toBe('5');

      expect((await request(app).get('/api/duel/by-token/tokeninvalido').set(authHeader(aluno))).status).toBe(404);
      expect((await request(app).post('/api/duel/by-token/tokeninvalido/accept').set(authHeader(aluno2))).status).toBe(404);
    });

    it('segundo a aceitar um link já tomado → 409', async () => {
      const aluno = await loginAs('aluno');
      const create = await request(app).post('/api/duel').set(authHeader(aluno))
        .send({ characterId: CHAR, inviteMethod: 'whatsapp' });
      const token = create.body.token;
      const aluno2 = await loginAs('aluno2');
      const solo = await loginAs('solo');
      await request(app).post(`/api/duel/by-token/${token}/accept`).set(authHeader(aluno2));
      const res = await request(app).post(`/api/duel/by-token/${token}/accept`).set(authHeader(solo));
      expect(res.status).toBe(409);
    });

    // 🔒 CONCORRÊNCIA — o `withFileLock` é o diferencial do projeto (o All_OS não tem) e
    // não havia UM teste que o exercitasse. Cenário real: o desafiante manda o link no
    // grupo da turma e dois alunos clicam ao mesmo tempo. Sem o mutex, os dois leem o
    // duelo ainda livre, os dois gravam `opponent`, e o último write vence — o outro
    // aluno recebe 200 e fica achando que está no duelo, sem estar.
    it('dois aceites SIMULTÂNEOS pelo mesmo link → exatamente um 200 e um 409', async () => {
      const aluno = await loginAs('aluno');
      const create = await request(app).post('/api/duel').set(authHeader(aluno))
        .send({ characterId: CHAR, inviteMethod: 'whatsapp' });
      const token = create.body.token;

      const aluno2 = await loginAs('aluno2');
      const solo = await loginAs('solo');

      // Disparados no MESMO tick: sem serialização, os dois leem o mesmo estado.
      const [r1, r2] = await Promise.all([
        request(app).post(`/api/duel/by-token/${token}/accept`).set(authHeader(aluno2)),
        request(app).post(`/api/duel/by-token/${token}/accept`).set(authHeader(solo)),
      ]);

      const codes = [r1.status, r2.status].sort();
      expect(codes).toEqual([200, 409]);

      // E o disco tem UM só oponente — o mesmo que recebeu o 200.
      const disco = readData('duels.json');
      expect(disco.length).toBe(1);
      const vencedor = r1.status === 200 ? '5' : '6';
      expect(disco[0].opponent.userId).toBe(vencedor);
      expect(disco[0].opponent.accepted).toBe(true);
    });

    // Mesma corrida, agora pela rota in-app: o oponente convidado aceita duas vezes de
    // dois cliques rápidos. Aqui o esperado é 200+200 (o aceite é idempotente), mas o
    // disco NÃO pode ter o duelo duplicado nem o `messages` do oponente zerado duas vezes.
    it('aceites simultâneos do MESMO oponente são idempotentes e não corrompem o disco', async () => {
      const aluno = await loginAs('aluno');
      const aluno2 = await loginAs('aluno2');
      const create = await request(app).post('/api/duel').set(authHeader(aluno))
        .send({ characterId: CHAR, opponentUserId: '5', inviteMethod: 'system' });
      const duelId = create.body.id;

      const rs = await Promise.all([
        request(app).post(`/api/duel/${duelId}/accept`).set(authHeader(aluno2)),
        request(app).post(`/api/duel/${duelId}/accept`).set(authHeader(aluno2)),
      ]);
      expect(rs.map((r) => r.status)).toEqual([200, 200]);

      const disco = readData('duels.json');
      expect(disco.length).toBe(1);
      expect(disco[0].opponent.userId).toBe('5');
      expect(disco[0].opponent.accepted).toBe(true);
    });
  });

  // -------------------------------------------------------------------
  describe('sigilo das mensagens', () => {
    it('B NÃO vê as mensagens de A antes do fim; depois de completo ambos veem tudo', async () => {
      const aluno = await loginAs('aluno');
      const aluno2 = await loginAs('aluno2');
      const create = await request(app).post('/api/duel').set(authHeader(aluno))
        .send({ characterId: CHAR, opponentUserId: '5', inviteMethod: 'system' });
      const duelId = create.body.id;
      await request(app).post(`/api/duel/${duelId}/accept`).set(authHeader(aluno2));

      // A submete; B ainda não
      await request(app).post(`/api/duel/${duelId}/submit`).set(authHeader(aluno)).send({ messages: msgsA, durationSeconds: 120 });

      // B consulta ANTES de submeter: não pode conter a mensagem secreta de A
      const asB = await request(app).get(`/api/duel/${duelId}`).set(authHeader(aluno2));
      expect(asB.status).toBe(200);
      expect(asB.body.status).not.toBe('completed');
      const serializedB = JSON.stringify(asB.body);
      expect(serializedB).not.toContain('MENSAGEM_SECRETA_DO_A_1234');
      expect(asB.body.challengerMessages).toBeUndefined();
      expect(asB.body.opponentMessages).toBeUndefined();

      // B submete → completa
      await request(app).post(`/api/duel/${duelId}/submit`).set(authHeader(aluno2)).send({ messages: msgsB, durationSeconds: 90 });
      const done = await waitCompleted(aluno2, duelId);
      expect(done.body.status).toBe('completed');
      const serializedDone = JSON.stringify(done.body);
      // agora B vê as mensagens de A e as próprias
      expect(serializedDone).toContain('MENSAGEM_SECRETA_DO_A_1234');
      expect(serializedDone).toContain('MENSAGEM_SECRETA_DO_B_5678');
      expect(done.body.challengerMessages).toBeTruthy();
      expect(done.body.opponentMessages).toBeTruthy();
    });

    it('admin vê as mensagens dos dois lados mesmo antes de completar', async () => {
      const aluno = await loginAs('aluno');
      const aluno2 = await loginAs('aluno2');
      const admin = await loginAs('admin');
      const create = await request(app).post('/api/duel').set(authHeader(aluno))
        .send({ characterId: CHAR, opponentUserId: '5', inviteMethod: 'system' });
      const duelId = create.body.id;
      await request(app).post(`/api/duel/${duelId}/accept`).set(authHeader(aluno2));
      await request(app).post(`/api/duel/${duelId}/submit`).set(authHeader(aluno)).send({ messages: msgsA, durationSeconds: 120 });

      const asAdmin = await request(app).get(`/api/duel/${duelId}`).set(authHeader(admin));
      expect(asAdmin.status).toBe(200);
      expect(JSON.stringify(asAdmin.body)).toContain('MENSAGEM_SECRETA_DO_A_1234');
      expect(asAdmin.body.challengerMessages).toBeTruthy();
    });
  });

  // -------------------------------------------------------------------
  describe('submit', () => {
    it('após 1º submit fica pending; após 2º submit vira completed com result', async () => {
      const aluno = await loginAs('aluno');
      const aluno2 = await loginAs('aluno2');
      const create = await request(app).post('/api/duel').set(authHeader(aluno))
        .send({ characterId: CHAR, opponentUserId: '5', inviteMethod: 'system' });
      const duelId = create.body.id;
      await request(app).post(`/api/duel/${duelId}/accept`).set(authHeader(aluno2));

      const sub1 = await request(app).post(`/api/duel/${duelId}/submit`).set(authHeader(aluno)).send({ messages: msgsA, durationSeconds: 120 });
      expect(sub1.status).toBe(200);
      expect(sub1.body.status).toBe('pending');

      const sub2 = await request(app).post(`/api/duel/${duelId}/submit`).set(authHeader(aluno2)).send({ messages: msgsB, durationSeconds: 90 });
      expect(sub2.status).toBe(200);
      const done = await waitCompleted(aluno, duelId);
      expect(done.body.status).toBe('completed');
      expect(done.body.result).toBeTruthy();
    });

    it('submeter em duelo já completo → 400', async () => {
      const { aluno, duelId } = await fullDuel();
      const res = await request(app).post(`/api/duel/${duelId}/submit`).set(authHeader(aluno)).send({ messages: msgsA, durationSeconds: 1 });
      expect(res.status).toBe(400);
    });
  });

  // -------------------------------------------------------------------
  // ACESSO — tabelas.
  //
  // Os 403 (não-participante) e 404 (id inexistente) estavam espalhados por 5 `describe`s,
  // um `it` de cada vez, e por isso ficaram FUROS: `DELETE /api/duel/:id` nunca foi testado
  // com id inexistente e `POST /:id/submit` nunca com 404. Uma tabela por rota fecha isso e
  // torna óbvio o que falta quando uma rota nova aparecer.
  describe('acesso: não-participante → 403 (todas as rotas de :id)', () => {
    const rotas = [
      ['GET',    (id) => `/api/duel/${id}`],
      ['POST',   (id) => `/api/duel/${id}/accept`],
      ['POST',   (id) => `/api/duel/${id}/submit`],
      ['DELETE', (id) => `/api/duel/${id}`],
      ['GET',    (id) => `/api/duel/${id}/export`],
    ];

    it.each(rotas)('%s %s → 403 para quem não participa', async (metodo, url) => {
      const aluno = await loginAs('aluno');
      const create = await request(app).post('/api/duel').set(authHeader(aluno))
        .send({ characterId: CHAR, opponentUserId: '5', inviteMethod: 'system' });
      const duelId = create.body.id;

      // 'solo' (id 6) é aluno da MESMA arena — o 403 aqui é por não participar deste
      // duelo, não por arena (esse caso vive em security.test.js).
      const solo = await loginAs('solo');
      const req = request(app)[metodo.toLowerCase()](url(duelId)).set(authHeader(solo));
      const res = await (metodo === 'POST' ? req.send({ messages: msgsA, durationSeconds: 1 }) : req);
      expect(res.status).toBe(403);
    });
  });

  describe('acesso: id inexistente → 404 (todas as rotas de :id)', () => {
    const rotas = [
      ['GET',    '/api/duel/nao-existe'],
      ['POST',   '/api/duel/nao-existe/accept'],
      ['POST',   '/api/duel/nao-existe/submit'],   // era um furo
      ['DELETE', '/api/duel/nao-existe'],          // era um furo
      ['GET',    '/api/duel/nao-existe/export'],
    ];

    it.each(rotas)('%s %s → 404', async (metodo, url) => {
      const aluno = await loginAs('aluno');
      const req = request(app)[metodo.toLowerCase()](url).set(authHeader(aluno));
      const res = await (metodo === 'POST' ? req.send({ messages: msgsA, durationSeconds: 1 }) : req);
      // 404 e não 403: um id que não existe não pode dar pista de autorização.
      expect(res.status).toBe(404);
    });
  });

  // -------------------------------------------------------------------
  describe('resultado (empate demo 50x50)', () => {
    it('result tem o shape completo e é empate com notas iguais', async () => {
      const { duel } = await fullDuel();
      const r = duel.result;
      expect(r).toBeTruthy();
      expect(r.winner).toBe('draw');
      expect(r.scoreChallenger).toBe(50);
      expect(r.scoreOpponent).toBe(50);
      expect(r.criteriaChallenger).toBeTruthy();
      expect(r.criteriaOpponent).toBeTruthy();
      expect(typeof r.evaluation).toBe('string');
      expect(r.completedAt).toBeTruthy();
    });
  });

  // -------------------------------------------------------------------
  // MMR do duelo.
  //
  // Os casos `training → unranked` e `competitivo em calibração → unranked` VIVIAM aqui e
  // em duel-notification.test.js. Lá eles asseram tudo isto E o `mmrDelta: null` da
  // notificação — são estritamente mais fortes. Removidos daqui (fonte única lá).
  describe('MMR do duelo', () => {
    it('competitivo entre 2 reais fora da calibração → ranked, com os VALORES exatos', async () => {
      const aluno = await loginAs('aluno');
      const aluno2 = await loginAs('aluno2');
      // Cenário 100% determinístico:
      //   challenger P=50 n=10 · opponent P=70 n=10 · personagem novo (D=50) · empate 50×50.
      //   PvP: aposta A = 0,20·50 = 10 · aposta B = 0,20·70 = 14 · pool = 24.
      //        empate → metade pra cada (12) → deltaA = +2 · deltaB = −2.
      //   Solo (A): S_esp = 50 + 0,5·(50−50) = 50 → S_aj = 50 → P não se move (fica 50).
      //   Solo (B): joga contra o D já ajustado por A; K_p(10) ≈ 0,189 → P cai um pouco.
      // Trava os NÚMEROS: com `delta > 0` / `P !== 50`, trocar o PVP_STAKE de 0,20 para
      // 0,50 — ou inverter deltaA com deltaB — passava no teste.
      seedMmr({ 3: { P: 50, n: 10, W: [] }, 5: { P: 70, n: 10, W: [] } });
      const create = await request(app).post('/api/duel').set(authHeader(aluno))
        .send({ characterId: CHAR, opponentUserId: '5', inviteMethod: 'system', mode: 'competitive' });
      const duelId = create.body.id;
      await request(app).post(`/api/duel/${duelId}/accept`).set(authHeader(aluno2));
      await request(app).post(`/api/duel/${duelId}/submit`).set(authHeader(aluno)).send({ messages: msgsA, durationSeconds: 60 });
      await request(app).post(`/api/duel/${duelId}/submit`).set(authHeader(aluno2)).send({ messages: msgsB, durationSeconds: 60 });

      const done = await waitCompleted(aluno, duelId);
      const m = done.body.result.mmr;
      expect(m.ranked).toBe(true);

      // shape EXATO exigido pelo front — trava o bug de vazar estado do engine
      expect(Object.keys(m).sort()).toEqual(['challenger', 'characterDifficulty', 'opponent', 'ranked']);
      for (const side of ['challenger', 'opponent']) {
        expect(Object.keys(m[side]).sort()).toEqual(['after', 'before', 'delta', 'pvpDelta']);
      }
      // NÃO pode vazar estado interno do engine
      for (const k of ['playerA', 'playerB', 'resultA', 'resultB', 'pvp', 'character']) {
        expect(m[k]).toBeUndefined();
      }

      // O pvpDelta é fechado: pool 24, empate → ±2. Qualquer mexida no PVP_STAKE quebra aqui.
      expect(m.challenger.pvpDelta).toBe(2);
      expect(m.opponent.pvpDelta).toBe(-2);
      // E os deltas TOTAIS (solo + pvp) não são simétricos — o solo move cada um por conta.
      expect(m.challenger.before).toBe(50);
      expect(m.opponent.before).toBe(70);
      expect(m.challenger.delta).toBeGreaterThan(0);
      expect(m.opponent.delta).toBeLessThan(0);

      // Disco: cada jogador com o SEU P (aqui está o bug de gravar out.playerA nos dois).
      const mmrFile = readData('mmr.json');
      expect(mmrFile.players['3'].P).toBeCloseTo(52, 6);        // 50 (solo neutro) + 2 (pvp)
      expect(mmrFile.players['5'].P).toBeLessThan(70 - 2);      // caiu no solo E perdeu 2 no pvp
      expect(mmrFile.players['3'].n).toBe(11);
      expect(mmrFile.players['5'].n).toBe(11);
      expect(mmrFile.players['3'].P).not.toBe(mmrFile.players['5'].P);
    });

    // Demanda #2 — INVERSÃO do teste antigo (`ranked:false, reason:'visitor'`). Duelo de
    // visitante agora RANQUEIA. É seguro justamente porque a D9 garante que os dois lados
    // são da mesma arena: o rating do visitante nunca entra na conta de um aluno.
    it('visitante × visitante competitivo → RANQUEIA, e cada um leva o SEU rating (D3)', async () => {
      const v1 = await loginVisitorFull();
      const v2 = await loginVisitorFull();
      // MMRs DIFERENTES de propósito. Com os dois em 60, um `applyDuelMmr` que gravasse
      // `out.playerA` nos DOIS ids (copy-paste plausível) passaria despercebido — os dois
      // teriam n=11 e P idêntico "por acaso". Assimetria = detecção.
      seedMmr({ [v1.id]: { P: 50, n: 10, W: [] }, [v2.id]: { P: 70, n: 10, W: [] } });

      const create = await request(app).post('/api/duel').set(authHeader(v1.token))
        .send({ characterId: CHAR, inviteMethod: 'whatsapp', mode: 'competitive' });
      const { id: duelId, token } = create.body;

      await request(app).post(`/api/duel/by-token/${token}/accept`).set(authHeader(v2.token));
      await request(app).post(`/api/duel/${duelId}/submit`).set(authHeader(v2.token)).send({ messages: msgsB, durationSeconds: 60 });
      await request(app).post(`/api/duel/${duelId}/submit`).set(authHeader(v1.token)).send({ messages: msgsA, durationSeconds: 60 });

      const done = await waitCompleted(v1.token, duelId);
      expect(done.body.result.mmr.ranked).toBe(true);
      expect(done.body.result.mmr.reason).toBeUndefined();

      // Mesmo cenário do teste acima (P 50 vs 70, empate 50×50) → mesmos números.
      const store = readData('mmr.json');
      expect(store.players[v1.id].n).toBe(11);
      expect(store.players[v2.id].n).toBe(11);
      expect(store.players[v1.id].P).toBeCloseTo(52, 6);      // challenger: subiu 2 (pool)
      expect(store.players[v2.id].P).toBeLessThan(68);        // opponent: perdeu 2 + solo
      expect(store.players[v1.id].P).not.toBe(store.players[v2.id].P);
    });
  });

  // -------------------------------------------------------------------
  describe('cancelamento', () => {
    it('challenger cancela duelo pendente e ele some para os dois; convite é removido', async () => {
      const aluno = await loginAs('aluno');
      const aluno2 = await loginAs('aluno2');
      const create = await request(app).post('/api/duel').set(authHeader(aluno))
        .send({ characterId: CHAR, opponentUserId: '5', inviteMethod: 'system' });
      const duelId = create.body.id;

      const socBefore = await request(app).get('/api/duels/social').set(authHeader(aluno));
      expect(socBefore.body[0].duels[0].canCancel).toBe(true);
      expect(socBefore.body[0].duels[0].canExport).toBe(false);

      const cancel = await request(app).delete(`/api/duel/${duelId}`).set(authHeader(aluno));
      expect(cancel.status).toBe(200);

      expect((await request(app).get(`/api/duel/${duelId}`).set(authHeader(aluno))).status).toBe(404);
      expect((await request(app).get('/api/duels/social').set(authHeader(aluno))).body).toEqual([]);
    });

    it('não cancela duelo já aceito → 400', async () => {
      const aluno = await loginAs('aluno');
      const aluno2 = await loginAs('aluno2');
      const create = await request(app).post('/api/duel').set(authHeader(aluno))
        .send({ characterId: CHAR, opponentUserId: '5', inviteMethod: 'system' });
      const duelId = create.body.id;
      await request(app).post(`/api/duel/${duelId}/accept`).set(authHeader(aluno2));
      const res = await request(app).delete(`/api/duel/${duelId}`).set(authHeader(aluno));
      expect(res.status).toBe(400);
    });
  });

  // -------------------------------------------------------------------
  describe('TTL / prune', () => {
    const { execFileSync } = require('child_process');
    const os = require('os');

    // Além do boot, ALGUMAS rotas de leitura disparam a limpeza — como no All_OS. Sem
    // isso, um duelo expirado só sumiria ao reiniciar o servidor.
    const EXPIRED = () => new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString();
    const FRESH = () => new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();

    function seedDuels() {
      const mk = (id, createdAt) => ({
        id, token: 'tok-' + id, createdAt, status: 'completed', mode: 'training',
        character: { id: CHAR, name: 'Sofia Test' },
        challenger: { userId: '3', name: 'Aluno A', state: 'submitted', accepted: true, messages: [] },
        opponent: { userId: '5', name: 'Aluno B', state: 'submitted', accepted: true, messages: [] },
        result: { winner: 'draw', scoreChallenger: 50, scoreOpponent: 50 },
      });
      writeData('duels.json', [mk('duel-velho', EXPIRED()), mk('duel-novo', FRESH())]);
    }

    // Tabela (rota → prune?). Os 3 testes anteriores eram o mesmo corpo com um `expect`
    // invertido; como tabela, a assimetria fica EXPLÍCITA — e é ela o ponto:
    //
    // `GET /api/duel/:id` NÃO prune de propósito. É a rota de polling do DuelSession, e
    // `pruneExpiredDuels` escreve em duels.json SEM `withFileLock` — prunar aqui poderia
    // atropelar a escrita do resultado feita pelo `finalizeDuel`. O All_OS também só
    // prune em /social e /export.
    const rotas = [
      ['GET /api/duels/social',      (id) => '/api/duels/social',            true],
      ['GET /api/duel/:id/export',   (id) => `/api/duel/${id}/export`,       true],
      ['GET /api/duel/:id (polling)', (id) => `/api/duel/${id}`,             false],
    ];

    it.each(rotas)('%s → prune=%s (o duelo novo sobrevive sempre)', async (_nome, url, prunes) => {
      seedDuels();
      const token = await loginAs('aluno');
      const res = await request(app).get(url('duel-novo')).set(authHeader(token));
      expect(res.status).toBe(200);

      const ids = readData('duels.json').map((d) => d.id);
      expect(ids).toContain('duel-novo');                 // recente nunca some
      expect(ids.includes('duel-velho')).toBe(!prunes);   // o expirado só some onde prune
    });

    it('depois de limpo, o duelo expirado dá 404 (o recente segue acessível)', async () => {
      seedDuels();
      const token = await loginAs('aluno');
      // O prune roda dentro do /social; depois dele o duelo velho não existe mais.
      await request(app).get('/api/duels/social').set(authHeader(token));
      expect((await request(app).get('/api/duel/duel-velho').set(authHeader(token))).status).toBe(404);
      expect((await request(app).get('/api/duel/duel-novo').set(authHeader(token))).status).toBe(200);
    });

    // O prune também roda no boot. Como o app aqui é REQUERIDO (não é o main), esse
    // caminho só dá para exercitar num processo separado, com DATA_DIR próprio.
    it('remove duelo mais antigo que DUEL_TTL_MS (30d) no boot; preserva os recentes', () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'genus-ttl-'));
      const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString(); // 40d > 30d
      const recent = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString(); // 5d < 30d
      const mkDuel = (id, createdAt) => ({
        id, token: 't-' + id, createdAt, mode: 'training', status: 'completed',
        inviteMethod: 'link', character: { id: CHAR, name: 'Sofia Test' },
        challenger: { userId: '3', name: 'Aluno A', accepted: true, state: 'submitted', messages: [] },
        opponent: { userId: '5', name: 'Aluno B', accepted: true, state: 'submitted', messages: [] },
        result: { winner: 'draw', scoreChallenger: 50, scoreOpponent: 50 },
      });
      // fixtures mínimas exigidas pelo boot
      fs.writeFileSync(path.join(dir, 'users.json'), JSON.stringify([]));
      fs.writeFileSync(path.join(dir, 'duels.json'), JSON.stringify([
        mkDuel('duel-antigo', old),
        mkDuel('duel-recente', recent),
      ], null, 2));

      const appPath = path.join(__dirname, '..', 'server', 'index.js');
      // Executa server/index.js como MAIN (require.main === module → dispara
      // pruneExpiredDuels no boot). Roda em background e matamos logo após o prune.
      const child = require('child_process').spawn(
        process.execPath, [appPath],
        {
          stdio: 'ignore',
          env: {
            ...process.env,
            NODE_ENV: 'test',
            JWT_SECRET: 'a'.repeat(48),
            DATA_DIR: dir,
            OPENAI_API_KEY: '',
            PORT: '0',
          },
        },
      );
      // dá tempo do boot rodar o prune (síncrono) e sobe o listen; então mata.
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        const cur = JSON.parse(fs.readFileSync(path.join(dir, 'duels.json'), 'utf-8'));
        if (cur.length < 2) break; // prune já rodou
        execFileSync('sleep', ['0.05']);
      }
      child.kill('SIGKILL');

      const ids = JSON.parse(fs.readFileSync(path.join(dir, 'duels.json'), 'utf-8')).map((d) => d.id);
      expect(ids).not.toContain('duel-antigo');
      expect(ids).toContain('duel-recente');
      fs.rmSync(dir, { recursive: true, force: true });
    });
  });

  // -------------------------------------------------------------------
  describe('notificações', () => {
    it('convite gera notificação para o oponente; resultado notifica os dois lados', async () => {
      const { aluno, aluno2, duelId } = await fullDuel();

      const rn1 = await request(app).get('/api/notifications').set(authHeader(aluno));
      expect(rn1.body.items.some((n) => n.type === 'duel_result' && n.duelId === duelId)).toBe(true);
      const rn2 = await request(app).get('/api/notifications').set(authHeader(aluno2));
      expect(rn2.body.items.some((n) => n.type === 'duel_result' && n.duelId === duelId)).toBe(true);
      // aluno2 também tinha recebido o convite
      expect(rn2.body.items.some((n) => n.type === 'duel_invite' && n.duelId === duelId)).toBe(true);
    });

    it('visitante não recebe notificação de resultado (id efêmero)', async () => {
      const aluno = await loginAs('aluno');
      const create = await request(app).post('/api/duel').set(authHeader(aluno))
        .send({ characterId: CHAR, inviteMethod: 'whatsapp' });
      const { id: duelId, token } = create.body;
      const visitor = await loginVisitor();
      await request(app).post(`/api/duel/by-token/${token}/accept`).set(authHeader(visitor));
      await request(app).post(`/api/duel/${duelId}/submit`).set(authHeader(visitor)).send({ messages: msgsB, durationSeconds: 60 });
      await request(app).post(`/api/duel/${duelId}/submit`).set(authHeader(aluno)).send({ messages: msgsA, durationSeconds: 60 });
      await waitCompleted(aluno, duelId);
      const vnotif = await request(app).get('/api/notifications').set(authHeader(visitor));
      expect(vnotif.body).toEqual({ items: [], unread: 0 });
    });
  });

  // -------------------------------------------------------------------
  describe('GET /api/duels/social', () => {
    it('agrupa por oponente com shape achatado wins/losses/draws e duels[]', async () => {
      const { aluno, aluno2, duelId } = await fullDuel();

      const soc = await request(app).get('/api/duels/social').set(authHeader(aluno));
      expect(soc.body.length).toBe(1);
      const g = soc.body[0];
      expect(g.userId).toBe('5');
      expect(g.name).toBe('Aluno B');
      expect(g).toHaveProperty('profilePhoto');
      expect(g.wins).toBe(0);
      expect(g.losses).toBe(0);
      expect(g.draws).toBe(1);
      expect(g.duels.length).toBe(1);
      const d = g.duels[0];
      expect(d.id).toBe(duelId);
      expect(d.status).toBe('completed');
      expect(d.mode).toBe('training');
      expect(d.characterName).toBe('Sofia Test');
      expect(d.outcome).toBe('draw');
      expect(d.scoreMine).toBe(50);
      expect(d.scoreTheirs).toBe(50);
      expect(d.canCancel).toBe(false);
      expect(d.canExport).toBe(true);
      // o shape all_os (opponent aninhado / count) NÃO existe aqui
      expect(g.opponent).toBeUndefined();
      expect(g.count).toBeUndefined();

      // do lado do aluno2, o oponente é o Aluno A
      const soc2 = await request(app).get('/api/duels/social').set(authHeader(aluno2));
      expect(soc2.body[0].name).toBe('Aluno A');
      expect(soc2.body[0].draws).toBe(1);
    });

    it('visitante recebe lista vazia', async () => {
      const visitor = await loginVisitor();
      const res = await request(app).get('/api/duels/social').set(authHeader(visitor));
      expect(res.body).toEqual([]);
    });
  });

  // -------------------------------------------------------------------
  describe('GET /api/duel/:id/export', () => {
    it('participante baixa o texto do duelo concluído', async () => {
      const { aluno, duelId } = await fullDuel();

      const exp = await request(app).get(`/api/duel/${duelId}/export`).set(authHeader(aluno));
      expect(exp.status).toBe(200);
      expect(exp.headers['content-disposition']).toMatch(/attachment; filename="duelo-.*\.txt"/);
      expect(exp.text).toContain('AVALIAÇÃO COMPARATIVA');
      expect(exp.text).toContain('Sofia Test');
      expect(exp.text).toContain('Aluno A');
      expect(exp.text).toContain('Aluno B');
    });

    it('export de duelo não concluído → 400', async () => {
      const aluno = await loginAs('aluno');
      const create = await request(app).post('/api/duel').set(authHeader(aluno))
        .send({ characterId: CHAR, opponentUserId: '5', inviteMethod: 'system' });
      const res = await request(app).get(`/api/duel/${create.body.id}/export`).set(authHeader(aluno));
      expect(res.status).toBe(400);
    });
  });
});
