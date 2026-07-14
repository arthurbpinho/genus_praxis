# Genus Práxis × All_OS — o que mudou

O Genus Práxis nasceu como fork white-label do **All_OS**. Hoje os dois compartilham
o mesmo motor de MMR e os mesmos prompts de avaliação, mas divergiram em arquitetura,
provedor de IA e escopo de produto.

Este documento registra as diferenças **verificadas no código**, não as pretendidas.
Números conferidos em 2026-07-14.

| | All_OS | Genus Práxis |
|---|---|---|
| Provedor de IA | Anthropic (paciente) + OpenAI (avaliadores) | **100% OpenAI** |
| Módulo Neuro | sim | **não** |
| Escala da nota | exercício 0–10, freeplay 0–100 (convivem) | **0–100 em tudo** (§5) |
| Testes | 8 arquivos | **31 arquivos, 791 testes** |
| CSS | 1 arquivo de 3126 linhas | 646 linhas + 15 arquivos por página |
| Deps de runtime | 10 (inclui `@anthropic-ai/sdk` e `uuid`, este sem uso) | **7** |

---

## 1. Escopo do produto

### O que o Genus NÃO tem
- **Todo o módulo Neuro** (neuropsicologia): `/api/neuro*`, `neuro-characters.json`,
  `neuro-tests.json`, as telas `NeuroEval` e `AdminNeuro`, os componentes
  `TestSelector`/`TestComparison`. Removido por decisão de produto.
- Como consequência, sumiram também: a conquista `neuro_complete` (o Genus tem **19**,
  o All_OS 20), a missão diária `daily_neuro` (o Genus tem **3**, o All_OS 4) e o stat
  `totalNeuro`.
- A conquista `polivalente` mudou de significado: no All_OS exigia
  `exercise + freeplay + neuro` no mesmo dia; aqui, `exercise + freeplay`.

### O que só o Genus tem
- `GET /api/health` — healthcheck que valida se o volume de dados está gravável.
- `POST /api/entrevistador/extract` e `POST /api/entrevistador/character` — extração
  dos Blocos 1/2 e criação automática de personagem, **no servidor** (no All_OS o
  parsing era regex no cliente).
- `PUT /api/freeplay/:id/photo` — foto de paciente em rota própria, com validação de
  MIME/tamanho (no All_OS a foto ia junto no `PUT` do personagem).
- Página `Home` (`/inicio`) e barra lateral recolhível.

> As rotas `GET/POST/PUT/DELETE /api/freeplay` e `/api/exercises` existem nos dois.
> No Genus elas são montadas por `mountCharacterCrud()`, por isso não aparecem num
> `grep` de `app.get('...`. Não confunda com rota faltando.

---

## 2. Inteligência artificial

O All_OS usa **Claude (Anthropic)** para interpretar o paciente e OpenAI para os
avaliadores. O Genus é **100% OpenAI** — não há `@anthropic-ai/sdk` nem
`ANTHROPIC_API_KEY`.

| papel | All_OS | Genus |
|---|---|---|
| Paciente (chat) | `claude-sonnet-4-6` | `gpt-4o-mini` (`OPENAI_PATIENT_MODEL`) |
| Avaliador | `gpt-5.5` | `gpt-4o` (`OPENAI_EVAL_MODEL`) |
| Entrevistador | `gpt-5.4` | `OPENAI_ENTREVISTADOR_MODEL` (default = avaliador) |
| Transcrição | Whisper | Whisper |

### `/api/evaluate` não é streaming
No All_OS a avaliação volta em **SSE** (`text/event-stream`), com o texto aparecendo ao
vivo e um toggle `showReasoning`. No Genus é uma resposta JSON única:

```js
await api.evaluate(messages, context)
// → { role, content, score }
// → + { criteriaScores, reasoning } se supervisor/admin
```

Quem decide se o `reasoning` vai é o **papel do usuário**, no servidor — não uma flag
enviada pelo cliente. Toda a UI que mostrava texto chegando ao vivo virou spinner +
texto completo no fim.

---

