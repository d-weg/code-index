# codeindex docs

| Doc | Covers |
|---|---|
| [../ARCHITECTURE.md](../ARCHITECTURE.md) | Core retrieval pipeline: symbols, import graph, embeddings, BM25, RRF, graph expansion, incremental update. |
| [ast-edit-protocol.md](ast-edit-protocol.md) | AST-anchored edit-ops layer (`src/edit/`): nodeId grammar, wire protocol (SET_BODY / REPLACE_NODE / REPLACE_TEXT / RENAME), runner, guards, diagnostics gate. |
| [benchmarks.md](benchmarks.md) | Two harnesses: embedder comparison (bge-small vs potion-code-16M) and the edit-protocol output-token savings, incl. the Node-native Model2Vec port + parity proof. |

Run the test/bench scripts from the repo root — see the README "Capabilities" table.
