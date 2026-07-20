// Lógica pura do formulário de anúncio (demanda #9). Sem React, sem CSS, sem DOM — daí é
// testável no ambiente node da suíte. O `<AdminAnnouncements>` é só a casca em volta.

// Os papéis que podem ser público de um anúncio. `visitor` incluído (decisão do usuário).
// Espelha o `ANNOUNCEMENT_ROLES` do servidor — se divergir, o servidor descarta o que sobra.
export const ANNOUNCEMENT_ROLES = [
  { key: 'therapist', label: 'Alunos' },
  { key: 'visitor', label: 'Visitantes' },
  { key: 'supervisor', label: 'Professores' },
  { key: 'admin', label: 'Administradores' },
];

const VALID_KEYS = new Set(ANNOUNCEMENT_ROLES.map((r) => r.key));

export function roleLabel(key) {
  const r = ANNOUNCEMENT_ROLES.find((x) => x.key === key);
  return r ? r.label : key;
}

/**
 * Alterna um papel na seleção. Marca o que está fora, desmarca o que está dentro.
 * Ignora papel desconhecido (não deixa a UI injetar chave inválida).
 */
export function toggleRole(roles, key) {
  const list = Array.isArray(roles) ? roles : [];
  if (!VALID_KEYS.has(key)) return list;
  return list.includes(key) ? list.filter((r) => r !== key) : [...list, key];
}

/** O anúncio está válido para publicar? Título e texto não podem ser vazios. */
export function validateAnnouncement({ title, body } = {}) {
  const errors = {};
  if (!String(title || '').trim()) errors.title = 'O título é obrigatório.';
  if (!String(body || '').trim()) errors.body = 'O texto é obrigatório.';
  return errors;
}

/** Rótulo do público para a lista: "Todos" quando vazio, senão os nomes. */
export function audienceLabel(roles) {
  if (!Array.isArray(roles) || roles.length === 0) return 'Todos';
  return roles.map(roleLabel).join(', ');
}
