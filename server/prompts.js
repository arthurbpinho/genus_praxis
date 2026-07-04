// Montagem de system prompts — feita no SERVIDOR para evitar vazamento de
// specificInstruction / evaluationCriteria ao cliente (o aluno nunca deve ver
// a "descrição secreta" do personagem nem o gabarito do avaliador).

// Prompt do paciente simulado (Simulação). O modelo encarna EXCLUSIVAMENTE o
// personagem descrito pelo administrador em specificInstruction.
function buildSimulationPrompt(specificInstruction) {
  return `Você é um paciente em uma sessão de terapia. Aja EXCLUSIVAMENTE como o personagem descrito abaixo. Seja realista, natural e consistente com a descrição. Nunca quebre o personagem. Nunca aja como terapeuta ou como IA. Responda sempre em português do Brasil.

INSTRUÇÃO DO PERSONAGEM:
${specificInstruction || '(sem instrução específica — aja como um paciente genérico buscando ajuda)'}`;
}

// Monta a *mensagem* (role: user) enviada ao avaliador com a transcrição da
// sessão. Quando o personagem tiver um "critério de correção" (evaluationCriteria),
// o servidor prepende esse gabarito ANTES desta string, server-side — de modo que
// o gabarito jamais chega ao cliente.
//
// A ESTRUTURA já está pronta: quando o avaliador for ligado (EVALUATOR_ENABLED),
// basta apontar o prompt do avaliador e o modelo. Enquanto isso, esta função fica
// disponível para o fluxo.
function buildDirectEvaluationPrompt(sessionLabel, characterName, transcript) {
  return `[LOG DO ATENDIMENTO]
Modo: ${sessionLabel}
Personagem: ${characterName}

${transcript}`;
}

module.exports = {
  buildSimulationPrompt,
  buildDirectEvaluationPrompt,
};
