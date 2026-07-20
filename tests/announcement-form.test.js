// Lógica do formulário de anúncio (client/src/announcementForm.js) — módulo puro, testável
// no node. É a lógica por trás do "Quem vê": marcar/desmarcar os chips de papel.
//
// O bug que originou este teste era VISUAL (o checkbox herdava o estilo global de input e
// esticava o chip) — CSS, que a suíte node não renderiza. Mas a lógica do toggle é o que
// decide o público do anúncio, e ela merece trava: um toggle que desmarcasse o papel errado
// mandaria o aviso para quem não devia.
const {
  ANNOUNCEMENT_ROLES, roleLabel, toggleRole, validateAnnouncement, audienceLabel,
} = require('../client/src/announcementForm');

describe('ANNOUNCEMENT_ROLES', () => {
  it('inclui os 4 papéis, com o visitante entre eles (decisão do usuário)', () => {
    const keys = ANNOUNCEMENT_ROLES.map((r) => r.key);
    expect(keys).toEqual(['therapist', 'visitor', 'supervisor', 'admin']);
    for (const r of ANNOUNCEMENT_ROLES) expect(r.label.length).toBeGreaterThan(0);
  });
});

describe('toggleRole — marcar/desmarcar cada chip', () => {
  it('marca um papel que estava fora', () => {
    expect(toggleRole([], 'therapist')).toEqual(['therapist']);
    expect(toggleRole(['visitor'], 'admin')).toEqual(['visitor', 'admin']);
  });

  it('desmarca um papel que estava dentro — e só ele', () => {
    expect(toggleRole(['therapist', 'visitor', 'admin'], 'visitor')).toEqual(['therapist', 'admin']);
  });

  it('marcar os quatro, um a um, seleciona os quatro (o cenário da tela)', () => {
    let sel = [];
    for (const r of ANNOUNCEMENT_ROLES) sel = toggleRole(sel, r.key);
    expect(sel.sort()).toEqual(['admin', 'supervisor', 'therapist', 'visitor'].sort());
  });

  it('marcar e desmarcar o mesmo volta ao vazio', () => {
    expect(toggleRole(toggleRole([], 'admin'), 'admin')).toEqual([]);
  });

  it('papel desconhecido é ignorado (a UI não injeta chave inválida)', () => {
    expect(toggleRole(['therapist'], 'hacker')).toEqual(['therapist']);
    expect(toggleRole([], 'root')).toEqual([]);
  });

  it('entrada não-array não quebra', () => {
    expect(toggleRole(null, 'admin')).toEqual(['admin']);
    expect(toggleRole(undefined, 'admin')).toEqual(['admin']);
  });

  it('não muta a lista original (o React depende de imutabilidade)', () => {
    const orig = ['therapist'];
    toggleRole(orig, 'admin');
    expect(orig).toEqual(['therapist']);
  });
});

describe('validateAnnouncement', () => {
  it('título e texto vazios acusam os dois campos', () => {
    expect(validateAnnouncement({})).toEqual({ title: expect.any(String), body: expect.any(String) });
    expect(validateAnnouncement({ title: '   ', body: '  ' }).title).toBeTruthy();
  });

  it('preenchido não acusa nada', () => {
    expect(validateAnnouncement({ title: 'Oi', body: 'texto' })).toEqual({});
  });
});

describe('audienceLabel', () => {
  it('vazio = Todos; senão, os nomes', () => {
    expect(audienceLabel([])).toBe('Todos');
    expect(audienceLabel(null)).toBe('Todos');
    expect(audienceLabel(['therapist'])).toBe('Alunos');
    expect(audienceLabel(['visitor', 'admin'])).toBe('Visitantes, Administradores');
  });

  it('roleLabel devolve o id quando não conhece o papel (não quebra)', () => {
    expect(roleLabel('therapist')).toBe('Alunos');
    expect(roleLabel('desconhecido')).toBe('desconhecido');
  });
});

// ---------------------------------------------------------------------
// O bug ERA CSS, e foi corrigido na RAIZ: a regra global `input { width:100%; padding }`
// (index.css) esticava QUALQUER checkbox numa caixa de largura total. Agora ela EXCLUI
// checkboxes e radios (`:not([type="checkbox"])...`), então nenhum checkbox — nem o do
// chip, nem os futuros — herda largura/padding de campo de texto.
//
// A suíte node não renderiza CSS, mas trava o seletor no fonte: se alguém remover a
// exclusão, o bug volta para todos os checkboxes e este teste avisa.
// ---------------------------------------------------------------------
describe('CSS: a regra global de input NÃO estica checkboxes', () => {
  const fs = require('fs');
  const path = require('path');
  const idx = fs.readFileSync(path.join(__dirname, '..', 'client', 'src', 'index.css'), 'utf8');

  it('a regra de largura/padding exclui checkbox e radio', () => {
    // Encontra a regra que dá width:100% e confirma que ela NÃO se aplica a checkbox nu.
    const m = idx.match(/([^{}]*)\{[^}]*width:\s*100%[^}]*padding:[^}]*\}/);
    expect(m, 'não achei a regra global de input com width:100%').toBeTruthy();
    const seletor = m[1];
    // O seletor de input tem que excluir os dois tipos.
    expect(seletor).toMatch(/input:not\(\[type="checkbox"\]\)/);
    expect(seletor).toMatch(/:not\(\[type="radio"\]\)/);
  });

  it('o foco laranja também exclui checkbox (nada de halo na caixinha)', () => {
    const foco = (idx.match(/(input[^{]*:focus[^{]*)\{[^}]*box-shadow[^}]*\}/) || [])[1] || '';
    expect(foco).toMatch(/:not\(\[type="checkbox"\]\)/);
  });

  it('o chip mantém o reset defensivo (belt-and-suspenders)', () => {
    const css = fs.readFileSync(path.join(__dirname, '..', 'client', 'src', 'styles', 'Admin.css'), 'utf8');
    const chip = (css.match(/\.role-chip\s*\{([^}]*)\}/) || [])[1] || '';
    const bloco = (css.match(/\.role-chip input\s*\{([^}]*)\}/) || [])[1] || '';
    expect(chip).toMatch(/display:\s*inline-flex/);
    expect(bloco).toMatch(/flex:\s*none/);
  });
});
