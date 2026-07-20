// PvP (duelos) — engine puro, sem HTTP.
const mmr = require('../server/mmr');

// Jogador fora da calibração (n alto) com MMR P fixo.
function player(P, n = 10) {
  return { P, n, W: [] };
}

describe('processDuel — exemplos do doc (PvP)', () => {
  it('Exemplo 1: favorito vence mas não domina (A 75 vs B 25, 60×40 → A −3 / B +3)', () => {
    const r = mmr.processDuel(player(75), player(25), undefined, 60, 40);
    expect(r.ranked).toBe(true);
    expect(r.pvp.pool).toBeCloseTo(20, 6);
    expect(r.pvp.deltaA).toBeCloseTo(-3, 6);
    expect(r.pvp.deltaB).toBeCloseTo(3, 6);
  });

  it('Exemplo 2: underdog domina (35×65 → A −8 / B +8)', () => {
    const r = mmr.processDuel(player(75), player(25), undefined, 35, 65);
    expect(r.pvp.deltaA).toBeCloseTo(-8, 6);
    expect(r.pvp.deltaB).toBeCloseTo(8, 6);
  });

  it('80×20 é bloqueado pelo anti-smurf (20 < 25), apesar da tabela do Exemplo 3', () => {
    const r = mmr.processDuel(player(75), player(25), undefined, 80, 20);
    expect(r.ranked).toBe(false);
    expect(r.reason).toBe('anti_smurf');
  });

  it('break-even: favorito com 3× a nota do oponente fica com delta ~0', () => {
    const r = mmr.processDuel(player(75), player(25), undefined, 75, 25);
    expect(r.ranked).toBe(true);
    expect(r.pvp.deltaA).toBeCloseTo(0, 6);
    expect(r.pvp.deltaB).toBeCloseTo(0, 6);
  });
});

// ---------------------------------------------------------------------------
// GUARDAS — antes eram 7 `it`s que só variavam (n_A, n_B, S_A, S_B) e conferiam
// `{ranked, reason}`. Como tabela, o espaço coberto fica visível — e a lacuna que ele
// expõe é a FRONTEIRA da calibração no PvP: nenhum teste tocava n = 4 vs n = 5, que é
// justamente onde o `<` do engine pode virar `<=` sem ninguém perceber.
// ---------------------------------------------------------------------------
describe('processDuel — guardas (tabela n_A × n_B × S_A × S_B)', () => {
  const C = mmr.CALIBRATION_MATCHES; // 5
  const MIN = mmr.PVP_MIN_SCORE;     // 25

  const casos = [
    // [descrição, n_A, n_B, S_A, S_B, ranked, reason]
    ['A ainda calibra',                        2,     10,    70,    60,    false, 'calibrating'],
    ['B ainda calibra',                        10,    0,     70,    60,    false, 'calibrating'],
    ['os dois calibram',                       0,     0,     70,    60,    false, 'calibrating'],
    // Precedência: calibração é checada ANTES do anti-smurf. Se as duas violações
    // aparecem juntas, o motivo reportado ao aluno é 'calibrating'.
    ['calibração tem precedência sobre smurf', 1,     10,    70,    10,    false, 'calibrating'],
    ['só A abaixo do mínimo',                  10,    10,    MIN-1, 80,    false, 'anti_smurf'],
    ['só B abaixo do mínimo',                  10,    10,    80,    MIN-1, false, 'anti_smurf'],
    ['os dois abaixo do mínimo',               10,    10,    10,    10,    false, 'anti_smurf'],
    ['nota EXATAMENTE no mínimo passa',        10,    10,    MIN,   MIN,   true,  null],
    // 🔎 FRONTEIRA da calibração — a lacuna que a tabela revelou. `calibrating = n < 5`:
    // com n = 4 (partidas 1..5 concluídas? não: 4 concluídas) ainda calibra; com n = 5
    // (a 5ª já concluída) está maduro. Um `<=` no engine trocaria estes dois resultados.
    ['n_A = C−1 (4) ainda calibra',            C - 1, C,     70,    60,    false, 'calibrating'],
    ['n_B = C−1 (4) ainda calibra',            C,     C - 1, 70,    60,    false, 'calibrating'],
    ['n_A = n_B = C (5) já está maduro',       C,     C,     70,    60,    true,  null],
  ];

  it.each(casos)('%s (n=%i/%i, S=%i/%i) → ranked=%s reason=%s', (_desc, nA, nB, sA, sB, ranked, reason) => {
    const r = mmr.processDuel(player(60, nA), player(60, nB), undefined, sA, sB);
    expect(r.ranked).toBe(ranked);
    expect(r.reason).toBe(reason);
    // Não-rankeado NÃO calcula pool: nada de estado a aplicar.
    if (!ranked) expect(r.pvp).toBeUndefined();
    else expect(r.pvp).toBeTruthy();
  });

  it('nota crua fora de 0..100 é clampada antes da checagem anti-smurf', () => {
    // -50 → 0 < 25 → bloqueia; e 200 → 100 no lado que passa.
    const r = mmr.processDuel(player(60), player(60), undefined, 200, -50);
    expect(r.S_A).toBe(100);
    expect(r.S_B).toBe(0);
    expect(r.ranked).toBe(false);
    expect(r.reason).toBe('anti_smurf');
  });
});

