## 1. Spike S1 — proxy wire-shape verification (GATE: do first, decides D6)

- [x] 1.1 Verify CLIProxyAPI serves the Anthropic Messages API (`/v1/messages`) with a streamed round-trip against the running local proxy; record the result in design.md
- [x] 1.2 Verify CLIProxyAPI serves an embeddings endpoint compatible with `createEmbeddingProvider`; record the result
- [x] 1.3 If either is absent: decide and record the fallback (OpenAI-compatible ChatProvider realization vs gating on an Anthropic-authenticated proxy) before starting group 4

## 2. Input staging module (cli)

- [x] 2.1 Move `src/modules/staging/{staging.ts,staging.test.ts}` to `cli/src/modules/staging/` and delete the root-`src/` copies; imports must resolve unchanged against `cli/src` (verified in `docs/harness_integration-new/05-prior-work.md` §3)
- [x] 2.2 Fix `walkFiles`: stat-resolve symlink entries (file symlink → staged, dir symlink → traversed, dangling → skipped) and make the comment truthful
- [x] 2.3 Document the `deriveFileId` subpath divergence for directory members (single-file: `anchorId|path`; member: `anchorId|path/subpath`)
- [x] 2.4 Add the session-tree path helper (global base `{cli data dir}/sessions`, per D2) and a `sessionTreeDataDir(analysisId)` used as `stageInputs` targetDir — no double `inputs/inputs` segment
- [x] 2.5 Extend the staging test suite to cover the symlink scenarios and stable `fileId` re-staging (+ fixed a re-staging hazard found while writing them: stale hardlink dest + `copyFileSync` same-inode truncation would destroy the source; `stageFile` now removes the stale dest first)

## 3. Harness barrel growth (harness, additive only)

- [x] 3.1 Export from `harness/src/index.ts`: `launchDbos`, `shutdownDbos`, `DbosConfig`; `registerDataProfileWorkflow`, `DataProfileDeps`, `triggerDataProfile`, `DataProfileTriggerDeps`, `DataProfileTriggerParams`, `DataProfileTriggerResult`; `StagedInput`; `createSandboxClient`, `CreateSandboxClientConfig`, `SandboxBackendConfig`, `ResourceLimits`; `createWorkspaceFilesystem`, `WorkspaceFilesystemDeps`; `workflowIdFromExec`; `ExecEventMessageSchema`, `ExecEventMessage`, `DoneMarker` (+ `WorkspaceFilesystem`, `SandboxClient`, `DataProfileWorkflowInput`, `ResourceLimitsSchema` — needed to type/parse the cli side)
- [x] 3.2 Flag (comment or upstream note) the `register-workflows.ts:35` register-after-launch docstring that contradicts `assemble.ts` — do not change behavior
- [x] 3.3 (added during apply) `sandbox/deliver-exec-event.ts` + barrel export: `execEventTopic` + `deliverExecEvent` — the embedder cannot `DBOS.send` through its own SDK copy (module-singleton; a second `node_modules` copy is un-launched), so the ingress delivers through the harness

## 4. Embedded runtime composition (cli)

