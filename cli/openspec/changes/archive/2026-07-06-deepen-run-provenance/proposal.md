# deepen-run-provenance

> **Sequencing**: builds on `bridge-harness-provenance` (change D) and MUST land after it archives — the `prov-run-events` and `prov-harness-bridge` capabilities this change modifies sync into `openspec/specs/` at that archive. Every seam fact below was verified against the change-D working tree (2026-07-06).

## Why

Change D made `inflexa run` produce a signed provenance document, but three of its accepted cuts leave the document less than the product promise: recorded times are cli *receipt* times (a run first observed on a late recovery boot gets hours-wrong timestamps), steps are visible only when they registered artifacts (a zero-artifact or failed step leaves no trace — `register()` is skipped entirely when the reconciled manifest is empty, `harness/src/execution/post-step-pipeline.ts:148`), and the step's content-attested input reads (`collector.getTrackedInputs()`, hashed fail-fast from disk) are dropped at the bridge — the signed document cannot answer "what did this run actually read". Meanwhile the tsprov hardening change D filed (inflexa-ai/tsprov#3, the `formalAttributeConflict` merge policy) has merged upstream but is unreleased and unadopted, so a formal-time conflict reaching `unified()` still permanently poisons an analysis's flush. All four were settled as user decisions on 2026-07-06.

## What Changes

- **Replay-stable, truthful timestamps from the harness**: `RunProvenanceEvent` arms gain epoch-ms times sourced from `DBOS.now()` (a checkpointed step — the body already uses it, `harness/src/workflows/sandbox-step.ts:770` — so re-executed bodies re-emit identical values). Run start/end become true workflow times instead of first-observed cli receipt times, and run `durationMs` becomes deterministic (terminal − start). The cli's `occurrenceTime()` guard stays as a safety net but stops being the source of truth. **BREAKING** for the `RunProvenanceEvent` type shape (pre-release type, no consumer outside this repo; the cli's exhaustive mapping switch forces the update).
- **Step events move from the artifact-registration seam to the parent scheduler's settlement site** (`harness/src/workflows/execute-analysis.ts:644-699`, beside the `stepRuntime.set` branches): a new `step_completed` arm carries the step's terminal status (`completed | failed | canceled`) and the child's durable `durationMs`. Zero-artifact and failed steps become visible in the signed document; the bus-adapter registry stops emitting `prov.step_completed`. `ProvStepRef` slims to the pure reference `{runId, stepId}`; the settlement facts move to a new `ProvStepOutcome` (mirroring the run's ref/outcome pair). Never-dispatched steps (dependents of a failed step) emit nothing by design — they never executed; the run status carries that outcome.
- **Input lineage**: the bus-adapter registry emits a new `prov.input_used` event per tracked input ref (skipping `source: "artifacts"` — the step's own outputs, mirroring the reconcile skip at `reconcile-manifest.ts:128`), with the container-absolute `ref.path` (`/{resourceId}/…`) stripped to analysis-relative. A new `appendInputUsed` builder records the input as an entity keyed in the same `(path, hash)` file-QName space as outputs plus a deterministically-identified `used(stepQn, entityQn)` edge — so a step reading a prior step's output resolves to the *same entity* that step generated, and cross-step lineage chains merge with no extra modeling. Linking `data/` input entities to the anchor-keyed `inflexa:input-*` entities from `prov.input_added` stays an explicit additive follow-up.
- **tsprov conflict-policy adoption**: publish the tsprov release containing #3 (`FormalAttributeConflictPolicy`), bump the cli's pinned `@inflexa-ai/tsprov`, and pass `formalAttributeConflict: "first"` at the cli's `unified()` call sites (flush + export) — a formal-attribute conflict then degrades to keep-first-and-log instead of permanently unfushable provenance.
- **Documented acceptances + upstream filing**: record in the spec that abnormal terminations (a throw inside the scheduler loop; a watchdog-marked wedged run) emit no `run_completed` — the run activity stays open, mirroring the ledger's own gap; file the upstream harness quirk that `output/summary.md` is written after the manifest walk (`sandbox-step.ts:696` vs `:720-727`) and is therefore registered neither in provenance nor `cortex_artifacts` (fix belongs in the harness pipeline, out of this change's scope).

## Capabilities

### New Capabilities

*(none — all changes extend the two capabilities change D introduced plus its harness-runtime modification)*

### Modified Capabilities

- `prov-run-events`: event/type shapes change (timestamps on run ref/outcome, `ProvStepOutcome`, new `prov.input_used`), builders take times from event payloads instead of the append-time clock, the replay-idempotency requirement extends to the flush surviving conflicting formal attributes (keep-first policy), and step visibility becomes every-executed-step rather than every-registered-step.
- `prov-harness-bridge`: the harness callback contract gains the `step_completed` arm + settlement-site emission and epoch-ms times; the adapter requirement changes from "step + file events" to "file + input-used events" (step events leave the registry).
- `harness-runtime`: the composition requirement updates — `emitProvenance` realization maps three arms; the artifact registry emits file/input events only.

## Impact

- **cli**: `src/types/prov.ts` (`ProvRunRef`/`ProvRunOutcome` gain times; `ProvStepRef` slims; new `ProvStepOutcome`, `ProvUsedInputRef`), `src/types/events.ts` + `src/lib/bus.ts` (reshaped `prov.step_completed`, new `prov.input_used`), `src/modules/prov/document.ts` (builders take event times; new `appendInputUsed`; `occurrenceTime()` demoted to safety net), `src/modules/prov/prov.ts` (recorder case), `src/modules/harness/prov_bridge.ts` (drop step emission, add input emission, map the new arm), tests throughout, `package.json` (tsprov bump).
- **harness**: `src/workflows/execute-analysis.ts` only — `RunProvenanceEvent` reshape, two `DBOS.now()` reads (start + terminal), settlement-site emissions (guarded, plain calls, NOT step-wrapped — same replay rationale as change D). No new seams, no barrel growth beyond the reshaped type.
- **tsprov** (`~/repos/inflexa/tsprov`): no code change needed (#3 merged); needs a version released and consumed.
- **Constraints honored**: harness stays tsprov-free and Bus-free; prov-must-sign unchanged (signing failure still crashes the flush — the keep-first policy addresses *merge* conflicts, not signing); events keyed by `analysisId` with silent drop for unknown rows, unchanged.