// ---------------------------------------------------------------------------
// 🔴 NaN — bug REAL do engine, corrigido em server/mmr.js (`safeScore`).
//
// `clamp(Number(x), 0, 100)` NÃO segura NaN: `Math.max(0, Math.min(100, NaN))` é NaN, e
// todo comparativo com NaN é `false` — então nem o anti-smurf (`S < 25`) pegava. O
// resultado era `ranked: true` com `P: NaN` gravado em mmr.json. E no PvP o estrago é
// DOBRADO: a pool usa `S_A + S_B`, então um NaN de um lado contamina os deltas dos dois.
// Como o P é lido de volta na partida seguinte, o NaN é PERMANENTE.
//
// Hoje as rotas filtram (`Number.isFinite` no /api/logs, `comparativeScores` no duelo),
// então o caso não é alcançável por HTTP. Mas o engine é público e é ele quem produz o
// estado persistido — a defesa pertence a quem escreve, não a quem chama.
// ---------------------------------------------------------------------------
describe('processDuel — nota inválida não envenena o rating (guarda de NaN)', () => {
  it.each([
    ['NaN',       NaN],
    ['undefined', undefined],
    ['null',      null],
    ['string',    'abc'],
    ['objeto',    {}],
    ['array',     []],
  ])('S_A = %s → nota 0 → anti_smurf (nenhum P vira NaN)', (_nome, ruim) => {
    const r = mmr.processDuel(player(60), player(60), undefined, ruim, 60);
    expect(r.S_A).toBe(0);
    expect(r.ranked).toBe(false);
    expect(r.reason).toBe('anti_smurf');
    // Não-rankeado não mexe em ninguém — mas o ponto é que ANTES isto dava ranked:true.
    expect(r.playerA).toBeUndefined();
    expect(r.playerB).toBeUndefined();
  });

  it('nem sequer o jogador do lado BOM é contaminado (a pool acopla os dois)', () => {
    const r = mmr.processDuel(player(60), player(60), undefined, NaN, 90);
    expect(r.ranked).toBe(false);
    // O antigo bug: soma = NaN + 90 = NaN → fracA/fracB NaN → deltaA e deltaB NaN → os
    // DOIS jogadores gravados com P = NaN, inclusive o que tirou 90.
    expect(r.pvp).toBeUndefined();
  });

  it('updateMatch (PvE) também não grava P = NaN', () => {
    const { player: p, result } = mmr.updateMatch(undefined, undefined, NaN);
    expect(result.S).toBe(0);
    expect(Number.isFinite(p.P)).toBe(true);
    expect(Number.isFinite(result.P_after)).toBe(true);
    // Nota inválida é tratada como 0 (leitura conservadora: quem não tem nota não pontua).
    expect(result.P_after).toBeCloseTo(25, 6); // (1−0,5)·50 + 0,5·0
  });

  it('safeScore: número válido passa intacto; lixo vira 0; fora da faixa é clampado', () => {
    expect(mmr.safeScore(73)).toBe(73);
    expect(mmr.safeScore('73')).toBe(73);
    expect(mmr.safeScore(0)).toBe(0);
    expect(mmr.safeScore(150)).toBe(100);
    expect(mmr.safeScore(-20)).toBe(0);
    for (const ruim of [NaN, Infinity, -Infinity, undefined, null, '', 'abc', {}, []]) {
      expect(mmr.safeScore(ruim), JSON.stringify(ruim)).toBe(0);
    }
  });
});

// ---------------------------------------------------------------------------
// SOMA ZERO. Eram 4 testes que se sobrepunham: "empate → deltaA === −deltaB",
// "vitória de A → soma zero", "conservação em vários cenários" e "empate com MMRs
// diferentes". A soma zero é uma CONSEQUÊNCIA ALGÉBRICA da pool (o teste de pool prova
// `recebidoA + recebidoB === pool === apostaA + apostaB`, logo
// `deltaA + deltaB = (recebidos) − (apostas) = 0`), então não precisa de 3 testes.
// Sobra o que a pool NÃO prova: os SINAIS e a MAGNITUDE.
// ---------------------------------------------------------------------------
describe('processDuel — sinais e magnitude do delta PvP', () => {
  it.each([
    // [descrição, P_A, P_B, S_A, S_B, deltaA esperado]
    ['empate com MMRs iguais → ninguém ganha nada',       60, 60, 70, 70,  0],
    // A=50 aposta 10, B=70 aposta 14, pool 24 → 12 cada → A +2, B −2. Quem tem MMR
    // menor apostou menos e por isso ganha no empate.
    ['empate com MMRs diferentes → o de MMR menor ganha', 50, 70, 50, 50,  2],
    // MMRs iguais (pool 24, 12 de aposta cada): A leva 80/(80+40) = 2/3 → 16 → +4.
    ['A vence → deltaA > 0 e deltaB < 0',                 60, 60, 80, 40,  4],
  ])('%s', (_desc, pa, pb, sA, sB, esperadoA) => {
    const r = mmr.processDuel(player(pa), player(pb), undefined, sA, sB);
    expect(r.ranked).toBe(true);
    expect(r.pvp.deltaA).toBeCloseTo(esperadoA, 6);
    // Soma zero: consequência da pool, mas conferida uma vez aqui como rede.
    expect(r.pvp.deltaB).toBeCloseTo(-esperadoA, 6);
  });
});