- [x] 4.1 Add `"@inflexa-ai/harness": "file:../harness"` to `cli/package.json` and install; confirm the cli builds with the dependency present (also: `@types/node@^26` devDep pin — the k8s-client transitive hoisted 24.x and broke bus.ts's `EventEmitterEventMap` typings; protobufjs postinstall is blocked by bun, benign)
- [x] 4.2 Add config surface (`harness` key in lib/config.ts + resolver in modules/harness/config.ts): profile model id, embedding endpoint (REQUIRED prerequisite per S1), bio keys, sandbox image (default `sandbox-base:latest`), resource-limit defaults (4 cpu / 8 GB / 0 gpu), DBOS admin port (default 8433), skillsDir (dev default: repo `skills/`)
- [x] 4.3 Build the exec-callback ingress listener (modules/harness/ingress.ts — loopback, ephemeral port, dumb-route bytes/header preservation, done-marker wrap, 400/404/502 per the sandbox-server retry contract; delivery via harness `deliverExecEvent`, task 3.3); 9 unit tests incl. a live bind round-trip
- [x] 4.4 Build the composition module (modules/harness/runtime.ts): pool via harness `createPool` (no cli-side pg dep); local authorizer + noop billing; Anthropic provider at the proxy (S1-verified) with key from the proxy config + model from config-or-`/models`; workspace fs + docker sandbox client on `env.sessionsDir`; skillsDir/embedding pre-flight
- [x] 4.5 Implement lazy singleton boot (prereqs → Postgres → listener → register → `launchDbos`) and `onShutdown` teardown (`shutdownDbos` → listener close → pool end); no passive flow reaches it
- [x] 4.6 Unit-test the boot sequencing via injectable `BootSeams` (order, config-model vs proxy-model, idempotent second boot, Postgres-unready short-circuit, zero-side-effect prereq failures, launch-throw cleanup) — 7 tests, fully offline

## 5. Launch command (cli)

- [x] 5.1 `inflexa profile` (modules/harness/profile.ts + registry entry): resolve analysis → pre-flight → boot → stage → `upsertAnalysis` ledger seed (discovered requirement — the trigger's CAS transitions the row this creates) → `triggerDataProfile` with `makeLocalAuth()`; empty manifest short-circuits. The command then BLOCKS until a terminal ledger state — the workflow runs in this process's DBOS runtime, so exiting after the trigger would orphan it; Ctrl+C detaches with DBOS-recoverable semantics
- [x] 5.2 All four `DataProfileTriggerResult` outcomes mapped to distinct messages; `failed` additionally mirrors the managed retry route (`tryRetryDataProfile` + `runDataProfile`, barrel-exported for this) so a previously failed profile is re-runnable
- [x] 5.3 Pre-flight prerequisite checks before staging/triggering: sandbox image via the container wrapper (`image inspect` + build guidance), embedding/skills/proxy-key/model/Postgres via typed `HarnessBootError` → one actionable message each (note: `fail()`'s SonicBoom exit noise is a pre-existing repo-wide pino race, observed identically on `inflexa open <bad-ref>` — out of scope)
- [x] 5.4 `inflexa profile --status`: read-only ledger view via `loadDataProfileStatus` (never boots or provisions — reuses the live runtime's pool or opens a throwaway connection); running rows from another/crashed session are annotated with the resume-on-next-boot note

## 7. E2E round-1 findings (added during apply — first live run, 56k-file directory input)

- [x] 7.1 Harness: chunk `upsertArtifacts` (`state/artifacts.ts`) — one multi-row INSERT overflowed the wire protocol's Int16 parameter count at >6,553 rows (observed: 56,654 files × 10 params wrapped to the reported 42,252); now ≤1,000 rows/statement, idempotent across chunks, fake-Querier regression tests
- [x] 7.2 Staging: directory-input walks skip noise dirs (harness `IGNORED_DIRS` parity + `.git`/`.inflexa`) — a project-root input staged its whole `node_modules`
- [x] 7.3 Staging: mirror reconciliation — staged files no current input produced are deleted and emptied dirs pruned at staging time (the reported "remove input didn't unlink the staged dir": the DB removal worked; no un-staging existed. Removal-time cleanup rejected: no manifest to key on there, and it could race a run's read-only mount)
- [x] 7.4 Harness (AI SDK migration bug, hit on E2E round 2): `sanitizeMessages` in `providers/ai-sdk.ts` strips empty text parts (and all-empty messages) at the outbound wire boundary — a tool-calls-only turn yields a ""-text assistant part that the loop echoes back, which Anthropic 400s ("text content blocks must be non-empty"); regression test in ai-sdk.test.ts
- [x] 7.5 Embedding boot pre-flight gained a reachability probe: one real embeddings POST against the CONFIGURED endpoint before any side effect — embeddings fail late in the workflow, so a dead endpoint must fail free and early. Embeddings remain their own config (baseURL + API key), deliberately a separate path from the chat proxy (user direction; a brief proxy-default variant was reverted)
- [x] 7.6 Staging (E2E round 3): anchorless absolute-path inputs no longer use the host path as the key — they stage under `{fileId}/{basename}` (host paths leaked into the sandbox layout + agent prompt, and `join` collapsed the leading slash so the on-disk path diverged from the key); reconciliation now compares absolute-to-absolute via `relativePath` (the key-based comparison deleted freshly staged anchorless files — the "empty inputs dir" the profiler agent correctly reported)

## 8. UX batch (post-E2E feedback)

- [x] 8.1 Exit bug: after the terminal state the command now drains explicitly (`shutdown(0)` → DBOS shutdown, ingress close, pool end, log flush) — the runtime's live handles (ingress listener, pools, DBOS admin server) kept the event loop busy so `beforeExit → shutdown()` never fired and the process hung until Ctrl+C
- [x] 8.2 Clack presentation for `inflexa profile`: intro/outro, spinners for boot/staging, trigger outcomes via `log.step`/`log.info`, and live progress during the run — the spinner narrates the newest workflow's latest step from `dbos.operation_outputs` (`friendlyStepLabel`: model rounds, tool names, sandbox activity) plus elapsed time; progress reads are best-effort and never abort the wait
- [x] 8.3 DBOS SDK launch banner quieted: `DbosConfig` gained an optional `logLevel` (additive harness change) and the cli passes `warn` — "Listening to 0 queues" was the SDK's info-level queue listing (we register none; workflows start directly). Known cosmetic leftovers: infra's "Starting inflexa containers…" prints and the harness's few `[data-profile]` console lines still interleave with the spinner

## 6. End-to-end verification and closure

- [x] 6.1 E2E on the dev machine — **completed 2026-07-02** after three live rounds (each finding a real bug: unchunked artifact insert, AI SDK empty-text-block echo, anchorless-key/reconcile deletion): staging → boot → sandbox exec → HMAC callbacks through the ingress → profiler agent → `submit_profile` → vector indexing (2 files) → ledger `completed`. Embeddings via a user-configured external endpoint (`harness.embedding`)
- [ ] 6.2 Verify shutdown/recovery: kill the cli mid-profile, boot again, confirm the run resumes and status shows it (register-order drift check from D1) — blocked on 6.1
- [x] 6.3 Updated `docs/harness_integration-new/06-change-graph.md` (change C status + 4 implementation facts that supersede the research) and `04-file-materialization.md` §3.1 (sessionsBasePath resolution — per-analysis is impossible, not just unchosen)
- [x] 6.4 Full cli suite 340/340 green; harness `tsc` clean; changed files lint clean (the repo's 12 pre-existing `must-use-result` test errors + 4 solid warnings are all in untouched files); passive-flow guarantee verified — the only `modules/harness` import outside the module is the lazy import inside the `profile` command action (`src/cli/index.ts:129`)