## 3. Arquitetura do servidor

### Escrita concorrente
O Genus tem `withFileLock(file, fn)` e o usa em **34 pontos** — toda escrita de JSON.
O All_OS faz `read → push → write` sem lock (**0 ocorrências**), o que perde escritas
sob concorrência.

### Seed de conteúdo (`server/seed/`)
Só o Genus. `server/data/*.json` está no `.gitignore` (contém hashes de senha), então o
**conteúdo** que precisa existir num deploy limpo — pacientes e exercícios — mora em
`server/seed/` e é copiado no primeiro boot, sem nunca sobrescrever o volume.

Sem isso, um deploy novo subiria sem nenhum paciente.

### Avaliação em background
O `finalizeDuel` do Genus roda **depois** de responder ao cliente, com retry
(`status: 'pending'` se a IA falhar). No All_OS a avaliação comparativa acontece dentro
do `POST /submit`, segurando a request.

### `pruneExpiredDuels`
Roda no boot **e** nas rotas `GET /api/duels/social` e `GET /api/duel/:id/export` — nos
dois sistemas. TTL de 30 dias.

Não roda em `GET /api/duel/:id` (nem aqui, nem no All_OS): essa rota é o alvo do polling
do `DuelSession` enquanto o `finalizeDuel` avalia, e `pruneExpiredDuels` escreve em
`duels.json` **sem `withFileLock`** — prunar ali poderia atropelar a gravação do
resultado. Há teste travando essa decisão nos dois sentidos.

---

## 4. Schema de dados

### Log de sessão
O Genus **adicionou** três campos e **perdeu** um:

| campo | All_OS | Genus |
|---|---|---|
| `type` | — | `'exercise' \| 'freeplay'` — **obrigatório** (400 sem ele) |
| `mode` | `'competitive' \| 'training'` | idem |
| `difficulty` | vinha do cliente | **resolvida no servidor** (o cliente não decide) |
| `sessionCount` | — | número de sessões da simulação |
| `skillId` | vem do **cliente** (`body.skillId`) | **resolvido no servidor** a partir do `exercises.json` |

`difficulty` e `skillId` saem da mesma leitura do `exercises.json`. O cliente pode mandar
`skillId: 99` que o servidor ignora — no All_OS esse 99 iria para o log e contaminaria
qualquer relatório por competência. `normalizeSkillId` também rejeita `null`/`''`/`[]`,
que um `Number.isFinite(Number(v))` ingênuo transformaria na **competência 0**
(inexistente — são 1 a 5).

Nos Logs, um selo mostra a competência treinada, e o `.txt` exportado ganha a linha
`Competência: Hermenêutica`.

### Personagens
O All_OS unificava tudo; o Genus separa `exercises.json` (trilha) de
`freeplay-characters.json` (simulação). O `characters.json` legado foi removido.

### Duelo (`publicDuel`)
Nomes de campo mudaram: `youAre` → **`side`**; as mensagens vêm em `myMessages` /
`challengerMessages` / `opponentMessages`. Cada lado só vê as próprias mensagens até o
duelo completar (o Genus entrega `myMessages` durante o duelo, para retomar sessão, sem
vazar as do oponente).

---

## 5. Avaliador customizado por exercício

Nos dois sistemas, um exercício com `evaluatorPrompt` preenchido usa **aquele prompt como
avaliador**, não o global. A diferença está em quem faz a conta.

Cada avaliador customizado traz a **própria escala interna** — os três exercícios reais
usam *"5 eixos de 0 a 2 pontos, máx. 10"*. Por isso o wrapper pede `[NOTA:X]`, e não o
bloco `[notas-supervisor]`: o `finalScoreFromCriteria` assume `base = nº critérios × 10`;
forçar os 6 critérios sobre 5 eixos de 0–2 faz a mesma sessão valer **7 numa escala e 40
na outra**. Testado ao vivo.

- **All_OS**: o cliente parseia `[NOTA:X]` e manda no `saveLog`.
- **Genus**: o **servidor** parseia (`extractFinalScore`), remove o marcador do texto do
  aluno e devolve `score`. `POST /api/logs` repete a limpeza como rede de segurança.

