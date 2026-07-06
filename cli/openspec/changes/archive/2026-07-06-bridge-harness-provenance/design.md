# Design — bridge-harness-provenance

## Context

The run engine (change F) executes analyses end-to-end, but its `ArtifactRegistry` realization is a no-op stub (`cli/src/modules/harness/run_deps.ts:75`) and the cli's provenance vocabulary stops at analysis lifecycle events (`prov.analysis_created` / `prov.input_added` / `prov.input_removed`). The blueprint for the missing execution-level vocabulary exists as `stash@{0}` on `feat/provenance` — design-complete but written against the pre-monorepo tree with known defects (see D4). The governing research is `docs/harness_integration-new/03-provenance-migration-plan.md` (§4 schema fixes, §5 phases) and `05-prior-work.md` (port plan); the decision frame is **tsprov is the ledger, the harness machinery is the sensor**.

Verified seam facts this design builds on:

- `ArtifactRegistrationInput` carries `{resourceId, runId, stepId, artifacts, collector}` (`harness/src/execution/artifact-registry.ts:24-36`); registry implementations MUST NOT touch `cortex_artifacts` (`:69-71`) — the harness writes that ledger around the seam.
- Manifest entries reach `register()` post-reconcile: every surviving entry is rehashed from disk with size (`harness/src/execution/reconcile-manifest.ts:97-103`), and paths are already analysis-scoped `runs/{runId}/{stepId}/…` (`artifact-registry.ts:53-58`).
- `collector.getRecords()` yields per-path `producer.type ∈ "command" | "file_tool"` (`filesystem-artifact-registry.ts:108-111`, `provenance/types.ts:15-31`) — the same vocabulary as `ProvFileRef.producer`.
- The run boundaries live at three sites in `harness/src/workflows/execute-analysis.ts`: `data-run-started` (~:327), `data-run-completed` (~:781), `data-run-failed` (~:799).
- The recorder silently drops events whose `analysisId` has no analysis row (`cli/src/modules/prov/prov.ts` recorder guard) — harness `resourceId` must equal the cli `analysisId`, which the trigger contract guarantees (`DataProfileTriggerParams.analysisId`; the run path passes `analysis.id` directly).
- `initProvenanceRecording()` runs unconditionally at cli entry (`cli/src/index.ts:22`), so the recorder is live for every command boot — including a future boot that adopts a detached run via DBOS recovery.

## Goals / Non-Goals

**Goals:**

- `inflexa run` ends with a signed tsprov document covering run → steps → files; `inflexa prov verify` passes.
- Provenance survives Ctrl+C detach: a run completing on a later boot's DBOS recovery still records its completion.
- Replay idempotency: DBOS re-execution of workflow bodies re-emits events without structurally duplicating PROV records.
- The harness stays tsprov-free and Bus-free; all mapping happens at the cli composition root.

**Non-Goals:**

- Deleting `FilesystemArtifactRegistry` / dead seams (change E, sequenced after).
- Lineage for data-profile or ephemeral-agent runs (`data-profile.ts` builds sandbox agents with no registry seam — grep-verified zero `ArtifactRegistry` references; the coverage hole stays documented in the research).
- Rich `Producer` objects, per-input `used()` edges, the `deletes` wire arm, new `ProvActor` kinds — all additive later.

## Decisions

### D1 — One change: the event-vocabulary port (change B) is the first slice, not a separate change

B alone would land four events nobody emits. Folding it in mirrors A→C and gives the change a user-visible outcome. The port is by hand from `stash@{0}` (the stash targets the dead pre-monorepo tree from a dangling base commit — `git stash pop` is impossible; `05-prior-work.md` §2). Test-API drift to apply during the port: `flushProvenance` → `flushProvenanceAsync` where the async path is meant, `verifyChainHash` → `verifyHexDigest`.

### D2 — Run-lifecycle events are emitted by the harness workflow (Option A), not the cli watch loop

`ExecuteAnalysisDeps` gains **one optional dep**: `emitProvenance?: (event: RunProvenanceEvent) => void`, called at the three existing run-boundary sites. Rationale over cli-side emission (Option B, zero harness change): the run command's watch loop dies on Ctrl+C detach while the workflow completes on a later boot's recovery (`run.ts:460-465` — "exiting now would orphan it until a future boot adopts it"). With in-workflow emission, DBOS re-executes the body on recovery and the callback re-fires; deterministic QNames (D4) make the re-emission idempotent. Option B would permanently record a run that started and never ended. The optional-dep pattern matches the harness's DI style (`synthesisEnabled?`, `ownsMandate?`).

