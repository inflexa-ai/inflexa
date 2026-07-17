## 1. Restructure `vectorIndexStepOutputs`

- [x] 1.1 Split index setup (`ensureSearchIndex` + `createVectorStore` + `searchIndexName`) into its own failure boundary: on failure, warn and return without attempting any item
- [x] 1.2 Add a per-item boundary (`indexOne(id, text, metadata) → boolean`) that embeds and upserts one item, absorbing its failure and logging it with the item id and text length; bind `runId`/`stepId` once on the stage logger via `.with(...)`
- [x] 1.3 Drive the surviving file descriptions and the step summary through the per-item boundary, tallying indexed/failed, and emit one summary warn carrying both counts when at least one item failed

## 2. Tests (`post-step-pipeline` vector-index stage)

- [x] 2.1 One poisoned item: embedding fails for a single file description — assert every other description and the summary still land in the vector store and the stage does not throw
- [x] 2.2 Poisoned summary: the summary embed fails — assert all file descriptions still land
- [x] 2.3 Setup failure: `ensureSearchIndex` fails — assert nothing is indexed and the stage does not throw
- [x] 2.4 Observability: with a recording test logger, assert the per-item failure log carries the item id and text length and the summary log carries the indexed/failed counts

## 3. Verify

- [x] 3.1 `tsc -p tsconfig.json` and `bun test` pass; `bun run format:file` on touched `src/` files
- [x] 3.2 `openspec validate isolate-vector-index-failures`
