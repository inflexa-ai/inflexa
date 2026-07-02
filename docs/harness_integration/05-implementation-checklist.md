# Implementation Checklist: Harness Integration PR

## Status: Active — Postgres Resolved, Ready to Implement

> **Postgres resolved (2026-07-01):** PR [inflexa-ai/inf-cli#20](https://github.com/inflexa-ai/inf-cli/pull/20)
> provisions `pgvector/pgvector:pg18` via Docker Compose alongside CLIProxyAPI. Phase 3's
> `assembleCoreRuntime()` approach works as-is — the CLI has a real Postgres with pgvector
> and multi-connection support. All five phases are unblocked.

## Phase 1: Fix the Stash (CLI-side, ~30min)

The stash `stash@{0}: On feat/provenance: lmao` has 5 misalignments with actual harness code. Fix before applying.

### 1.1 Fix `ProvRunOutcome.status` — expand to match harness

**File:** `src/types/prov.ts` (stash addition)

```diff
- status: "completed" | "failed" | "canceled";
+ status: "completed" | "partial" | "failed" | "canceled" | "suspended_insufficient_funds";
```

**Evidence:** Harness `RunStatus` at `harness/src/state/schema.ts:46` has 6 values. Omit `"running"` since it wouldn't appear in a `prov.run_completed` event.

### 1.2 Fix `ProvStepRef` — remove per-file fields

**File:** `src/types/prov.ts` (stash addition)

```diff
  type ProvStepRef = {
      runId: string;
      stepId: string;
-     command?: string;
-     exitCode?: number;
      durationMs?: number;
  };
```

**Evidence:** Command and exitCode are per-output-file metadata in `ProvenanceCollector.recordCommandExecution()` at `harness/src/provenance/collector.ts:284-326`. A step runs many commands. Per-command data flows through `prov.file_written` events.

### 1.3 Fix `ProvFileRef.producer` — carry rich metadata or accept loss

**File:** `src/types/prov.ts` (stash addition)

Option A (accept data loss — simpler, recommended for now):
```typescript
// Keep as-is: producer: "command" | "file_tool"
// Document: per-file command metadata stays harness-internal
```

Option B (carry metadata):
```diff
- producer: "command" | "file_tool";
+ producer:
+     | { type: "command"; command: string; exitCode: number; durationMs: number }
+     | { type: "file_tool"; tool: string };
```

**Decision needed from user.** Option A is simpler and sufficient for W3C PROV (the `producer` discriminant maps to `inflexa:producer` attribute). Option B preserves the harness's full producer metadata in the PROV document.

### 1.4 Fix `ProvRunRef.goal` — rename to match harness vocabulary

**File:** `src/types/prov.ts` (stash addition)

```diff
  type ProvRunRef = {
      runId: string;
-     goal?: string;
+     planSummary?: string;
  };
```

**Also update:** `appendRunStarted()` in `src/modules/prov/document.ts` and the test in `prov.test.ts`.

**Evidence:** Harness `ExecuteAnalysisInput.planSummary` at `execute-analysis.ts:96`.

### 1.5 Fix `appendFileWritten` — handle path format

**File:** `src/modules/prov/document.ts` (stash addition)

The `BusProvenanceAdapter` (see Phase 2) must prepend `runs/{runId}/{stepId}/` to the harness's step-relative `outputPath` before emitting the event. No change needed in `appendFileWritten` itself — the path arrives already in analysis-relative form in the bus event.

### 1.6 Apply the stash

```bash
git stash pop
# Fix the issues above
bun test  # in cli/ — verify all prov tests pass
```

## Phase 2: Create the BusProvenanceAdapter (CLI-side, ~1hr)

### 2.1 New file: adapter

**File:** `cli/src/modules/prov/bus-provenance-adapter.ts` (new)

Implements `ArtifactRegistry` from `@inflexa-ai/harness`. Translates `ProvenanceCollector` records to `prov.*` bus events. Lives in CLI because it depends on `Bus`.

Key responsibilities:
- `register()`: iterate `collector.getRecords()`, emit `prov.file_written` per output file, then emit `prov.step_completed`
- `sync()`: no-op (files already local)
- Prepend `runs/{runId}/{stepId}/` to step-relative paths from collector records

### 2.2 Export from prov barrel

Add `createBusProvenanceAdapter` to `cli/src/modules/prov/` exports.

## Phase 3: Wire the Composition Root (CLI-side, ~2hr)

### 3.1 Add `@inflexa-ai/harness` as CLI dependency

**File:** `cli/package.json`

```json
"@inflexa-ai/harness": "file:../harness"
```

### 3.2 Build the CLI composition root

**File:** `cli/src/harness/compose.ts` (new)

Calls `assembleCoreRuntime()` from `@inflexa-ai/harness`, wiring:
- `artifactRegistry` → `createBusProvenanceAdapter({ emit: Bus.emit, actor: systemActor })`
- `emitProvenance` → `(event) => Bus.emit("inflexa", event)` (for run lifecycle)
- All other seams → OSS defaults from harness barrel exports

### 3.3 Wire staging → data-profile trigger

**File:** `cli/src/modules/analysis/launch.ts` (modify)

```typescript
// 1. Stage inputs
const dataDir = dataInputsDir(analysis);
const manifest = await stageInputs(analysis.id, dataDir);

// 2. Trigger data profiling
const triggerResult = await triggerDataProfile(triggerDeps, {
    auth: makeLocalAuth(),
    analysisId: analysis.id,
    stagedInputs: manifest,
});
```

**Evidence:** `triggerDataProfile` at `data-profile.ts:457` expects `DataProfileTriggerParams { auth, analysisId, stagedInputs }`. The CLI's `stageInputs()` at `src/modules/staging/staging.ts:130` returns `StagedInput[]` — wire-compatible.

### 3.4 Add `emitProvenance` to `ExecuteAnalysisDeps`

**File:** `harness/src/workflows/execute-analysis.ts` (modify)

```typescript
// Add to ExecuteAnalysisDeps:
readonly emitProvenance?: (event: unknown) => void;
```

Then emit at run boundaries:
```typescript
// After line 328 (data-run-started):
deps.emitProvenance?.({ type: "prov.run_started", analysisId, actor: { kind: "system" }, run: { runId, planSummary: input.planSummary } });

// In collectAndComplete, after line 778/796 (data-run-completed/failed):
deps.emitProvenance?.({ type: "prov.run_completed", analysisId, actor: { kind: "system" }, outcome: { runId, status, durationMs: /* compute */ } });
```

## Phase 4: DBOS Durability Considerations

### Bus.emit is safe inside DBOS workflows

`Bus.emit` is a synchronous in-memory event dispatch. It does NOT need DBOS durability because:

1. The provenance recorder (`prov.ts::onEvent()`) runs in the same process
2. It accumulates in-memory, then flushes to CLI's SQLite DB
3. If the process crashes mid-workflow: DBOS recovery replays the workflow steps from its step cache. The replayed steps re-trigger the injected `emitProvenance` callback, which re-emits bus events. The CLI's provenance recorder re-processes them (tsprov's `unified()` deduplicates by QName).
4. The `emitProvenance` callback runs OUTSIDE DBOS step boundaries (alongside `emitStreamPart`), so it's not cached — this is correct because provenance events are idempotent via QName-based dedup.