describe('processDuel — formato do retorno rankeado', () => {
  it('tem todas as chaves documentadas', () => {
    const r = mmr.processDuel(player(60), player(60), undefined, 70, 50);
    expect(r).toHaveProperty('ranked', true);
    expect(r).toHaveProperty('reason', null);
    expect(r).toHaveProperty('S_A');
    expect(r).toHaveProperty('S_B');
    expect(r).toHaveProperty('playerA');
    expect(r).toHaveProperty('playerB');
    expect(r).toHaveProperty('character');
    expect(r).toHaveProperty('resultA');
    expect(r).toHaveProperty('resultB');
    for (const k of ['pool', 'apostaA', 'apostaB', 'recebidoA', 'recebidoB', 'deltaA', 'deltaB']) {
      expect(r.pvp).toHaveProperty(k);
    }
  });

  // É ESTE teste que prova a soma zero algebricamente (ver o bloco acima):
  // recebidoA + recebidoB = pool = apostaA + apostaB ⟹ deltaA + deltaB = 0.
  it('pool = apostaA + apostaB, cada aposta = PVP_STAKE·P, e a pool é conservada', () => {
    const r = mmr.processDuel(player(80), player(40), undefined, 60, 50);
    expect(r.pvp.apostaA).toBeCloseTo(mmr.PVP_STAKE * 80, 6);
    expect(r.pvp.apostaB).toBeCloseTo(mmr.PVP_STAKE * 40, 6);
    expect(r.pvp.pool).toBeCloseTo(r.pvp.apostaA + r.pvp.apostaB, 9);
    expect(r.pvp.recebidoA + r.pvp.recebidoB).toBeCloseTo(r.pvp.pool, 9);
    expect(r.pvp.deltaA).toBeCloseTo(r.pvp.recebidoA - r.pvp.apostaA, 9);
    expect(r.pvp.deltaB).toBeCloseTo(r.pvp.recebidoB - r.pvp.apostaB, 9);
    // ⟹ soma zero, para QUALQUER par de notas/MMRs.
    expect(r.pvp.deltaA + r.pvp.deltaB).toBeCloseTo(0, 9);
  });

  it('resultA.pvpDelta === pvp.deltaA e resultB.pvpDelta === pvp.deltaB', () => {
    const r = mmr.processDuel(player(75), player(25), undefined, 60, 40);
    expect(r.resultA.pvpDelta).toBeCloseTo(r.pvp.deltaA, 9);
    expect(r.resultB.pvpDelta).toBeCloseTo(r.pvp.deltaB, 9);
  });

  it('rankeado aplica delta PvP POR CIMA do MMR atualizado pelo solo', () => {
    const r = mmr.processDuel(player(50), player(70), undefined, 50, 50);
    expect(r.ranked).toBe(true);
    expect(r.pvp.deltaA).toBeCloseTo(2, 6);
    expect(r.pvp.deltaB).toBeCloseTo(-2, 6);
    expect(r.playerA.P).not.toBe(50);
    expect(r.resultA.pvpDelta).toBeCloseTo(2, 6);
    // delta total = movimento solo + delta pvp
    expect(r.resultA.delta).toBeCloseTo(r.playerA.P - r.resultA.P_before, 9);
    expect(r.resultA.P_after).toBeCloseTo(r.playerA.P, 9);
  });

  it('o personagem é threaded (A joga, depois B contra o D já ajustado)', () => {
    // Ambos fora da calibração → o D se ajusta duas vezes; n_D final = 2.
    const r = mmr.processDuel(player(60), player(60), undefined, 70, 50);
    expect(r.character.n_D).toBe(2);
  });
});

describe('processDuel — pureza', () => {
  it('não muta os objetos de entrada', () => {
    const a = player(75);
    const b = player(25);
    mmr.processDuel(a, b, undefined, 60, 40);
    expect(a.P).toBe(75);
    expect(b.P).toBe(25);
    expect(a.n).toBe(10);
  });

  it('determinismo: mesmas entradas → mesmo retorno', () => {
    const args = [player(62, 9), player(71, 14), undefined, 66, 48];
    const r1 = mmr.processDuel(...args);
    const r2 = mmr.processDuel(...args);
    expect(r1.pvp).toEqual(r2.pvp);
    expect(r1.playerA).toEqual(r2.playerA);
    expect(r1.playerB).toEqual(r2.playerB);
  });
});
