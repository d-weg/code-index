# codeindex

[English](README.md) · **Português**

**Busca de código local e zero-API + edições ancoradas na AST para agentes de
código — nativo em TypeScript.** Você passa uma descrição da tarefa e recebe de
volta exatamente os arquivos e os intervalos de linha que importam (sem chamadas de
API no caminho da consulta). Depois, um agente altera o código emitindo operações
estruturais contra âncoras da AST, que só entram se ainda passarem no type-check.

> [!NOTE]
> **Isto é um estudo de caso, não um produto.** Um experimento de fim de semana pra
> ver se indexar a base bate o agente rodando grep sem parar. Funciona e os números
> são reais, mas espere arestas — não há roadmap, suporte nem compromisso de
> estabilidade. Pode mudar e melhorar; ou não.
>
> **Feito com bastante ajuda de IA (Claude Code).** A ideia, a direção e as decisões
> são minhas; boa parte da implementação e todos os benchmarks foram escritos com o
> Claude. Trate o código como revisado-mas-gerado-por-IA.

## Por quê

Agentes queimam um monte de token rodando grep sem parar e criando scripts
descartáveis só pra *achar* o código que precisam mexer — e depois re-emitem diffs
grandes pra *alterá-lo*. Eu quis ver até onde um índice local decente + edições
conscientes da AST cortariam isso. Trabalho principalmente com Node/TS, então
aproveitei o próprio ferramental do TypeScript, e sou acostumado com monorepos, onde
um pacote compartilhado importado em todo lugar pode detonar a relevância semântica.

## O que faz

**Achar código** — um índice híbrido que combina BM25 (lexical) + vetores densos +
match exato por nome de símbolo com reciprocal rank fusion, e depois expande pelo
*grafo de imports*. Consciente de monorepo (o peso por pacote inclina o rank pra
camada sobre a qual a consulta realmente fala). Roda totalmente in-process — um
embedding por consulta, sem API.

**Mudar código** — em vez de re-emitir arquivos ou espalhar patches str_replace, o
agente emite operações estruturais (`RENAME` / `SET_BODY` / `REPLACE_TEXT` /
`INSERT_BEFORE`) contra âncoras da AST. Um runner em ts-morph aplica elas atrás de um
**gate de type-check**: nada entra se não compilar, e falhas dão rollback (ou reparo
escopado). E ops de arquivo: `MOVE_FILE` move um arquivo e reescreve todos os imports
que apontam pra ele, no repo inteiro.

**Entender a estrutura** — um mapa de arquitetura zero-API (`describe_architecture` /
`npm run arch`): padrões de tipo de arquivo por pasta, docs co-localizados e templates
de módulo detectados (ex.: *"`features/` tem sub-módulos, cada um com `*.service.ts` +
`*.controller.ts` + `index.ts`"*) — pro agente saber onde um novo módulo vai.

## Números (nos meus próprios repos — baselines honestos)

- **Achar código:** ~55–84% menos tokens de input do que grep-and-read. Um agente
  real na mesma tarefa leu ~2,4× menos com o índice do que sem — mesma resposta.
- **Mudar código:** um rename multi-arquivo foi de ~312 tokens de edições str_replace
  de um agente real pra uma única diretiva de ~16 tokens (~19×). *Honesto:* esse é o
  caso de refactor — ajustes de uma linha e código novo ficam mais ou menos
  empatados; o ganho ali é o gate de type-check, não os tokens.
- **Embedder:** comecei no `bge-small`; portei o `potion-code-16M` (Model2Vec) da
  MinishLab pra rodar nativo no Node → indexação ~80× mais rápida, output verificado
  bit a bit contra a referência em Python (cosseno 1.0).

Metodologia completa, todos os números e **onde ele perde** →
[docs/benchmarks.md](docs/benchmarks.md) (em inglês).

## Como usar

```bash
npm install
npm run index    -- --root /caminho/pro/seu/repo          # constrói o índice
npm run retrieve -- "add rate limiting to uploads" --root /caminho/pro/seu/repo --json
```

Benchmarks (todos reproduzíveis):

```bash
npm run benchmark -- /caminho/pro/repo "<tarefa>"   # economia de tokens de input
npm run bench:e2e        # tokens de output, executado ponta a ponta
npm run bench:embedder   # bge-small vs potion-code
npm run test:edit        # corretude das edit-ops + rollback
```

## Como funciona

| Doc | Cobre |
|---|---|
| [ARCHITECTURE.md](ARCHITECTURE.md) | O pipeline de retrieval, componente por componente (em inglês) |
| [docs/ast-edit-protocol.md](docs/ast-edit-protocol.md) | A camada de edição ancorada na AST (`src/edit/`) (em inglês) |
| [docs/benchmarks.md](docs/benchmarks.md) | Todos os números + como foram medidos (em inglês) |
| [docs/roadmap.md](docs/roadmap.md) | Ideias e lacunas conhecidas (notas, **não** compromissos) (em inglês) |
| [RESULTS.pt-BR.md](RESULTS.pt-BR.md) | O resumo curto e compartilhável dos resultados |

## Créditos

A abordagem de retrieval é a mesma ideia do
**[Semble](https://github.com/MinishLab/semble)** da **MinishLab** — embeddings
estáticos Model2Vec + BM25 + RRF pra busca de código. Comecei no `bge-small`, fui
atrás de algo mais rápido e achei o trabalho deles, que validou a ideia e me levou a
adotar o modelo `potion-code-16M` (escrevi um pequeno port em Node já que não estava
disponível lá). O Semble é **agnóstico de linguagem** (tree-sitter); este aqui é **só
TS de propósito**, pra aproveitar a inferência do TypeScript. Se você não está no
mundo TS, vai de Semble.

Também construído sobre [Model2Vec](https://github.com/MinishLab/model2vec) ·
[potion-code-16M](https://huggingface.co/minishlab/potion-code-16M) · `ts-morph` ·
`@xenova/transformers`.

## Ressalvas

- **Só TypeScript / TSX** (é construído sobre a API do compilador do TS).
- Os números de qualidade vêm de conjuntos rotulados pequenos — direcionais, não
  benchmarks definitivos.
- Código nível-amostra: testado onde importa, mas não endurecido pra produção.

## Licença

[MIT](LICENSE) — use como quiser. Sem garantia; é uma amostra.