### No DBOS changes needed

The provenance callbacks are fire-and-forget side effects alongside the existing `emitStreamPart` calls. DBOS doesn't need to know about them.

## Phase 5: Test & Cleanup

### 5.1 Round-trip test

Verify: stage inputs → trigger data-profile → harness runs → `prov.file_written` events flow → tsprov document contains file entities → document is signed.

The stash already has a test (`prov.test.ts:356-442`) that exercises the bus→flush→deserialize path. Extend it to cover the `BusProvenanceAdapter` → bus → recorder → DB round-trip.

### 5.2 Remove dead code

- Delete `harness/src/execution/filesystem-artifact-registry.ts` (140 lines)
- Delete `harness/src/execution/filesystem-artifact-registry.test.ts`
- Remove `createFilesystemArtifactRegistry` and `FilesystemArtifactRegistryDeps` from `harness/src/index.ts`

### 5.3 Remove `provenance-index.json` references

Grep for `provenance-index` across the harness and remove all references.

## Dependency Order

```
Phase 1 (fix stash)
  ↓
Phase 2 (BusProvenanceAdapter)
  ↓
Phase 3.1-3.2 (harness dep + composition root)
  ↓
Phase 3.3 (staging → trigger wiring)
  ↓ in parallel with:
Phase 3.4 (emitProvenance in execute-analysis)
  ↓
Phase 4 (no action — analysis only)
  ↓
Phase 5 (test + cleanup)
```

## Estimated Effort

| Phase | Effort | Risk |
|-------|--------|------|
| Fix stash | 30min | Low — mechanical type fixes |
| BusProvenanceAdapter | 1hr | Medium — need to map collector records to bus events correctly |
| Composition root | 2hr | High — first CLI↔harness wiring, many construction-time deps to resolve |
| emitProvenance | 30min | Low — add optional callback, emit alongside existing stream events |
| Test & cleanup | 1hr | Low — extend existing test, delete dead code |
| **Total** | **~5hr** | |

## 6. Postgres/DBOS — RESOLVED

> **Resolved (2026-07-01):** PR [inflexa-ai/inf-cli#20](https://github.com/inflexa-ai/inf-cli/pull/20) provisions
> Postgres via Docker Compose. The CLI already hard-requires Docker/Podman, so adding a
> `pgvector/pgvector:pg18` container alongside the proxy costs nothing. Phase 3's
> `assembleCoreRuntime()` call gets a real Postgres connection string from the provisioned container.
>
> See `07-postgres-dbos-constraint.md` for the constraint analysis (why Postgres is needed).
> See `cli/openspec/specs/postgres-provisioning/spec.md` for the authoritative provisioning spec.
