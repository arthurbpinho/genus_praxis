// Cálculo da nota final (0–100) a partir das notas por critério.
//
// A estrutura de avaliação já fica pronta: quando o avaliador for ligado, ele
// emitirá um bloco de notas por critério (0–10 cada), e a nota final é calculada
// DE FORMA DETERMINÍSTICA aqui em código (a IA não faz a conta final):
//   nota_final = round( soma / (nº de critérios × 10) × 100 )

/**
 * Converte uma nota de critério em número — ou `null` se ela não for uma nota de verdade.
 *
 * ⚠ ISTO EXISTE POR CAUSA DE UM BUG REAL. O código antigo fazia
 * `Number(String(v).replace(',', '.'))` e filtrava por `Number.isFinite`. Mas
 * `Number('')`, `Number('  ')`, `Number(null)` e `Number([])` valem **0** — e 0 é finito.
 * Resultado: um critério que a IA deixou EM BRANCO virava um zero legítimo e **derrubava
 * a nota do aluno pela metade** (`{1:8, 2:''}` dava 40 em vez de 80). Como essa nota vai
 * para o log, o MMR e o ranking, o estrago era silencioso e permanente.
 *
 * O cliente já tinha essa proteção (`isRealScore`, em client/src/logFiles.js) — o
 * servidor, que é a AUTORIDADE que grava a nota, é que estava com o filtro ingênuo.
 *
 * Um `0` legítimo (a IA de fato deu zero) continua valendo 0.
 */
function toScore(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v !== 'string') return null;          // objeto, array, boolean: não é nota
  const s = v.trim().replace(',', '.');
  if (s === '') return null;                        // "em branco" NÃO é zero
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function finalScoreFromCriteria(criteria) {
  if (!criteria || typeof criteria !== 'object') return null;
  const vals = Object.values(criteria)
    .map(toScore)
    .filter((n) => n !== null);
  if (!vals.length) return null;
  const sum = vals.reduce((a, b) => a + b, 0);
  const base = vals.length * 10;
  if (base === 0) return null;
  return Math.round((sum / base) * 100);
}

// Separa o JSON comparativo do duelo (chaves A1..A6 / B1..B6) nas notas de cada
// aluno e calcula a nota final 0–100 de cada um. Retorna também o vencedor.
// Retorna null se não der pra montar as duas notas.
function comparativeScores(criteria) {
  if (!criteria || typeof criteria !== 'object') return null;
  const a = {};
  const b = {};
  for (const [k, v] of Object.entries(criteria)) {
    const m = /^([AB])\s*0*(\d+)$/i.exec(String(k).trim());
    if (!m) continue;
    const n = toScore(v);
    if (n === null) continue;
    if (m[1].toUpperCase() === 'A') a[m[2]] = n;
    else b[m[2]] = n;
  }
  const scoreA = finalScoreFromCriteria(a);
  const scoreB = finalScoreFromCriteria(b);
  if (scoreA === null || scoreB === null) return null;
  let winner;
  if (scoreA > scoreB) winner = 'A';
  else if (scoreB > scoreA) winner = 'B';
  else winner = 'draw';
  return { criteriaA: a, criteriaB: b, scoreA, scoreB, winner };
}

module.exports = { toScore, finalScoreFromCriteria, comparativeScores };