### Divergência deliberada: o Genus padronizou 0–100; o All_OS mantém o defeito

No **All_OS** as escalas convivem: o wrapper dele manda *"use a escala que sua avaliação
considerar apropriada"*, então exercício sai em 0–10 e freeplay/duelo/progressão em 0–100.
O `ScoreBadge` clampa em 0–100 e colore por faixa (`≤22` vermelho … `≥81` verde) — logo
**toda nota de exercício cai na faixa vermelha "Erro", inclusive um 10/10 perfeito**: a
nota máxima pintada como a pior possível. E a conquista `high_score` (`score >= 25`, limiar
herdado de quando a trilha usava −9..+9) fica inalcançável por exercício. O comentário do
`ScoreBadge` do All_OS assume o problema: *"notas fora de 0-100 são clampadas… a coloração
fica aproximada"*.

O **Genus corrigiu**. Hoje **toda** nota é 0–100:

- `wrapCustomEvaluatorPrompt` exige a nota final em **0–100**, manda a IA **converter** da
  escala interna do prompt e **proíbe** mostrar a escala original ao aluno — senão o selo
  diria 70 e o texto da devolutiva "7/10": dois números para a mesma sessão.
- **A régua pedagógica do admin fica intacta.** Os 5 eixos e as faixas ("9–10: Excepcional")
  dos avaliadores reais continuam como estão — são o *raciocínio interno* da IA. Só a
  **saída** foi padronizada; os prompts do usuário não foram reescritos.
- **Não há auto-conversão no código (×10).** Um `[NOTA:7]` é **ambíguo**: pode ser um 7/10
  que a IA esqueceu de converter, ou um **7/100 legítimo** (sessão péssima). Multiplicar na
  dúvida promoveria silenciosamente um aluno que foi mal — pior que o bug original. A nota é
  gravada como veio e o `/api/evaluate` **grita no log** (`console.warn`) quando ela parece
  estar em 0–10: um avaliador mal-comportado se detecta pelo aviso, não por notas erradas em
  produção.
- `high_score` subiu de `>= 25` para **`>= 85`**: numa escala 0–100, 25 é nota fraca, e
  "Excelência técnica" (tier ouro) saía quase de graça.

