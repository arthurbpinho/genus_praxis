# Genus Práxis

Plataforma de **simulação clínica** — white label do All_OS com a estética laranja
da marca. O único modo é a **Simulação / Treinamento**: o aluno atende pacientes
simulados por IA, sessão a sessão, e o log de cada atendimento é registrado.

> _"Todo ser humano é único e possui um potencial ilimitado."_

## Como rodar

```bash
# 1. Dependências (raiz instala o servidor e, via postinstall, o cliente)
npm install

# 2. Configure o ambiente
cp .env.example .env
#   - JWT_SECRET  → obrigatório (gere: node -e "console.log(require('crypto').randomBytes(48).toString('hex'))")
#   - OPENAI_API_KEY → opcional. Sem ela, a simulação roda em "modo demonstração"
#     (respostas fixas) e o Whisper (áudio) fica indisponível.

# 3. Desenvolvimento (servidor :3001 + Vite :5173 com hot reload)
npm run dev
#   Abra http://localhost:5173

# 4. Produção (build do cliente + servidor único servindo tudo)
npm run build
npm start
#   Abra http://localhost:3001
```

## Contas — o primeiro admin

O app usa **JWT** para as sessões (assinado com `JWT_SECRET`) e **bcrypt** para as
senhas. Na primeira execução ele cria o(s) usuário(s) inicial(is); depois é só
logar como admin e criar as demais contas na tela **Contas**.

**Desenvolvimento local** (sem `ADMIN_INITIAL_PASSWORD`) — cria contas de demonstração:

| Usuário       | Senha           | Função         |
| ------------- | --------------- | -------------- |
| `admin`       | `admin123`      | Administrador  |
| `supervisor`  | `supervisor123` | Professor      |
| `aluno`       | `aluno123`      | Aluno          |

**Produção** — defina `ADMIN_INITIAL_PASSWORD` (mín. 8 caracteres) na env do
servidor **antes do primeiro boot**. O app cria então **apenas o admin** com essa
senha (usuário `admin`, ou o que estiver em `ADMIN_INITIAL_USERNAME`). As contas de
demonstração **não** são criadas.

```bash
ADMIN_INITIAL_USERNAME=admin
ADMIN_INITIAL_PASSWORD=uma-senha-forte-aqui
```

> A senha vive só na env do servidor (nunca no repositório). Ela só é usada uma
> vez, na criação inicial — depois você pode trocá-la em **Perfil**. Como
> `server/data/` é ignorado pelo git, num host novo o primeiro boot usa essa env.

## Deploy

### Opção A — full-stack (recomendada)

Um único serviço Node roda o Express, que serve a API **e** o front já buildado.
Funciona em Railway, Render, Fly, uma VPS, etc.

```bash
npm install && npm run build && npm start
```

Defina no host: `JWT_SECRET`, `ADMIN_INITIAL_PASSWORD`, `OPENAI_API_KEY` (opcional)
e um `DATA_DIR` apontando para um volume persistente.

### Opção B — GitHub Pages (só front)

O **GitHub Pages hospeda só arquivos estáticos** — não roda o servidor. O workflow
`.github/workflows/pages.yml` builda e publica o front a cada push na `main`.

**Por padrão o build do Pages usa o MODO DEMONSTRAÇÃO** (`VITE_DEMO=1`): o front
roda 100% no navegador, com dados fictícios em memória e sem backend/IA. É ótimo
para **mostrar o app** — o login aceita qualquer senha (ou os botões
Administrador / Professor / Aluno) e dá pra clicar em tudo. Nada é salvo de
verdade. Site: `https://arthurbpinho.github.io/genus_praxis/`.

**Para ligar um backend real no Pages** (em vez da demo):

1. Hospede o **backend** num host Node (Opção A, mas com `npm run server`).
2. **Settings → Pages → Source: GitHub Actions**.
3. Em **Settings → Secrets and variables → Actions → Variables**, crie
   `VITE_DEMO` = `0` e `VITE_API_BASE` = URL pública do backend.
4. No backend, adicione a URL do Pages ao `CORS_ALLOWLIST`
   (ex.: `https://arthurbpinho.github.io`).

> Para uso real (dados de verdade, IA), prefira a **Opção A** (full-stack). O
> Pages serve bem como vitrine/demonstração do front.

## O que tem

- **Login** (aluno, professor, administrador).
- **Início** — banner + instruções + botão "Jogar simulação".
- **Simulação** (aba à esquerda) — biblioteca de pacientes → chat com:
  - cronômetro de sessão,
  - **Próxima sessão** (time skip) com contagem funcional,
  - função de **áudio (Whisper)**,
  - destaque de mensagens,
  - **Finalizar e enviar** → tela de agradecimento; o log é salvo.
- **Criação de Personagens** (só admin).
- **Contas** (só admin) — com o liga/desliga do avaliador.
- **Meus logs** (aluno) / **Todos os logs** (professor e admin) — com filtros,
  ordenação, agrupamento por pessoa, visualização e download.
- **Perfil** — dados, foto e senha.

## Avaliador (estrutura pronta, desligado)

A avaliação por IA **não está ativa** — ao finalizar a sessão o aluno vê a tela de
agradecimento e o log é salvo para análise humana. Toda a estrutura já está montada
para ligar depois. Veja **`server/avaliacao/README.md`**: basta escrever o prompt em
`server/avaliacao/avaliador.md`, escolher o modelo (`OPENAI_EVAL_MODEL`) e ligar
(env `EVALUATOR_ENABLED=true` ou o botão na tela **Contas**).

## Estrutura

```
server/          Express + persistência em JSON (server/data)
  index.js       API (auth, contas, personagens, logs, sessões, chat, avaliação, whisper)
  prompts.js     montagem dos system prompts (server-side)
  scoring.js     cálculo determinístico da nota final
  avaliacao/     onde vive o prompt do avaliador (quando for ligado)
client/          React + Vite
  src/pages/     Login, Home, Simulacao, ChatSession, AdminCharacters, AdminUsers, Logs, Profile
  src/index.css  tema escuro (laranja + roxo), títulos Anton, corpo UniNeue (fallback Jost)
```

### Fontes

Títulos usam **Anton** (Google Fonts). O corpo usa **UniNeue** — se você tiver os
arquivos da fonte, coloque `UniNeueBook.woff2`/`.woff` em `client/public/fonts/` e
ela é usada automaticamente; caso contrário, cai no fallback **Jost**.
