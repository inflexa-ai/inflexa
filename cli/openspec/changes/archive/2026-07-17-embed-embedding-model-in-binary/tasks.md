## 1. Model pin surface (setup.ts)

- [x] 1.1 Create the leaf module `src/modules/embedding/model_pin.ts` (no imports) exporting `MODEL_URL`, `MODEL_SHA256`, and `MODEL_ARTIFACT` (the filename `bge-small-en-v1.5-q8_0.gguf`), with the pin JSDoc + lockstep-bump note (pin constants + the embed-import literal must change together, mirroring `LLAMA_RUNTIME_TAG`'s note); `src/modules/embedding/setup.ts` imports the pin from it (no re-export). Homed in a leaf module so `scripts/build.ts` can import the pin without evaluating setup.ts's transitive `@inflexa-ai/harness` graph (D5).

## 2. Source-aware model acquisition (setup.ts)

- [x] 2.1 Add the define-gated embedded-asset accessor: `declare const __INFLEXA_COMPILED__` locally, plus a private `embeddedModelPath(): Promise<string | null>` whose `typeof`-guarded branch does `import("../../../.llama-cache/bge-small-en-v1.5-q8_0.gguf", { with: { type: "file" } })` (folds away outside a release build; D2/D3).
- [x] 2.2 Rename `downloadModel()` → `acquireModel()` and branch by `isCompiledBinary()`: compiled → copy embedded bytes bunfs-safely (`Bun.file(path).bytes()` + write to the `.part` stage), source → today's HuggingFace streaming download. Keep skip-if-present, `.part` → atomic rename, and SHA-256 verification of BOTH sources before the rename (D4); update the sole call site in `runLocalSetup`.
- [x] 2.3 Make user-facing copy install-context-aware (D8): the acquisition spinner ("Installing the bundled model" vs "Downloading … from HuggingFace") and the mode-picker `local` label in `promptEmbeddingMode`; sweep remaining setup.ts prose (module header, `runtime_unavailable` comment) for now-wrong "download the GGUF" claims about the compiled context.

## 3. Build-time embed (scripts/build.ts)

- [x] 3.1 Add `ensureModelCached()` beside `ensureLlamaArchiveCached()`: import the pin from `model_pin.ts`, download to `.llama-cache/<MODEL_ARTIFACT>` when absent, hash-verify (cache hit re-verifies; mismatch → loud `process.exit(1)` with delete-the-cache direction); run it ONCE before the target loop (D7).
- [x] 3.2 Widen `sweepLlamaCache()`'s keep-set to current llama artifacts + `MODEL_ARTIFACT` so the model survives the sweep while a superseded model file is removed before compiling (D6); rename/re-comment the sweep if its name no longer fits, and update the `.gitignore` comment for `.llama-cache/` to cover build-time embedded artifacts generally.

## 4. Tests

- [x] 4.1 Unit-test `acquireModel` source routing with `__setCompiledBinaryForTest`: compiled context copies the (test-fixture) embedded bytes with no fetch, source context downloads; checksum mismatch leaves nothing at the final path. Add a test seam for the embedded-byte source only if the folded import cannot be exercised under `bun test` (follow `__setLlamaAcquireForTest`'s pattern).
- [x] 4.2 Extend `setup.test.ts` flow coverage where behavior changed (already-present model skips acquisition in both contexts; declined setup acquires nothing).

## 5. Verify

- [x] 5.1 `bun run typecheck`, `bun run lint`, `bun test src/modules/embedding/`, and `bun run format:file` on touched src files.
- [x] 5.2 Host-target `bun run build`, then run the produced binary's `setup --embeddings local` with network egress to huggingface.co blocked (e.g. a bogus `HTTPS_PROXY`) to prove the offline path end-to-end; confirm the binary grew ~36 MB and the smoke test still passes.

## 6. Embeddings-preselection bypasses the runtime gate

- [x] 6.1 Reorder `setup()` in `src/modules/infra/setup.ts` so an explicit `--embeddings local|api-key|off` preselection runs the embedding step BEFORE the `firstReadyRuntime` probe, then continues into the rest of setup unchanged; guard against a double-run so the in-flow embedding step is skipped when the preselected step already ran. Leave the interactive no-preselection flow's embedding question in its current position (after provider auth). WHY comments: the air-gapped audience has no runtime, embeddings are now offline-capable in the compiled binary, and the interactive question order is spec-bound (D9).
- [x] 6.2 Test coverage for the reorder: a preselected mode configures embeddings when no runtime is ready (gate-independent), and the embedding step runs exactly once when a runtime IS ready — exercised through the module's existing test seams. If the setup module exposes no feasible unit seam for the ordering, record the rationale in the test file/PR instead.
- [x] 6.3 Re-run the 5.1 verification gate (`bun run typecheck`, `bun run lint`, `bun test src/modules/embedding/`, `bun run format:file` on touched src files) after the reorder.