Verificado ao vivo com a OpenAI real e o avaliador real ("A boca fala uma coisa, o corpo
outra"): a IA converteu, registrou `score: 80` e escreveu "NOTA FINAL: [80/100]" no texto do
aluno. Selo e devolutiva concordam. Travado por teste + mutação.

---

## 6. Segurança

Em termos de garantias, os dois sistemas hoje estão equivalentes. Vale registrar o
histórico com honestidade: **três proteções que o All_OS já tinha foram perdidas durante
o porte** e depois restauradas no Genus. Não eram bugs do All_OS — eram regressões do
fork:

1. **`GET /api/logs` deixou de ser deny-by-default.** O filtro passou a pegar só
   `role === 'therapist'`, e o **visitante caía no `else`, recebendo os logs de todos os
   usuários**. O All_OS tratava `therapist || visitor` explicitamente. Hoje o Genus
   inverteu a regra: quem não é professor/admin só vê os próprios.
2. **O professor passou a ver os logs de todos os alunos**, não só os vinculados a ele,
   e o `?userId=` deixou de ser validado. O All_OS já usava `canAccessUserResource`.
   Restaurado.
3. **`GET /api/entrevistador-prompt` ficou aberto** a qualquer usuário autenticado —
   aluno e visitante baixavam 46KB de IP da Allos. No All_OS a rota sempre foi
   `requireRole('admin')`. Restaurado.

> Moral: as três regressões passariam despercebidas se o porte tivesse trazido também a
> suíte de testes do All_OS. Foi o que motivou os 791 testes de hoje (ver §7).

Os dois rejeitam `systemPrompt` no body de `/api/chat` com **400** (anti
prompt-injection). O Genus acrescenta que `criteriaScores`/`reasoning` só vão para
supervisor/admin — decidido pelo **papel do usuário no servidor**, não por uma flag que o
cliente envia (no All_OS o cliente pedia `showReasoning`).

### Rate limiters — mais frouxos, de propósito
| limiter | All_OS | Genus | por quê |
|---|---|---|---|
| `loginLimiter` | 10 / 15min | **20 / 15min** | tolerância a erro de digitação |
| `visitorLimiter` | 5 / 15min | **30 / 60min** | uma turma inteira atrás do mesmo NAT compartilha o IP |
| `aiLimiter` | 300 / h | 400 / h | |
| `writeLimiter` | 200 / h | 300 / h | |

`ADMIN_INITIAL_PASSWORD` aceita 8 caracteres no Genus (12 no All_OS) e, se ausente, o app
sobe com contas de demonstração em vez de recusar. **Decisões conscientes** — não são
regressões esquecidas.

---

## 7. Testes

O All_OS tem 8 arquivos. O Genus tem **31 arquivos, 791 testes**, e o harness
(`tests/helpers.js`) garante três invariantes:

- `DATA_DIR` é um tmpdir por processo — **nunca toca `server/data/`**;
- `OPENAI_API_KEY=''` — **nenhum teste chama a OpenAI de verdade** (o `dotenv` não
  sobrescreve env já definida, então o `''` vence mesmo com `.env` no disco);
- `NODE_ENV=test` desliga os rate limiters.

`tests/harness.test.js` testa o próprio harness. Se ele falhar, a suíte está mentindo.

A suíte foi validada por **mutação**: cada bug real já corrigido foi reintroduzido no
servidor, um a um, para confirmar que a suíte falha. Um deles (`avaliador.md`) não era
pego por nenhum teste de HTTP — daí `tests/prompt-files.test.js`, que verifica no
código-fonte e no disco que todo prompt referenciado existe.

`tests/regressions.test.js` é a lista do que já nos mordeu: um teste por bug real corrigido.

### Contar testes não é medir cobertura
Vale registrar com honestidade: numa auditoria (2026-07-14) a suíte de então — **719 testes,
todos verdes** — passava com **12 bugs reais no código**, entre eles um que derrubava a nota
do aluno pela metade (`Number('')` é 0) e outro que produzia **117/100** no ranking (o parser
varria o texto inteiro). Os 12 estão listados em `CLAUDE.md` e `DEMANDAS.md`.

Três padrões explicam o falso verde, e valem como regra em qualquer suíte:
- **fixture que repete o bug do código não testa nada** — o harness usava `dayKey` em UTC,
  igual ao bug de fuso, e por isso não *podia* vê-lo;
- **teste verde por acidente** — o de double-finalize passava com o guard removido, porque
  outro guard interceptava antes. Só a mutação pegou;
- **`grep` no fonte não é execução** — o `custom-evaluator` "cobria" o `/api/evaluate` sem
  nunca rodar o caminho quente. E vários testes afirmavam `status === 200` sem conferir o
  disco: um handler que respondesse certo e não gravasse nada passava.

---

## 8. Frontend

- **Tema laranja** (`--orange: #ff6200`) no lugar do verde/terra.
- **CSS por página**: o `index.css` guarda só o tema base; cada página tem seu
  `styles/<Nome>.css`. Classes de nome genérico (`.active`, `.win`, `.assistant`) são
  **escopadas** sob um wrapper (`.duel-page`, `.session-page`, …). O All_OS tem tudo num
  arquivo de 3126 linhas.
- **Sem `client/src/prompts.js`**: o parsing de notas vive no servidor. Só
  `SKILL_NAMES`/`SKILL_COLORS` foram extraídos para `utils/skills.js`.
- **Modo competitivo** trafega por query string: `/chat/freeplay/:id?mode=competitive`.
- **Responsividade**: `100dvh` (com fallback `@supports`) no chat e no drawer, para o
  campo de digitação não sumir atrás do teclado virtual; `font-size: 16px` nos inputs no
  mobile (abaixo disso o iOS dá zoom automático).

### O que o Genus ainda não tem do All_OS
- `Profile`: campo de gênero e opt-ins de e-mail.

### Botão "Log" no cabeçalho da sessão
Baixa o `.txt` sem finalizar o atendimento. O All_OS só o tem no `ChatSession`
(exercício da trilha); o Genus o tem **também no `EchoSession`** (Simulação), onde as
sessões são mais longas (multi-sessão com time-skip) e a falta era mais sentida.

Em ambos, o botão só aparece quando existe conversa de verdade: a mensagem de kickoff é
`isSystem` e, no EchoSession, os marcadores de troca de sessão têm `type` — nenhum dos
dois habilita o download.

### Cropper de foto de perfil
Os dois usam o `<PhotoCropper>` (arrastar + zoom, JPEG 320×320 via `onCrop(dataUrl)`).
Duas diferenças no Genus:

- **O stage encolhe em telas estreitas.** O All_OS fixa 280px, que estoura um celular de
  320px (o modal come 92px de padding). Aqui o tamanho é calculado no mount e no
  `resize`; ao mudar, `scale` e `offset` são reescalados na mesma proporção, senão o
  recorte salvo sairia diferente do que o usuário enquadrou.
- **Reabrir a foto só funciona com data URL.** Um avatar da galeria vem de
  `/profiles_icon`, servido por `express.static` **sem `Access-Control-Allow-Origin`** —
  num deploy com o front noutra origem (`VITE_API_BASE`) ele tingiria o canvas e o
  `toDataURL()` lançaria `SecurityError`. Nesse caso o cropper abre vazio. (O All_OS
  nunca passa `initialImage`, então não esbarra nisso.)

### Onde o Genus é melhor: notas por critério
Os dois renderizam a `CriteriaTable` nos Logs e incluem o bloco "NOTAS POR CRITÉRIO" no
`.txt` exportado (só para professor/admin — o servidor não envia `criteriaScores` ao
aluno).

O Genus corrigiu um bug que o All_OS tem: o filtro era
`Number.isFinite(Number(v))`, mas `Number(null)`, `Number('')` e `Number([])` valem **0**.
Um critério ausente virava um **"0/10" inventado** na avaliação do aluno. Agora só passa
número de verdade ou string numérica — e a nota **0 legítima** continua aparecendo.
Rótulos e ordenação vivem em `client/src/logFiles.js` (módulo puro), fonte única para a
tabela e para o `.txt`.

> ⚠ A correção ficou meses **só no cliente**. O **servidor** — que é quem calcula a nota,
> alimenta o MMR e o ranking — manteve o filtro ingênuo, e um critério deixado em branco
> pela IA **derrubava a nota do aluno pela metade** (80 → 40). Hoje a guarda vive em
> `toScore()` (`server/scoring.js`) e o cliente é só o espelho dela. Lição: corrigir na
> borda não corrige a autoridade.

---

## 9. Deploy

Os dois têm `railway.json`. O do Genus acrescenta `healthcheckPath: /api/health` — um
deploy com o volume mal montado **falha no healthcheck** em vez de subir com dados
efêmeros.

O Genus **aposentou o GitHub Pages** (o workflow foi removido): um único serviço Node
serve a API e o `client/dist`.

Dois detalhes que quebram um deploy limpo se esquecidos:

- `npm run build` usa `npm install --include=dev`. O Railway define
  `NODE_ENV=production`, e o `vite` é devDependency do client — sem a flag o build morre
  com `ERR_MODULE_NOT_FOUND`.
- O volume é **obrigatório**: `DATA_DIR=/data` com mount point. Sem ele, contas, logs,
  MMR e fotos somem a cada deploy.

---

## Resumo em uma frase

O Genus Práxis é o All_OS **sem neuro e sem Anthropic**, com escrita de arquivo segura
sob concorrência, avaliação não-streaming, nota **padronizada em 0–100**, três furos de
segurança fechados, CSS modularizado e uma suíte de testes 4× maior validada por mutação —
ao custo de algumas telas menos completas e de rate limiters deliberadamente mais
permissivos.
