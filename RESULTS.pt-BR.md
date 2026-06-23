# Resultados — economia de tokens

[English](RESULTS.md) · **Português**

O `codeindex` corta os tokens que um agente gasta numa tarefa de código em dois
lugares: o **input** que ele lê pra achar contexto, e o **output** que ele emite pra
fazer a mudança. Todo número abaixo vem de execuções reais em repos reais. Token =
chars/4; a **redução em % é independente do divisor**, então vale com qualquer
tokenizer.

Dois baselines são mostrados o tempo todo, de propósito — um piso conservador e um
realista — pra nada ser escolhido a dedo.

---

## Tokens de input — achando o contexto

Em vez de o agente ler arquivos inteiros (ou rodar grep e ler cada hit), o
`codeindex` retorna um manifesto dos arquivos relevantes **com intervalos de linha**.
Execuções reais, 3 tarefas reais:

| tarefa | COM índice | vs ler os arquivos certos inteiros | vs grep-and-read-all |
|---|---|---|---|
| aceitar um lance (rejeição atômica de irmãos) | 13.410 | 17.796 → **25% economizado** | 73.021 → **82% economizado** |
| descontar um crédito no unlock | 9.096 | 15.660 → **42% economizado** | 57.303 → **84% economizado** |
| presign R2 + cópia borrada no CDN | 9.493 | 12.740 → **25% economizado** | 21.008 → **55% economizado** |

- **Piso conservador (25–42%):** assume que o agente já *sabe* os arquivos exatos e
  os lê inteiros — o `codeindex` só adiciona o estreitamento por intervalo de linha.
  Isso subestima (arquivos expandidos pelo grafo não têm intervalos, então ficam
  inteiros nos dois lados).
- **Realista (55–84%):** o que um agente de fato gasta achando contexto — grep por
  keyword, depois ler cada hit inteiro. O custo do próprio manifesto (~1,1k tokens)
  está incluído na coluna COM.

```bash
npm run benchmark -- /caminho/pro/repo "deduct a credit atomically when a shop unlocks a repair lead"
```

---

## Tokens de output — fazendo a edição

Uma camada downstream (`src/edit/`) deixa o agente emitir **operações estruturais
contra âncoras da AST**, aplicadas via ts-morph atrás de um gate de type-check, em
vez de re-emitir código. Medido **ponta a ponta num repo real** (o próprio
codeindex): as edições baseline são derivadas dos sites de referência reais, e as ops
do protocolo são **de fato executadas pelo gate de diagnósticos** (as duas tarefas
passaram).

| mesma mudança, dois jeitos | baseline (ler + editar) | protocolo (ops na AST) | output | input |
|---|---|---|---|---|
| rename em 4 arquivos / 16 sites | out 583, in 8.412 | out 16, in 131 | **−97%** | **−98%** |
| edição localizada de uma linha | out 31, in 944 | out 45, in 150 | **+45% (pior)** | −84% |

**A leitura honesta:**
- **Refactors multi-arquivo ganham muito, nas duas pontas.** O agente emite uma
  diretiva e nunca lê os call-sites — o runner reescreve todos os 16, com o
  type-checker como porteiro.
- **Edições únicas e localizadas *não* ganham no output.** O header `OLD:`/`NEW:` da
  op custa mais que um `str_replace` simples numa linha já única. O valor ali é a
  economia de input (ler o nó, não o arquivo) e o gate de segurança — não o output.
  Pra edições pontuais, um diff comum é a ferramenta certa.

Ou seja, o ganho de tokens de output é **concentrado em refactors com fan-out**, não
em toda edição.

```bash
npm run bench:e2e    # esta tabela (executado ponta a ponta)
npm run test:edit    # corretude + rollback
```

**Confirmado ao vivo pela ferramenta MCP.** Com a camada de edição exposta como
servidor MCP, dois agentes renomearam `loadConfig` → `readConfig` na base — um
chamando `apply_edits`, o outro com grep + str_replace:

| | apply_edits (MCP) | grep + str_replace |
|---|---|---|
| emitiu | uma diretiva (~19 tok) | 12 edições (~283 tok) |
| arquivos cobertos | 6, verificados pelo type-check | 6 |

**~15× menos tokens de output**, os mesmos arquivos, e a edição via MCP é verificada
pelo gate antes de escrever (as edições manuais não). O agente chamou a ferramenta de
verdade; o gate rodou no servidor.

### Uma feature inteira, num repo externo real

Pra testar além do código do próprio codeindex, uma feature completa foi adicionada a
um **repo real não relacionado** (um backend Drizzle/Elysia) totalmente **em memória**
(`write:false`, então a working tree dele nunca é tocada):

1. O `retrieve()` localizou o arquivo-alvo a partir de uma descrição em linguagem
   natural.
2. Duas ops — `INSERT_BEFORE` (nova função) + `REPLACE_TEXT` (ligar ao service
   exportado) — foram aplicadas.
3. Um **gate baseline-diff** (falha só em diagnósticos *recém-introduzidos* — o repo
   já tinha 25 pré-existentes) confirmou que o código novo **passa no type-check
   contra os tipos reais do repo**.

Achado honesto: num **primeiro acerto limpo**, uma adição emite *mais* output que uma
edição comum (você escreve o código novo de qualquer jeito, mais os headers da op).
Isso só vale sem retry — quando o código novo falha no type-check (comum), o gate
pega e o reparo escopado conserta só o trecho ruim, então o retry é barato em vez de
re-emitir. Ou seja, adições "não compensam" *só quando não há retry*; o valor é o gate
mais um retry barato. A economia de output no primeiro acerto continua coisa de
refactor.

```bash
npm run bench:feature
```

---

## Como ler isso honestamente

- Input e output são **fases separadas** — não são somados num único número de manchete.
- Os números do **piso conservador** são inatacáveis; os números **realistas** carregam
  a premissa declarada do "grep-and-read-all", que pode super ou subestimar pra um
  agente específico.
- A qualidade de retrieval do índice por baixo é validada separadamente
  (`npm run eval`, casos rotulados).

*Stack: Node + TypeScript puro, zero chamadas de API no caminho da consulta, sem vector
DB externo. O embedder também tem um backend Model2Vec nativo em Node (sem Python) —
um detalhe de velocidade/footprint, documentado em
[docs/benchmarks.md](docs/benchmarks.md), fora desta história de tokens.*