Call-site mechanics: plain synchronous calls in the workflow body, **not** wrapped in `DBOS.runStep` — the emission is a fire-and-forget observation whose durability comes from body re-execution, not step caching (a cached step would *prevent* re-emission on recovery, defeating the point). Each call site is guarded (`try/catch` + `console.error`): a host observer must never corrupt workflow state — the harness is host-agnostic and cannot assume the callback is total. This guard does NOT conflict with the cli's prov-must-sign policy: integrity lives at the cli's flush/sign path, which keeps its crash-on-signing-failure behavior unchanged; the guard only isolates in-memory observer defects from the run.

### D3 — `RunProvenanceEvent` is a harness-owned plain union; tsprov stays cli-only

The harness never learns tsprov or the cli's bus types (settled in `03` §2; tsprov is a cli dependency only, `cli/package.json:23`). The event carries execution facts in harness vocabulary:

```ts
/** harness/src/workflows/execute-analysis.ts (exported via the barrel) */
export type RunProvenanceEvent =
    | { type: "run_started"; analysisId: string; runId: string; planSummary: string; stepCount: number }
    | {
          type: "run_completed";
          analysisId: string;
          runId: string;
          /** The body's terminal status — RunStatus minus "running". */
          status: "completed" | "partial" | "failed" | "canceled" | "suspended_insufficient_funds";
      };
```

Both terminal sites (`data-run-completed` and `data-run-failed`) emit `run_completed`; the status distinguishes them — the old research missed the failed path, re-confirmed in `03` §3. `durationMs` is deliberately absent: the seam has no deterministic duration at the terminal sites (wall-clock reads inside a replayed body are nondeterministic); `ProvRunOutcome.durationMs` stays optional and unset in this cut. The cli realizes the dep at the composition root: map `run_started` → `Bus.emit("prov.run_started", …)` and `run_completed` → `Bus.emit("prov.run_completed", …)`, stamping the existing system actor (D5).

### D4 — The PROV record model: deterministic QNames, run and step are activities, file is an entity

The stash's builders have defects beyond the seven §4 fixes — two records are PROV-invalid, found by inspecting the diff during this design:

1. `appendRunStarted` writes `wasGeneratedBy(analysisQn, runQn)`, but `appendCreation` already generated the analysis entity — a second generation violates PROV generation-uniqueness, and every subsequent run would add another.
2. `appendFileWritten` writes `wasGeneratedBy(fileQn, stepQn)` where the stash declares the step as an **entity** — generation requires an activity.

Both fall out of the same correction the §4.6 fix already points at (the run activity/entity double-use): **runs and steps are activities; files are entities.** The full record model:

| Builder | Records appended |
|---|---|
| `appendRunStarted(doc, analysisId, actor, run)` | `activity(runQn, time, —, {prov:type: inflexa:Run, inflexa:runId, inflexa:planSummary?})`; `wasAssociatedWith(runQn, agentQn)`; `used(runQn, analysisQn, time)` |
| `appendRunCompleted(doc, analysisId, actor, outcome)` | `activity(runQn, —, time, {inflexa:status, inflexa:durationMs?})` — same QName; `unified()` merges start/end records into one activity (resolves §4.6) |
| `appendStepCompleted(doc, analysisId, actor, step)` | `activity(stepQn, —, time, {prov:type: inflexa:Step, inflexa:runId, inflexa:stepId, inflexa:durationMs?})`; `wasInformedBy(stepQn, runQn)`; `wasAssociatedWith(stepQn, agentQn)` |
| `appendFileWritten(doc, analysisId, actor, file, step)` | `entity(fileQn, {prov:type: inflexa:File, inflexa:path, inflexa:hash, inflexa:size, inflexa:producer})`; `wasGeneratedBy(fileQn, stepQn, time)` — valid now that the step is an activity; `wasAttributedTo(fileQn, agentQn)`; `wasDerivedFrom(fileQn, analysisQn)` — the coarse lineage edge (old Q2: no per-input edges at cutover) |

