# Design — deepen-run-provenance

## Context

Change D (`bridge-harness-provenance`, archived predecessor of this change) landed the execution-provenance pipeline: harness → `emitProvenance` callback + bus-adapter `ArtifactRegistry` → `prov.*` bus events → tsprov builders → signed column. It shipped with three deliberate cuts and one unadopted upstream fix, all settled as user decisions on 2026-07-06 in the assessment session that produced this change:

1. **Times are cli receipt times.** Builders stamp `new Date()` at append time, guarded by `occurrenceTime()` (first-observed wins) because tsprov's `unified()` throws on conflicting formal times. First-observed is wrong when the first observation is itself a late recovery boot, and run duration is unrecordable.
2. **Steps are visible only via registration.** `prov.step_completed` fires inside `ArtifactRegistry.register()`, which the post-step pipeline skips entirely for an empty reconciled manifest (`post-step-pipeline.ts:148`) and never reaches for failed steps. Change D's own E2E assertion "one step activity per plan step" only holds for plans where every step produces artifacts.
3. **Input reads are dropped.** `collector.getTrackedInputs()` arrives content-attested at the registry seam (`fillInputHashesFromDisk` hashes fail-fast from disk, `reconcile-manifest.ts:124-160`) and the adapter ignores it.
4. **tsprov#3 is merged but unadopted.** `FormalAttributeConflictPolicy` (`"throw" | "first" | "last"`, default `"throw"`) is threaded through `unified()` upstream (tsprov commit `5603bef`), but no release carries it and the cli passes nothing — a formal-attribute conflict at flush still throws out of `flushProvenanceAsync` (`prov.ts` flush calls `doc.unified().serialize("json")` bare), leaving the analysis dirty and permanently unfushable.

Verified seam facts this design builds on:

- `DBOS.now()` is a checkpointed step: replayed bodies read the recorded value. The harness already relies on this for the ledger's step `durationMs` (`sandbox-step.ts:770`). Change D's premise "the seam has no deterministic clock" was wrong.
- The scheduler settlement site (`execute-analysis.ts:644-699`) sees every *executed* step exactly once per body execution, with the child's durable `SandboxStepResult` (status + `durationMs` checkpointed as workflow output — replay-stable).
- Collector input refs carry container-absolute paths (`/{resourceId}/…` — `collector.ts:225` builds `${mountPath}/${relativePath}`; `reconcile-manifest.ts:131-137` maps them onto the host tree by joining with `sessionPath`).
- Prior-run reads keep their `runs/{priorRunId}/{stepId}/…` shape after stripping the mount root (`exec-frame.ts:5-9`), which is byte-identical to the analysis-scoped path the producing step's `prov.file_written` used — same `(path, hash)` → same file QName.

## Goals / Non-Goals

**Goals:**

- Run and step activities carry true workflow times and durations, identical across DBOS replays without relying on `occurrenceTime()`.
- Every step that *executed* appears in the signed document with its terminal status; failed and zero-artifact steps included.
- The signed document answers "which inputs did this step read", with content-attested hashes, and chains across runs automatically when a step consumes a prior run's output.
- A formal-attribute conflict inside `unified()` can never again poison an analysis's flush.

**Non-Goals:**

- Linking `data/`-input `used` entities to the anchor-keyed `inflexa:input-*` entities from `prov.input_added` (additive follow-up; different path spaces — staged copy vs source).
- Lineage for data-profile / ephemeral runs (unchanged coverage hole; no registry seam on those paths).
- Fixing the harness's `summary.md` walk-ordering quirk (filed upstream; the manifest pipeline is out of this change's scope).
- Emitting provenance for abnormal terminations (scheduler-loop throw, watchdog-wedged runs) — accepted and now *documented*; the open run activity mirrors the ledger's own gap.

## Decisions

### D1 — Times ride the events as epoch-ms from `DBOS.now()`; builders stop reading the clock

Each `RunProvenanceEvent` arm carries the milliseconds the harness observed the boundary: `run_started.atMs` (one `await DBOS.now()` after `validateAndInit`, before the existing emission at `execute-analysis.ts:377`), `run_completed.atMs` + `durationMs = atMs − startedAtMs` (one `await DBOS.now()` in `collectAndComplete`, threaded the same way `runId` already is), and `step_completed.atMs` (one `await DBOS.now()` per settlement). Cost: two checkpointed steps per run plus one per step settlement — noise against multi-minute sandbox steps. The cli domain types carry the numbers (`ProvRunRef.startedAtMs`, `ProvRunOutcome.completedAtMs` + `durationMs`, `ProvStepOutcome.completedAtMs`); builders convert to ISO for the formal `prov:startTime`/`prov:endTime` positions. Because the values are replay-identical, re-emission merges as "same value → ignore" in tsprov — `occurrenceTime()` becomes a pure safety net for defensive depth, no longer the mechanism.

