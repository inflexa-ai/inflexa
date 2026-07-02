# Prior Work Inventory: Stash & Staging Module

## 1. Git Stash: `stash@{0}: On feat/provenance: lmao`

### What It Contains

The stash extends the CLI's provenance system from analysis-level tracking (create/add-input/remove-input) to execution-level tracking (runs, steps, file writes). It bridges the gap between "what inputs does this analysis use?" and "what did the harness actually produce?"

### New Event Types (`src/types/events.ts` additions)

```
prov.run_started    → ProvRunRef     { runId, goal? }
prov.run_completed  → ProvRunOutcome { runId, status: "completed"|"failed"|"canceled", durationMs? }
prov.step_completed → ProvStepRef    { runId, stepId, command?, exitCode?, durationMs? }
prov.file_written   → ProvFileRef    { path, hash, size, producer: "command"|"file_tool" }
```

### New Domain Types (`src/types/prov.ts` additions)

- `ProvRunRef` — workflow run linked to analysis lifecycle
- `ProvRunOutcome` — run completion with status and duration
- `ProvStepRef` — step execution metadata (command, exit code, duration)
- `ProvFileRef` — file write record with SHA-256 hash for dedup

### New Document Builders (`src/modules/prov/document.ts` additions)

| Function | PROV Activity Type | Records Created |
|----------|-------------------|----------------|
| `appendRunStarted()` | `inflexa:StartRun` | Run activity, goal attribute, linked to analysis |
| `appendRunCompleted()` | `inflexa:CompleteRun` | Status + endTime on run activity |
| `appendStepCompleted()` | `inflexa:CompleteStep` | Step entity, generatedBy run, derivedFrom analysis |
| `appendFileWritten()` | `inflexa:WriteFile` | File entity, generatedBy step, derivedFrom analysis |

**QName patterns:**
```
inflexa:run-{runId}
inflexa:step-{runId}-{stepId}
inflexa:file-{Bun.hash(path|hash).toString(36)}   ← content-hash dedup
```

### Event Recording (`src/modules/prov/prov.ts` additions)

Four new cases in `onEvent()` that append to the live document and schedule flush. Mirrors the existing append pattern: locate doc → append → mark dirty → schedule flush.

### Path Construction (`src/modules/analysis/output.ts` additions)

```typescript
sessionTreeRoot(analysis)     → base path harness receives as sessionPath
dataInputsDir(analysis)       → "{sessionTreeRoot}/data/inputs/"
runStepDir(runId, stepId)     → "runs/{runId}/{stepId}" (relative to session tree)
```

### Bus Logging (`src/lib/bus.ts` additions)

Extends `eventFields()` to extract telemetry for the 4 new event types (includes runId, stepId, filePath, producer fields).

### Tests (`src/modules/prov/prov.test.ts` additions)

Complete round-trip test: emit run/step/file events → flush → deserialize → verify PROV document contains all records.

### Assessment

**This stash is the linchpin of the integration.** It defines exactly how harness execution data enters the CLI's tsprov pipeline. The implementation is complete and tested. It should be applied and then wired to the harness via the `BusProvenanceAdapter` described in `01-provenance-migration.md`.

## 2. Staging Module: `src/modules/staging/staging.ts`

### What It Contains

A complete file materialization module that stages analysis inputs to disk before harness invocation.

### Core Type

```typescript
type StagedInput = {
    fileId: string;           // Bun.hash(anchorId|path).toString(36) — deterministic
    mountName: string;        // Always "local" (CLI files, single flat mount)
    key: string;              // Relative path within mount
    fileName: string;         // Basename
    hash: string;             // SHA-256 hex
    size: number;             // Bytes
    relativePath: string;     // "inputs/local/{key}" relative to data dir
}
```

### Key Functions

| Function | Purpose |
|----------|---------|
| `stageInputs(analysis, dataDir)` | Main entry: resolve inputs → stage each → return manifest |
| `stageSingleFile(path, anchorId, dataDir)` | Hash + hardlink/copy + return StagedInput |
| `stageFile(src, dest)` | Hardlink with cross-filesystem copy fallback |
| `walkFiles(dir)` | Recursive directory traversal (follows symlinks) |
| `deriveFileId(input, subpath?)` | Deterministic `Bun.hash(anchorId\|path)` |

### Error Handling

Best-effort staging — orphaned anchors are skipped with warnings; partial staging is preferred over total failure. Follows neverthrow-first policy (returns `Result<T, E>`).

### Wire Compatibility

The `StagedInput` shape is identical to the harness's `StagedInput` interface at `harness/src/execution/staged-input.ts`. The CLI can pass its manifest directly to the harness trigger with no transformation.

### Tests (`staging.test.ts`)

- Single file staging with hash verification
- Directory tree staging with subpath resolution
- Distinct fileIds for multiple inputs
- Empty manifest handling
- Orphaned anchor graceful skip
- Content integrity verification

### Assessment

**This module is ready to wire.** It exists in the working tree (not stashed), has tests, and produces output wire-compatible with the harness's `StagedInput` contract.

## 3. Current CLI Provenance (not stashed — HEAD)

For reference, the committed CLI provenance handles only 3 event types:

| File | Events |
|------|--------|
| `cli/src/types/events.ts` | `prov.analysis_created`, `prov.input_added`, `prov.input_removed` |
| `cli/src/types/prov.ts` | `ProvActorKind`, `ProvActor`, `ProvInputRef`, `VerifyResult` |
| `cli/src/modules/prov/document.ts` | `freshDocument()`, `loadDocument()`, `appendAgent()`, `appendInput()`, `startAction()` |

The stash extends this with the 4 execution-level events.

## 4. What to Do Next

### Immediate (apply existing work)

1. **Apply the stash:** `git stash pop` to bring execution-level provenance into the working tree
2. **Verify tests pass:** Run `bun test` in `cli/` to confirm the stash applies cleanly
3. **Wire staging to launch:** Connect `stageInputs()` to the analysis launch path (likely in `cli/src/modules/analysis/launch.ts`)

### Short-term (build the bridge)

4. **Create BusProvenanceAdapter:** New `ArtifactRegistry` implementation in harness that emits bus events instead of writing `provenance-index.json`
5. **Thread the Bus:** CLI passes its `Bus` instance to the harness at composition time (the harness should accept a bus/event-emitter in its configuration)
6. **Integration test:** End-to-end: stage inputs → harness runs → events flow → tsprov document contains run/step/file records → document is signed

### Later (cleanup)

7. **Remove FilesystemArtifactRegistry:** Once bus events are the single provenance channel
8. **Remove provenance-index.json:** Dead format after migration
9. **Consider: per-command lineage in tsprov:** Whether to emit `wasDerivedFrom(output, input)` edges at command granularity or collapse to step level
