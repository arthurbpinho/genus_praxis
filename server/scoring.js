// Cálculo da nota final (0–100) a partir das notas por critério.
//
// A estrutura de avaliação já fica pronta: quando o avaliador for ligado, ele
// emitirá um bloco de notas por critério (0–10 cada), e a nota final é calculada
// DE FORMA DETERMINÍSTICA aqui em código (a IA não faz a conta final):
//   nota_final = round( soma / (nº de critérios × 10) × 100 )

function finalScoreFromCriteria(criteria) {
  if (!criteria || typeof criteria !== 'object') return null;
  const vals = Object.values(criteria)
    .map((v) => Number(String(v).replace(',', '.')))
    .filter((n) => Number.isFinite(n));
  if (!vals.length) return null;
  const sum = vals.reduce((a, b) => a + b, 0);
  const base = vals.length * 10;
  if (base === 0) return null;
  return Math.round((sum / base) * 100);
}

module.exports = { finalScoreFromCriteria };
