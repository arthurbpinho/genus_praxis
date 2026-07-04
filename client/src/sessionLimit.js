// Limite duro de tempo de sessão (Simulação).
//
// O cronômetro só corre quando a pessoa ESTÁ NO CHAT — aba visível e tela de
// sessão montada. Tempo em background / aba oculta NÃO conta.
export const SESSION_LIMIT_SECONDS = 200 * 60; // 200 minutos
export const SESSION_LIMIT_MINUTES = 200;

// Próximo valor do cronômetro. Soma 1s só se a aba está visível e há tempo
// abaixo do limite; caso contrário devolve o valor inalterado.
export function nextActiveElapsed(seconds) {
  const s = Number.isFinite(seconds) ? seconds : 0;
  if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return s;
  if (s >= SESSION_LIMIT_SECONDS) return SESSION_LIMIT_SECONDS;
  return s + 1;
}
