# Tasks — deepen-run-provenance

## 0. Preconditions

- [x] 0.1 Archive `bridge-harness-provenance` (syncs the `prov-run-events` / `prov-harness-bridge` capability specs and the `harness-runtime` modification into `openspec/specs/` — this change's deltas modify those capabilities and assume the synced base)
- [x] 0.2 tsprov release + adoption: tag/publish the release containing the merged `formalAttributeConflict` policy (inflexa-ai/tsprov#3, commit `5603bef` — no code change expected; bump `~/repos/inflexa/tsprov` `package.json` version as part of the release), then bump `cli/package.json`'s pinned `@inflexa-ai/tsprov` and `bun install`

## 1. Harness: reshaped `RunProvenanceEvent` + settlement-site step emission

- [x] 1.1 Reshape `RunProvenanceEvent` in `harness/src/workflows/execute-analysis.ts` (design D1/D2/D5): `run_started` gains `atMs`; `run_completed` gains `atMs` + `durationMs`; new `step_completed` arm `{ analysisId, runId, stepId, status: "completed" | "failed" | "canceled", durationMs?, atMs }` — JSDoc stating times are `DBOS.now()`-sourced (checkpointed → replay-stable) and that `durationMs` on `run_completed` is terminal-minus-start
- [x] 1.2 Read `const startedAtMs = await DBOS.now()` after `validateAndInit` and pass it into the `run_started` emission (~`execute-analysis.ts:377`); thread `startedAtMs` into `collectAndComplete`, read a terminal `DBOS.now()` there, and emit `run_completed` with `atMs` + computed `durationMs` at BOTH terminal sites
- [x] 1.3 Emit `step_completed` at each of the four scheduler settlement branches (`execute-analysis.ts:644-699`, beside `stepRuntime.set`), mapping `complete → "completed"`, `canceled → "canceled"`, failed/blocked/child-error → `"failed"`, with the child result's `durationMs` where present and a per-settlement `await DBOS.now()` as `atMs` — plain guarded calls (NOT step-wrapped), same replay rationale as the existing sites
- [x] 1.4 Harness tests: settlement emissions for a mixed plan (success + zero-artifact success + failure + canceled sibling; never-dispatched dependent emits nothing); `run_completed` carries `durationMs`; replay-stability covered by asserting emitted times come from the (fake) `DBOS.now()` values, not `Date.now()`; absent-callback and throwing-observer behavior unchanged. `tsc -p tsconfig.json && bun test` green in `harness/`

## 2. cli vocabulary: types, events, builders

- [x] 2.1 Reshape the domain types in `src/types/prov.ts` (design D1, spec `prov-run-events`): `ProvRunRef` gains `startedAtMs`; `ProvRunOutcome` gains `completedAtMs` (keeping `status` + optional `durationMs`); `ProvStepRef` slims to `{ runId, stepId }`; new `ProvStepOutcome { runId, stepId, status: "completed" | "failed" | "canceled", completedAtMs, durationMs? }`; new `ProvUsedInputRef { path, hash, source: "data" | "upstream" | "prior", fileId? }` — JSDoc on every exported type/property
- [x] 2.2 Update `src/types/events.ts` + `src/lib/bus.ts`: `prov.step_completed` carries `outcome: ProvStepOutcome`; new `prov.input_used { analysisId, actor, step: ProvStepRef, input: ProvUsedInputRef }`; telemetry projections (runId+stepId+status for step; path+source for input)
- [x] 2.3 Rework the builders in `src/modules/prov/document.ts`: formal times ONLY from payload timestamps (`new Date(ms).toISOString()`; no wall-clock reads into formal positions — `occurrenceTime()` stays as safety net); `appendStepCompleted` takes `ProvStepOutcome` and records `inflexa:status`; new `appendInputUsed` per design D3 (entity in the `(path, hash)` file-QName space with `inflexa:path/hash/source/fileId?`, plus a deterministically-identified `used(stepQn, entityQn)` edge following the existing endpoint-tuple relation-id scheme); export what the bridge needs
- [x] 2.4 Recorder: `prov.input_used` case in `src/modules/prov/prov.ts` (existing pattern) and the reshaped `prov.step_completed` payload
- [x] 2.5 Builder + recorder tests: run/step times equal payload times (not append-time clock); the prior-run-input chain scenario (input QName === producing file QName after unify); step activity carries status; input entity round-trips; duplicate-emission dedup extended to the `used` input edge; recorder end-to-end for `prov.input_used`
- [x] 2.6 Pass `{ formalAttributeConflict: "first" }` at the cli's persistence/export `unified()` call sites (the flush in `prov.ts`, `serializeProvenance` in `document.ts`) with a test: a document holding two same-QName activities with differing formal times still flushes/signs/persists, first value surviving (design D4 — retires the permanent-flush-poison failure mode)
- [x] 2.7 `bun run typecheck && bun run lint && bun test` green in `cli/`; format touched files

## 3. cli bridge: adapter + emitter rework

- [x] 3.1 `src/modules/harness/prov_bridge.ts` — adapter: DROP the `prov.step_completed` emission; ADD `prov.input_used` per `collector.getTrackedInputs()` ref (skip `source: "artifacts"`; strip the leading `/{input.resourceId}/` to analysis-relative; hash-less ref → `failed` with a named error, mirroring the artifact stance); file-event mechanics unchanged (path scoping, producer join, `externalId` write-back)
- [x] 3.2 `createRunProvenanceEmitter`: map the new `step_completed` arm to `prov.step_completed` (`ProvStepOutcome` from the harness facts); pass `startedAtMs`/`completedAtMs`/`durationMs` through on the run arms — no clock reads in the mapping (the exhaustive `never` default forces this arm at compile time)
- [x] 3.3 Bridge tests: registration emits file + input events and NO step event; input skip/strip/hash-less cases; emitter maps all three arms with pass-through times
- [x] 3.4 `bun run typecheck && bun run lint && bun test` green in `cli/`

## 4. End-to-end verification and close-out

- [x] 4.1 Live E2E (real Postgres + Docker): run a plan containing a zero-artifact step and a failing step; assert the signed document holds one step activity per EXECUTED step with correct statuses, run start/end/duration equal to workflow-observed times, `prov.input_used` entities with attested hashes, and `inflexa prov verify` passes
- [x] 4.2 Cross-run chain check: run 2 reads run 1's output; assert the unified document contains ONE entity for that file — generated by run 1's step, used by run 2's step
- [x] 4.3 Detach-durability re-check (kill mid-run → recovery): single run activity whose times equal the ORIGINAL workflow times; no duplicated relations; flush survives
- [x] 4.4 Full gates both subsystems (`cd harness && tsc -p tsconfig.json && bun test`; `cd cli && bun run typecheck && bun run lint && bun test`); format all touched `src/` files
- [x] 4.5 Close-out: update `docs/harness_integration-new/00-progress.md` (this change landed; the change-D acceptances it retires) and add the change node to `06-change-graph.md`; file the upstream harness issue for the `summary.md` walk-ordering quirk (`sandbox-step.ts:696` vs `:720-727` — registered neither in provenance nor `cortex_artifacts`); note the abnormal-termination acceptance (scheduler-loop throw / watchdog-wedged run → open run activity) is now documented in the design