QNames, all deterministic from event content (the §4.5 rule — this is what makes DBOS replay idempotent under `unified()`; the stash's QName helpers port as-is): `runQn = inflexa:run-{runId}`, `stepQn = inflexa:step-{runId}-{stepId}`, `fileQn = inflexa:file-{Bun.hash(path|hash).toString(36)}`. The orphan-action quirk is fixed by construction: the run/step/file builders do **not** call `startAction` (which mints a random `inflexa:action-{uuid}` activity per event); they share only its preamble — a new helper that declares the agent and returns `{analysisQn, agentQn, time}` without minting an activity. `startAction` remains for the three analysis-lifecycle builders, whose action-per-event model is correct for genuinely distinct user actions.

Domain-type corrections carried from §4 (vs the stash shapes): `ProvRunOutcome.status` widened to the five terminal values; `ProvStepRef` drops `command`/`exitCode` (per-output-file facts in the harness, not per-step); `ProvRunRef.goal` → `planSummary` (harness vocabulary); `ProvFileRef.producer` stays the bare `"command" | "file_tool"` discriminant.

### D5 — Run/step/file events carry the existing `{kind: "system"}` actor

Machine execution, not a user action. The system-actor constructor already exists in `modules/prov/prov.ts` (~:38, `{kind: "system", version, commit}` from pkg + `bakedEnv`) — export it (or lift it beside the types) so the bridge reuses it rather than duplicating the version/commit sourcing. A model/agent `ProvActor` kind (`prov:SoftwareAgent`, `actedOnBehalfOf`) is a deliberate additive follow-up — `appendAgent` throws on unknown kinds, so growth cannot happen by accident.

### D6 — The bus-adapter registry lives in `modules/harness/prov_bridge.ts` and translates, never persists

Placement: with the other seam realizations in the harness module (keeps every `@inflexa-ai/harness` import inside `modules/harness/`; the prov module stays harness-free; dependency direction stays acyclic — the bridge imports `lib/bus` + `types/events` + the prov module's actor helper). The same file hosts both bridge halves: the `ArtifactRegistry` adapter and the `emitProvenance` realization.

`register(input, session)` mechanics, in order:

1. Emit `prov.step_completed` once (step activity first, so file generations reference a declared activity — tolerated as a forward reference by PROV either way, but declaration-first keeps exports legible). `durationMs` is unset — the seam carries no step duration.
2. For each manifest entry, emit `prov.file_written` with `{path, hash, size, producer}`: manifest entries arrive STEP-relative at this seam (`artifact-registration.ts:55,65` builds the ledger paths by prefixing `runs/{runId}/{stepId}/` — the research note about paths "already using the convention" described the filesystem registry's *output*, which prefixes identically at `filesystem-artifact-registry.ts:94-96`, not the seam input). The adapter prefixes the same way and uses the one analysis-scoped string for the event path, the file-QName seed, and `registered[].path` — the external-id write-back (`updateArtifactId`) matches ledger rows by that exact path, and unscoped paths would also collide same-named files across steps. `producer` joins the RAW step-relative entry path against `collector.getRecords()` (also step-relative keys) and takes `record.producer.type`, defaulting to `"command"` when no record matches (inotify-only observations have no in-process producer record; a sandbox write without one is by construction a command effect). The hash arrives `sha256:`-prefixed from reconcile and passes through verbatim — the QName and attribute use the same string, so format consistency is what matters.
3. An entry missing `hash` (schema-optional, but reconcile guarantees it) goes to `failed` with a named error instead of being emitted — a file we cannot content-attest is a registration failure under the fail-fast attestation stance (`03` §1 STAYS), and its absence post-reconcile is an upstream defect that must surface, not be papered over with a sentinel hash.
4. Return `{registered: [{path, externalId: fileQn}], failed, failedCount: failed.length}` — the deterministic file QName as `externalId` gives the `cortex_artifacts` row a stable cross-reference into the signed document (the harness writes it back around the seam). `sync()` stays a no-op: the bytes already live on host disk.

The adapter complies with "MUST NOT touch `cortex_artifacts`" by construction — it only emits bus events. Emission is synchronous in-process dispatch; the recorder appends to the live document and debounce-schedules a flush.

### D7 — Flush/exit lifecycle: one run-command exit-path fix, no new machinery

The recorder is initialized at every cli entry (`index.ts:22`) and the entry point wires `flushProvenanceAsync` into shutdown (`index.ts:25`). The blocking run command keeps the process alive through the terminal event; the detached case is covered by D2 (re-emission on the recovery boot, where the recorder is equally live). Signing behavior is untouched: flush → chain hash → Ed25519 sign, crash on signing failure (prov-must-sign).

One gap found during apply-time verification: `reportTerminal`'s non-completed branches exit via `fail()` (`run.ts` — partial/failed/canceled/suspended), and `fail()` is a bare `process.exit(1)` (`lib/cli.ts:10-12`) that skips the shutdown hooks. The terminal `prov.run_completed` event usually flushes anyway (the `setTimeout(0)` debounce fires during `reportTerminal`'s awaited DB reads), but that is a race — and the failed-run document is exactly the record this change exists to guarantee. Fix: the failure branches print their message and exit via `shutdown(1)`, mirroring the `completed` branch's `shutdown(0)`, so every terminal report path runs the flush hooks. `fail()` remains correct for pre-flight bail-outs, where no provenance is pending.

### D8 — Additive harness barrel growth only

The cli adapter needs to *name* the seam types: verify and, where missing, add barrel exports for `ArtifactRegistrationInput`, `ArtifactSyncInput`, `ExternalRegistrationResult`, `ProvenanceCollector` (the step-level class type), `ArtifactManifestEntry`, and the new `RunProvenanceEvent`. No harness behavior changes besides the three guarded `emitProvenance` call sites; `assembleCoreRuntime` is untouched (the cli registers directly, per change F's D1 debt — restated, not discharged).

## Risks / Trade-offs

- **[tsprov `unified()` merge semantics for split activity records]** RESOLVED during apply: the merge works — two `activity(runQn, …)` records (start-time, end-time) unify into one activity carrying both times (gate test green).
- **[Replay attribute variance]** REVISED during apply — the original assumption ("attribute-level variance is tolerable") is FALSE for formal time attributes: tsprov's `unified()` THROWS ("Cannot have more than one value for attribute prov:startTime/prov:endTime") when same-QName activity records carry *different* values for the same single-valued formal time, so a recovery re-emission with a fresh clock would crash the flush. → Mitigation shipped: `occurrenceTime()` in `document.ts` stamps the wall clock only when the QName's time slot is not yet populated (in-memory or in the deserialized persisted document) and omits it on re-emission — first-observed time survives, which is also the semantically correct occurrence time. Custom (`inflexa:*`) attributes are multi-valued and unaffected; duplicate anonymous relation records (`used`/`wasGeneratedBy` across replays) accumulate harmlessly. Follow-up (we own tsprov): consider a `unified()` attribute-conflict policy option so the strict-throw is opt-out rather than a latent flush-crash for any future same-QName re-declaration.
- **[Suspended runs emit two terminal events]** A `suspended_insufficient_funds` run that later resumes and completes emits `run_completed` twice with different statuses; both land as attributes on the one run activity. → Accepted and documented: PROV attributes are multi-valued; the export stays legible and the true final status is recoverable from the ledger. Revisit if suspension becomes reachable locally (the OSS billing seam is a no-op today).
- **[Observer failures]** A defect in the cli's mapping could throw inside the workflow body. → Mitigation: harness guards each `emitProvenance` call site; the run proceeds and the defect logs loudly. Integrity enforcement stays at the cli flush (crash on signing failure), where it belongs.
- **[Silent event drop on analysisId mismatch]** If harness `resourceId` ever diverged from the cli `analysisId`, events would vanish without error. → Accepted: the trigger contract guarantees equality today; the end-to-end test would catch a regression (document missing run records).

## Migration Plan

Single PR, no data migration (the provenance column format is unchanged — new record types only). Implementation order matches the task slices: vocabulary port (compiles + tests green standalone) → bridge module → harness dep + wiring → end-to-end verification. Rollback: revert the PR; the stub registry pattern is preserved in git history and change E has not yet deleted the harness fallback.

## Open Questions

None blocking — the four user decisions from `03` §6 were settled in conversation (Option A; bare producer; `deletes` kept reserved; executeAnalysis-only coverage).
