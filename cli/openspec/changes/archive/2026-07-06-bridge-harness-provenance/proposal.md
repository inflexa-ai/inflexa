# bridge-harness-provenance

## Why

`inflexa run` executes real analyses whose outputs land on disk and in the local `cortex_artifacts` ledger with **zero external provenance** — the cli's `ArtifactRegistry` realization is a deliberate no-op stub (`src/modules/harness/run_deps.ts:75`), and no run/step/file events exist in the cli's provenance vocabulary. The product's core promise is a signed, verifiable provenance document per analysis; today that document records inputs being added but goes silent at the exact moment the most important thing happens — an actual run producing results. Both walking skeletons (embed-harness-runtime, embed-execute-analysis) are archived, so the seam sites this change hangs on are live, observed code, and the design-complete blueprint (the `feat/provenance` stash + `docs/harness_integration-new/03-provenance-migration-plan.md`) has been verified against the current tree.

This is change D of the harness-integration change graph (`docs/harness_integration-new/06-change-graph.md`) with change B (port-prov-run-events) folded in as its first slice — mirroring how change A folded into C.

## What Changes

- **Port the execution-level provenance vocabulary into the cli** (from `stash@{0}` — port by hand, do not pop): four bus events (`prov.run_started`, `prov.run_completed`, `prov.step_completed`, `prov.file_written`), four domain types (`ProvRunRef`, `ProvRunOutcome`, `ProvStepRef`, `ProvFileRef`), four tsprov document builders, four recorder cases in `modules/prov/prov.ts`, bus telemetry fields, and tests — applying the seven schema fixes from the migration plan §4 (deterministic QNames replacing orphan `startAction` UUIDs, run activity/entity double-use resolved, status widened to the harness's terminal vocabulary, `goal` → `planSummary`, per-step `command`/`exitCode` dropped, system actor kind, PROV-validity corrections to the stash's record model).
- **Replace the stub `ArtifactRegistry` with a bus-adapter registry**: `register()` translates one step's reconciled artifacts into `prov.file_written` × N + `prov.step_completed` × 1 bus events; `sync()` stays a local no-op; the adapter never touches `cortex_artifacts` (the seam contract), complying by construction since it only emits events.
- **Additive harness change — run-lifecycle provenance dep**: `ExecuteAnalysisDeps` gains an optional `emitProvenance?: (event: RunProvenanceEvent) => void` fired at the three existing run-boundary sites in `execute-analysis.ts` (run-started, run-completed, run-failed). The harness stays tsprov-free and Bus-free: `RunProvenanceEvent` is a harness-owned plain union carrying execution facts only. Chosen over cli-side emission because Ctrl+C detach (`run.ts:460-465`) would orphan the completion event, while in-workflow emission rides DBOS recovery and deterministic QNames make replay idempotent.
- **Wire both in the cli composition root**: the adapter replaces the stub in `buildSandboxStepDeps`; the cli realizes `emitProvenance` by mapping harness facts to `prov.run_started`/`prov.run_completed` bus events stamped with the system actor.
- **End-to-end verification**: stage → run → sandbox frames → collector → adapter → bus → recorder → signed document; `inflexa prov verify` passes and the PROV-N export shows `inflexa:Run`/`inflexa:Step`/`inflexa:File`.

**Out of scope** (deliberately): change E (deleting `FilesystemArtifactRegistry` and other GOES items — sequenced after this lands as the fallback), lineage for data-profile/ephemeral runs (registry seam is executeAnalysis-only; coverage hole stays documented), rich `Producer` objects on `ProvFileRef` (bare discriminant now; rich is additive later), the `ProvenanceFrame.deletes` wire arm (stays reserved), per-input `used()` lineage edges (coarse-grained cutover per the old Q2 decision).

## Capabilities

### New Capabilities

- `prov-run-events`: the execution-level provenance event vocabulary — the four `prov.run_*`/`prov.step_*`/`prov.file_*` bus events, their domain types, the deterministic-QName document builders, recorder integration, and replay idempotency.
- `prov-harness-bridge`: the two bridge realizations that connect the harness's execution machinery to the cli's provenance events — the bus-adapter `ArtifactRegistry` (step/file events) and the `emitProvenance` run-lifecycle mapping (run boundary events), including the harness-side optional dep contract.

### Modified Capabilities

- `harness-runtime`: the run-engine dep composition requirement changes — the artifact registry is no longer a no-op stub carrying a `TODO(extend)`; it SHALL be the bus-adapter registry, and `ExecuteAnalysisDeps` wiring SHALL realize `emitProvenance`.

## Impact

- **cli**: `src/types/prov.ts` + `src/types/events.ts` (vocabulary), `src/lib/bus.ts` (telemetry fields), `src/modules/prov/document.ts` + `src/modules/prov/prov.ts` (builders + recorder), new `src/modules/harness/prov_bridge.ts` (adapter + lifecycle mapping), `src/modules/harness/run_deps.ts` (stub replaced), `src/modules/harness/runtime.ts` (wiring), tests throughout.
- **harness** (additive only): `src/workflows/execute-analysis.ts` (`emitProvenance` dep + three call sites), barrel exports for the types the cli adapter needs (`ArtifactRegistrationInput`, `ExternalRegistrationResult`, `RunProvenanceEvent`, and the `ProvenanceCollector`/`ArtifactManifestEntry` types if not already exported).
- **Constraints honored**: events keyed by `analysisId` are silently dropped for unknown rows (`prov.ts` recorder) — harness `resourceId` must equal the cli `analysisId`, guaranteed by the trigger contract; provenance is never degraded to unsigned (prov-must-sign policy — signing failure crashes the flush, unchanged by this change); no new dependencies.
