// Utilitários compartilhados para COPIAR e BAIXAR logs de sessão e avaliações.

export const EVAL_SECTION_HEADER = '===========================\nAVALIAÇÃO\n===========================';

export function evalSection(evaluationText) {
  const t = (evaluationText || '').trim();
  return t ? `\n\n${EVAL_SECTION_HEADER}\n\n${t}` : '';
}

export function copyText(text) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    return navigator.clipboard.writeText(text);
  }
  return new Promise((resolve, reject) => {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      ok ? resolve() : reject(new Error('copy falhou'));
    } catch (e) { reject(e); }
  });
}

export function downloadText(filename, text) {
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// Monta a lista de itens pro <LogActions>. getEval/getBoth podem ser null quando
// não há avaliação (aí só o item "Log" aparece).
export function makeLogItems({ baseName, getLog, getEval, getBoth }) {
  const date = new Date().toISOString().slice(0, 10);
  const base = (baseName || 'sessao').toString().replace(/\s+/g, '_').slice(0, 60) || 'sessao';
  if (!getEval) {
    return [{ key: 'log', label: 'Log', build: getLog, filename: `log-${base}-${date}.txt` }];
  }
  return [
    { key: 'log', label: 'Log', build: getLog, filename: `log-${base}-${date}.txt` },
    { key: 'eval', label: 'Avaliação', build: getEval, filename: `avaliacao-${base}-${date}.txt` },
    { key: 'both', label: 'Tudo', build: getBoth, filename: `log-avaliacao-${base}-${date}.txt` },
  ];
}