Alternative considered — keep `occurrenceTime()` as the mechanism (change D's shipped state): rejected because first-observed receipt time is *wrong* (not just imprecise) when the first flush-surviving observation happens on a recovery boot hours later, and it can never provide durations.

### D2 — `step_completed` emits at the scheduler settlement, not the registry

The four settlement branches (`execute-analysis.ts:644-699`, beside `stepRuntime.set`) each fire one guarded `emitProvenance` with the terminal status mapped as: `complete → "completed"`, `canceled → "canceled"`, `failed`/`blocked`/child-error → `"failed"`; `durationMs` from the durable child result where present (the child-error branch has none). This is the only site that sees *every executed* step: registration sees only artifact-producing steps, and the child workflow body cannot see its own "the parent canceled me" outcome. Never-dispatched steps (dependents of a failed sibling) emit nothing — they never executed; the run's terminal status carries that story. The bus-adapter registry stops emitting `prov.step_completed`; file generations may now reference a step activity declared *after* them in bus order (registration happens mid-step, settlement at the end) — PROV tolerates forward references, and `unified()` output is order-independent, so nothing breaks; the spec scenario asserting "step event then file events" is superseded.

Alternative considered — keep registration-driven step events and add only a `step_failed` arm: rejected; zero-artifact completed steps would stay invisible and two emission sites would need to stay mutually coherent.

### D3 — `prov.input_used` from the registry seam, entities keyed in the file-QName space

The registry seam is where the attested inputs exist (`input.collector.getTrackedInputs()`); the adapter emits one `prov.input_used` per ref, skipping `source: "artifacts"` (the step's own outputs — mirroring `fillInputHashesFromDisk`'s skip). Paths strip the leading `/{input.resourceId}/` to analysis-relative. `appendInputUsed` records `entity(fileQName({path, hash}), {inflexa:path, inflexa:hash, inflexa:source, inflexa:fileId?})` plus `used(stepQn, entityQn)` under a deterministic relation identifier following change D's endpoint-tuple scheme. Keying by `(path, hash)` in the same QName space as outputs is the load-bearing choice: a `source: "prior"` read of `runs/{priorRun}/{step}/output/x.csv` produces the *same QName* as that file's `prov.file_written` entity, so `unified()` merges them and the derivation chain (prior step → file → this step) falls out with zero cross-run bookkeeping. A ref missing its hash at this point is an invariant violation (`fillInputHashesFromDisk` throws upstream, failing the step before registration) — reported in `failed` like a hash-less artifact, not silently skipped.

Alternative considered — a dedicated `inflexa:used-input-*` QName space: rejected; it would record the same bytes at the same path as two unrelated entities and forfeit the free cross-run chains.

### D4 — Adopt tsprov `formalAttributeConflict: "first"` at the cli's `unified()` call sites

Publish the tsprov release containing #3, bump the cli pin, and pass `{formalAttributeConflict: "first"}` wherever the cli unifies for persistence or export (the flush in `prov.ts`, `serializeProvenance` in `document.ts`; tests that assert merge behavior). "First" matches `occurrenceTime()`'s first-observed semantics, so the two layers agree on which value survives. The default stays `"throw"` upstream — strictness remains correct for single-observation authoring; only the cli's replay-exposed surfaces opt out. With D1's deterministic times the policy should never actually trigger; it exists so that *no future writer defect* can convert a value conflict into permanently unpersistable provenance (the failure mode becomes attribute drift + a log line).

### D5 — `RunProvenanceEvent` reshape is safe; the cli's exhaustive switch enforces the mapping

The type shipped in change D but has never been published (`file:../harness` consumption only) and has exactly one consumer — `createRunProvenanceEmitter`'s `switch` with a `never`-typed default. Adding required `atMs`/`durationMs` fields and the third arm is a compile-enforced migration, not a runtime risk. Emission mechanics are unchanged from change D: plain guarded calls in the body, deliberately NOT step-wrapped (body re-execution must re-fire; idempotency comes from deterministic identifiers and now deterministic times).

## Risks / Trade-offs

- **[More checkpointed steps per run]** One `DBOS.now()` per settlement adds a step-cache row per executed step. → Negligible against the existing per-step step count (each child already checkpoints dozens); accepted.
- **[Settlement emission for canceled steps]** A canceled in-flight child settles through the same loop and emits `status: "canceled"`; a plan step canceled *before dispatch* emits nothing. Consumers must not read "absent step activity" as "step succeeded". → Documented in the spec scenario; the run activity's `partial`/`failed`/`canceled` status is the authoritative summary.
- **[Input entities without producer edges]** A `source: "data"` or cross-analysis input entity has no `wasGeneratedBy` (nothing in this document generated it). → Valid PROV (an entity may exist without a recorded generation); the anchor-entity linking follow-up can enrich later.
- **[Keep-first hides a genuine conflict]** If a defect ever emits truly different times under one QName, "first" silently keeps one. → tsprov logs the drop; the alternative (throw) is strictly worse — it was the permanent-flush-poison failure mode this change retires.
- **[Suspended-run double terminal]** A resumed run's second `run_completed` carries a different `atMs`; keep-first preserves the first end time while the second status accumulates as a multi-valued extra attribute. → Same acceptance as change D, now with a defined merge outcome instead of a throw.

## Migration Plan

Single PR per repo boundary: tsprov release first (no code change — tag/publish the merged #3), then the cli+harness PR (types → harness emission → builders/recorder → bridge → wiring → tests). No data migration: existing documents remain valid; new records simply carry richer times. Rollback: revert the cli+harness PR; the tsprov bump is inert without callers passing the option.

## Open Questions

None — the four scope decisions were made by the user (2026-07-06); sequencing after `bridge-harness-provenance`'s archive is recorded in the proposal.
