# Avaliador da Simulação (estrutura pronta, desligada por padrão)

O fluxo de avaliação já está **inteiramente montado** — falta apenas o prompt e
ligar a chave. Enquanto o avaliador está desligado, ao finalizar a sessão o aluno
vê a tela de agradecimento e o **log é salvo** para análise humana.

## Como ligar

1. **Escreva o prompt** do avaliador em `server/avaliacao/avaliador.md` (este
   diretório). É o *system prompt* enviado ao modelo. Ele recebe, como mensagem
   do usuário, o log da sessão — e, quando o personagem tiver "critério de
   correção" cadastrado, o gabarito é injetado automaticamente **antes** do log
   (server-side, nunca exposto ao aluno).

2. **Escolha o modelo** na env `OPENAI_EVAL_MODEL` (ex.: `gpt-4o`, `gpt-5.5`, `o3`…)
   e garanta que `OPENAI_API_KEY` está configurada.

3. **Ligue o avaliador** de uma das formas:
   - env `EVALUATOR_ENABLED=true` (define o padrão no primeiro boot), **ou**
   - pela interface: tela **Contas** (admin) → botão "Ligar avaliação".

## O que já está pronto

- `POST /api/evaluate` — resolve o prompt, injeta o gabarito e chama a OpenAI.
- Cálculo determinístico da nota final a partir de notas por critério
  (`server/scoring.js`, `finalScoreFromCriteria`).
- Salvamento do log com `evaluation`, `score` e `criteriaScores`
  (`POST /api/logs`) — o aluno não recebe `criteriaScores`.
- Tela pós-sessão no cliente que mostra a avaliação/nota quando existir.

> Se o avaliador emitir notas por critério, faça o cliente enviá-las em
> `criteriaScores` no `POST /api/logs` (a nota final é calculada em código).
