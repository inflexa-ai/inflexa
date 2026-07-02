# Provenance Migration: Harness Custom → tsprov (W3C PROV)

## Status: Research Complete — Design Phase

## 1. Current State: Two Independent Provenance Systems

### CLI Provenance (tsprov — the target model)

**Location:** `cli/src/modules/prov/`

The CLI uses `@inflexa-ai/tsprov` (v0.2.0) to build W3C PROV documents. All tsprov usage is confined to `cli/src/modules/prov/document.ts`.

**What it tracks today (committed HEAD):**

| Event | Entity | Activity | Agent |
|-------|--------|----------|-------|
| `prov.analysis_created` | Analysis (name, slug) | `CreateAnalysis` | User/Anonymous/System |
| `prov.input_added` | Input (path, isDir) | `AddInput` | User/System |
| `prov.input_removed` | Input (invalidated) | `RemoveInput` | User/System |

**What the stash adds (4 new events):**

| Event | Payload type | Activity type |
|-------|-------------|---------------|
| `prov.run_started` | `ProvRunRef { runId, goal? }` | `inflexa:StartRun` |
| `prov.run_completed` | `ProvRunOutcome { runId, status, durationMs? }` | `inflexa:CompleteRun` |
| `prov.step_completed` | `ProvStepRef { runId, stepId, command?, exitCode?, durationMs? }` | `inflexa:CompleteStep` |
| `prov.file_written` | `ProvFileRef { path, hash, size, producer }` | `inflexa:WriteFile` |

**Data flow:**
```
analysis.ts emits event → Bus → prov.ts::onEvent() → document.ts appends PROV records
  → async flush → serialize(unified()) → SHA-256 chain hash → Ed25519 sign
  → DB: analyses.provenance + chain_hash + signature columns
```

**Key API surface (tsprov):**
- `new ProvDocument()`, `doc.addNamespace(prefix, uri)`
- `doc.entity(qname, attrs)`, `doc.agent(qname, attrs)`, `doc.activity(qname, start, end, attrs)`
- `doc.used()`, `doc.wasGeneratedBy()`, `doc.wasAssociatedWith()`, `doc.wasAttributedTo()`, `doc.wasDerivedFrom()`, `doc.wasInvalidatedBy()`
- `doc.unified().serialize("json")` → PROV-JSON string
- `ProvDocument.deserialize(json, "json")` → round-trip

**Signing & integrity:**
- Ed25519 keypair at `$INFLEXA_CONFIG_DIR/inflexa/prov_key.json`
- Chain hash: `SHA-256(prevChainHash || provJsonBytes)`
- Export: `.sig.json` sidecar with public key + payload digest + signature
- Spec: prov-must-sign memory — never degrade to unsigned; crash on signing failure

**QName scheme:**
```
inflexa:analysis-{id}
inflexa:input-{Bun.hash(anchorId|path).toString(36)}
inflexa:run-{runId}                                    ← stash adds
inflexa:step-{runId}-{stepId}                          ← stash adds
inflexa:file-{Bun.hash(path|hash).toString(36)}        ← stash adds
inflexa:agent-user-{email}  |  inflexa:agent-anonymous  |  inflexa:agent-system
```

### Harness Provenance (custom — to be migrated)

**Location:** `harness/src/provenance/`, `harness/src/execution/`, `images/sandbox-base/`

The harness implements per-command file lineage tracking via sandbox hooks. It has NO dependency on tsprov and uses custom TypeScript types.

**What it tracks:**

| Layer | Mechanism | What it captures |
|-------|-----------|-----------------|
| Python | `sys.addaudithook()` (PEP 578) via `sitecustomize.py` | `open()` reads/writes, `os.remove()` |
| C | `LD_PRELOAD` `provtrack.so` | `open()/fopen()/unlink()` at libc level |
| R | `trace()`/`setHook()` via `Rprofile.site` | `read.csv/writeLines/save/load` |
| Filesystem | Go inotify watcher | `IN_OPEN/IN_CREATE/IN_DELETE/IN_MOVED_*` |

**Data flow:**
```
Sandbox hooks → JSON datagrams → sandbox-server socket/R-log
  → ProvenanceTracker.Stop() → merged ProvenanceFrame {reads, writes, deletes}
  → ExecResult.provenance → feedExecFrame() → ProvenanceCollector
  → reconcileManifestWithDisk() (content-attest, fill hashes)
  → ArtifactRegistry.register() → provenance-index.json (OSS)
```

**Key types (verified from `harness/src/provenance/types.ts`):**

```typescript
// types.ts:60-78
ProvenanceRecord {
    outputPath: string;       // path relative to /artifacts
    outputHash: string;       // SHA-256
    outputSize: number;
    producer: Producer;       // { type: "command", command, args, exitCode, durationMs, timestamp }
                             //   | { type: "file_tool", tool, timestamp }
    inputs: InputRef[];       // lineage chain
    scriptPath: string | null;
    stepId: string;
    runId: string;
}

// types.ts:41-55
InputRef {
    path: string;             // mount-relative path
    hash: string;             // SHA-256 at read time
    source: InputSource;      // "data" | "upstream" | "prior" | "artifacts"
    stepId?: string;          // step that produced this input
    runId?: string;           // run that produced this input
    fileId?: string;          // S3 identity for data inputs
}
```

**Content attestation:** All input hashes are verified from disk at reconcile time. Missing or unreadable inputs fail the step (fail-fast, not silent degradation).

## 2. What Has to Go

### Remove: Custom provenance serialization format

The `FilesystemArtifactRegistry` (`harness/src/execution/filesystem-artifact-registry.ts`) writes `provenance-index.json` — a custom JSON format with `artifacts`, `inputs`, and `lineage` arrays. This is NOT W3C PROV and cannot be verified by standard PROV tools.

**Exact code being replaced** (`filesystem-artifact-registry.ts:83-139`):
```typescript
// createFilesystemArtifactRegistry() writes per-step provenance-index.json
// with FilesystemProvenanceIndex { resourceId, runId, stepId, artifacts, inputs, lineage }
// The lineage records are FilesystemLineageRecord { outputPath, outputHash, producer, scriptPath, inputs }
```

**Replacement:** A bus-event adapter that translates collector records to `prov.*` events consumed by the CLI's tsprov recorder.

### Keep but reframe: Internal transport types

The `ProvenanceRecord` and `InputRef` types in `harness/src/provenance/types.ts` are a custom schema. They stay as internal transport within the harness (the collector needs them), but their serialization path changes from `provenance-index.json` to bus events.

## 3. What Has to Stay

### Keep: Sandbox provenance hooks (Python/C/R/inotify)

These hooks collect fine-grained file I/O that tsprov cannot replicate — they observe what a Python script actually reads at the libc level. The hooks are the _source data_; tsprov is the _serialization format_. These are orthogonal.

**Files that stay unchanged:**
- `images/sandbox-base/provenance/sitecustomize.py` — Python audit hook
- `images/sandbox-base/provenance/provtrack.c` — C LD_PRELOAD interceptor
- `images/sandbox-base/provenance/Rprofile.site` — R trace hooks
- `images/sandbox-base/server/provenance.go` — Go frame aggregator
- `images/sandbox-base/server/provenance_inotify_linux.go` — inotify watcher

### Keep: ProvenanceCollector (internal accumulator)

The `ProvenanceCollector` class (`harness/src/provenance/collector.ts:171-405`) is the step-scoped accumulator. Key methods:

```typescript
// collector.ts:218 — record a file read from sandbox
trackInputAccess(mountPath, relativePath, hash, context?): InputRef

// collector.ts:252 — record agent write_file/edit_file
recordFileToolWrite(artifact: ArtifactRecord): void

// collector.ts:284 — record sandbox command execution with per-command input scoping
recordCommandExecution(command, args, exitCode, durationMs, writes, scriptPath?, commandReads?): void

// collector.ts:374 — merged deduplicated records (command wins over file-tool for same path)
getRecords(): ProvenanceRecord[]

// collector.ts:331 — inputs classified as data source
getDataInputs(): InputRef[]
```

**Files that stay:**
- `harness/src/provenance/collector.ts`
- `harness/src/provenance/exec-frame.ts` — translates sandbox frames via `feedExecFrame()` (`exec-frame.ts:44-70`)
- `harness/src/provenance/types.ts` — internal transport types

### Keep: Reconciliation pipeline

`reconcileManifestWithDisk()` content-attests all lineage edges. Critical for integrity — feeds into the signed tsprov document.

**Files that stay:**
- `harness/src/execution/reconcile-manifest.ts`
- `harness/src/execution/post-step.ts` (artifact walk)
- `harness/src/execution/post-step-pipeline.ts`

### Keep: ArtifactRegistry seam

The `ArtifactRegistry` interface (`harness/src/execution/artifact-registry.ts:67-81`) is the integration point. The input shape already carries everything needed:

```typescript
// artifact-registry.ts:23-34
interface ArtifactRegistrationInput {
    resourceId: string;
    runId: string;
    stepId: string;
    artifacts: ArtifactManifestEntry[];
    collector: ProvenanceCollector;    // ← carries records + inputs
}
```

The OSS implementation (`FilesystemArtifactRegistry`) changes; the seam stays.

### Keep: Workspace ProvenanceCollector seam

The `ProvenanceCollector` interface in `harness/src/workspace/provenance-collector.ts:34-36` is the harness-side write-tracking seam used by `write_file`/`edit_file` tools:

```typescript
// workspace/provenance-collector.ts:34-36
interface ProvenanceCollector {
    recordSnapshot(snapshot: ProvenanceSnapshot): Promise<void>;
}
```

This is a different type from the step-level `ProvenanceCollector` class — it's the write-side seam for harness-side file mutations.

## 4. How the Harness Communicates Provenance to CLI

### Architecture: Event Bus Bridge

The harness emits provenance events onto the shared `Bus`. The CLI's provenance recorder (already a bus subscriber at `prov.ts::onEvent()`) listens and appends to the tsprov document. **The harness never imports tsprov directly.**

```
HARNESS (no tsprov dependency)              CLI (owns tsprov)
─────────────────────────                   ──────────────────
ProvenanceCollector                         prov.ts::onEvent()
  ↓                                           ↑
ArtifactRegistry.register()                 Bus.on("inflexa", ...)
  ↓                                           ↑
Bus.emit("prov.run_started")    ──────→     appendRunStarted(doc, id, actor, run)
Bus.emit("prov.step_completed") ──────→     appendStepCompleted(doc, id, actor, step)
Bus.emit("prov.file_written")   ──────→     appendFileWritten(doc, id, actor, file, step)
Bus.emit("prov.run_completed")  ──────→     appendRunCompleted(doc, id, actor, outcome)
                                              ↓
                                            serialize → chain hash → sign → DB
```

### Should tsprov be added to the harness?

**No.** The harness should remain tsprov-free. Reasoning:

1. **DI pattern alignment:** The harness communicates through injected callbacks, not shared libraries. Adding tsprov would create a shared-vocabulary dependency between harness and CLI.
2. **Double serialization:** If the harness built PROV documents, it would serialize → emit → CLI deserializes → merges into its own doc → re-serializes → signs. Raw event data avoids this.
3. **Type safety is already covered:** TypeScript discriminated unions on the bus events (`BusEvent` union in `src/types/events.ts`) give compile-time type safety without PROV-specific types.
4. **Confinement principle:** tsprov usage is currently confined to one file (`cli/src/modules/prov/document.ts`). This containment means library faults stay local.
5. **Zero PROV deps today:** The harness has no provenance-format dependencies. Its custom types (`ProvenanceRecord`, `InputRef`) are internal transport — they never need to be W3C PROV-shaped.

### Event Schema (from stash `feat/provenance` — verified from diff)

The stash adds to `src/types/events.ts`:

```typescript
// events.ts — new BusEvent union members (from stash diff)
| { type: "prov.run_started";   analysisId: AnalysisId; actor: ProvActor; run: ProvRunRef }
| { type: "prov.run_completed"; analysisId: AnalysisId; actor: ProvActor; outcome: ProvRunOutcome }
| { type: "prov.step_completed"; analysisId: AnalysisId; actor: ProvActor; step: ProvStepRef }
| { type: "prov.file_written";  analysisId: AnalysisId; actor: ProvActor; file: ProvFileRef; step: ProvStepRef }
```

The stash adds to `src/types/prov.ts`:

```typescript
type ProvRunRef     = { runId: string; goal?: string }
type ProvRunOutcome = { runId: string; status: "completed"|"failed"|"canceled"; durationMs?: number }
type ProvStepRef    = { runId: string; stepId: string; command?: string; exitCode?: number; durationMs?: number }
type ProvFileRef    = { path: string; hash: string; size: number; producer: "command"|"file_tool" }
```

The stash adds document builders to `src/modules/prov/document.ts`:

```typescript
appendRunStarted(doc, analysisId, actor, run: ProvRunRef)        // → activity inflexa:Run, wasGeneratedBy(analysis, run)
appendRunCompleted(doc, analysisId, actor, outcome: ProvRunOutcome) // → entity with status, endedAt on run
appendStepCompleted(doc, analysisId, actor, step: ProvStepRef)   // → entity inflexa:Step, wasGeneratedBy(step, run), wasDerivedFrom(analysis, step)
appendFileWritten(doc, analysisId, actor, file: ProvFileRef, step: ProvStepRef) // → entity inflexa:File, wasGeneratedBy(file, step), wasDerivedFrom(file, analysis)
```

The stash adds 4 new cases to `src/modules/prov/prov.ts::onEvent()` following the existing pattern:
```typescript
case "prov.run_started":    appendRunStarted(doc, id, actor, event.run);
case "prov.run_completed":  appendRunCompleted(doc, id, actor, event.outcome);
case "prov.step_completed": appendStepCompleted(doc, id, actor, event.step);
case "prov.file_written":   appendFileWritten(doc, id, actor, event.file, event.step);
```

### New ArtifactRegistry: BusProvenanceAdapter

Replace `FilesystemArtifactRegistry` with an adapter that translates collector records to bus events. The adapter lives in the harness, emits onto the Bus, and the CLI recorder picks them up.

```typescript
// Proposed: harness/src/execution/bus-provenance-adapter.ts
import type { ArtifactRegistry, ArtifactRegistrationInput, ExternalRegistrationResult } from "./artifact-registry.js";
import type { AgentSession } from "../auth/types.js";
import { Bus } from "path-to-shared-bus"; // injected, not imported

interface BusProvenanceAdapterDeps {
    emit: (channel: string, event: unknown) => void;
    actor: { kind: "system" };
}

function createBusProvenanceAdapter(deps: BusProvenanceAdapterDeps): ArtifactRegistry {
    return {
        async register(input: ArtifactRegistrationInput, _session: AgentSession): Promise<ExternalRegistrationResult> {
            const { resourceId, runId, stepId, collector } = input;
            const actor = deps.actor;

            // Each ProvenanceRecord → prov.file_written event
            for (const record of collector.getRecords()) {
                deps.emit("inflexa", {
                    type: "prov.file_written",
                    analysisId: resourceId,
                    actor,
                    file: {
                        path: record.outputPath,
                        hash: record.outputHash,
                        size: record.outputSize,
                        producer: record.producer.type, // "command" | "file_tool"
                    },
                    step: { runId, stepId },
                });
            }

            // Step completion event
            deps.emit("inflexa", {
                type: "prov.step_completed",
                analysisId: resourceId,
                actor,
                step: {
                    runId,
                    stepId,
                    // Could aggregate: command from last record, exitCode, durationMs
                },
            });

            // No external IDs — the CLI's tsprov document IS the registry
            return { registered: [], failed: [], failedCount: 0 };
        },

        async sync(): Promise<void> {},
    };
}
```

**Threading the Bus:** The harness follows DI at the composition root — the `emit` function is passed as a dep to `createBusProvenanceAdapter()`. The CLI's composition root wires `Bus.emit` there. The harness never imports the Bus module directly.

### Mapping: Harness ProvenanceRecord → tsprov PROV records

| Harness `ProvenanceRecord` field | tsprov PROV record | Notes |
|---|----|---|
| `outputPath` | `entity(fileQName, {"inflexa:path": outputPath})` | File entity |
| `outputHash` | `entity(fileQName, {"inflexa:hash": outputHash})` | Content attestation attribute |
| `outputSize` | `entity(fileQName, {"inflexa:size": outputSize})` | Size attribute |
| `producer.type` | `entity(fileQName, {"inflexa:producer": type})` | "command" or "file_tool" |
| `inputs[].path` | `wasDerivedFrom(fileQName, inputQName)` | Per-file lineage edge (if fine-grained) |
| `scriptPath` | `entity(fileQName, {"inflexa:scriptPath": scriptPath})` | Script provenance |
| `stepId` | `wasGeneratedBy(fileQName, stepQName)` | Step→file generation edge |
| `runId` | `wasGeneratedBy(stepQName, runQName)` | Run→step generation edge |

### Hash Coexistence

The two hash schemes serve different purposes:
- **Harness SHA-256 content hashes** — per-file integrity (does this file match what was produced?)
- **CLI chain hashes** — document integrity (has this PROV document been tampered with?)

They coexist naturally: content hashes become attributes on tsprov entities (`inflexa:hash`), while chain hashes wrap the serialized document.

## 5. Migration Steps

1. **Apply the stash** — `git stash pop` brings the 4 new event types, document builders, bus logging, path helpers, and tests (7 files, +309/-12 lines)
2. **Create `BusProvenanceAdapter`** — new `ArtifactRegistry` impl in harness that translates collector records to bus events (see sketch above)
3. **Wire at composition root** — CLI's `assembleCoreRuntime()` call passes `createBusProvenanceAdapter({ emit: Bus.emit, actor: systemActor })` instead of `createFilesystemArtifactRegistry({ sessionPath })`
4. **Thread run lifecycle events** — The harness workflow bodies (`execute-analysis.ts`, `sandbox-step.ts`) emit `prov.run_started` at run init and `prov.run_completed` at completion. These are NOT per-step — they bracket the whole run.
5. **Test round-trip** — The stash already has tests (`prov.test.ts:356-442`): emit events → flush → deserialize → verify PROV-N output contains expected QNames
6. **Remove dead code** — Delete `FilesystemArtifactRegistry` and the `FilesystemProvenanceIndex` types once bus events are the single provenance channel

### Stash Groundedness Assessment

**The stash's event types are partially grounded but have significant misalignments with the actual harness.** The stash was written with assumptions about the harness's data model that don't hold. Before applying, the following must be fixed:

#### Mismatch 1: `ProvRunOutcome.status` — missing values

The stash defines `status: "completed" | "failed" | "canceled"` (3 values). The harness's actual `RunStatus` enum (`state/schema.ts:46`) has **6 values**:

```typescript
z.enum(["running", "completed", "partial", "failed", "canceled", "suspended_insufficient_funds"])
```

**Fix:** Expand `ProvRunOutcome.status` to match the full `RunStatus` enum, or at minimum add `"partial"` and `"suspended_insufficient_funds"`. The `"running"` status wouldn't appear in a `prov.run_completed` event.

#### Mismatch 2: `ProvStepRef.command` / `exitCode` — wrong layer

The stash assumes a step has a single `command` and `exitCode`. The harness tracks commands **per output file**, not per step. A step is an agent that may run many sandbox commands, each producing different files. See `ProvenanceCollector.recordCommandExecution()` at `collector.ts:284-326` — command/exitCode are fields on `ProvenanceRecord`, keyed by output path.

**Fix:** Remove `command?` and `exitCode?` from `ProvStepRef`. Per-command metadata flows through `prov.file_written` events (each file knows its producer). `ProvStepRef` should carry only `{ runId, stepId, durationMs? }`.

#### Mismatch 3: `ProvFileRef.producer` — string discriminant vs rich object

The stash defines `producer: "command" | "file_tool"` (a bare string). The harness's actual `Producer` type (`types.ts:31`) is a rich discriminated union:

```typescript
// Command producer: { type: "command", command, args, exitCode, durationMs, timestamp }
// File-tool producer: { type: "file_tool", tool, timestamp }
```

The stash discards all producer metadata (command string, exit code, duration, tool name, timestamp).

**Fix:** Either expand `ProvFileRef.producer` to carry the full object (which the `appendFileWritten` tsprov builder can map to entity attributes), or deliberately accept the data loss and document that per-file command metadata stays harness-internal.

#### Mismatch 4: `ProvRunRef.goal` — no harness backing

The stash defines `goal?: string` on `ProvRunRef`. The harness's `ExecuteAnalysisInput` has `planSummary: string` (line 96) but no `goal` field. The analysis-level goal lives in working memory (`cortex_working_memory`), a separate concept from the run.

**Fix:** Rename to `planSummary?: string` to match the harness's vocabulary, or populate from the analysis's working memory at emit time.

#### Mismatch 5: `ProvFileRef.path` — format difference

The stash expects analysis-relative paths (`"runs/{runId}/{stepId}/output/results.csv"`). The harness's `ProvenanceRecord.outputPath` is step-relative (`"output/results.csv"` — prefix stripped at `collector.ts:309`). The adapter must prepend `runs/{runId}/{stepId}/` when building the event.

#### What IS grounded

- `runId` — used everywhere in harness workflows
- `stepId` — stable step identity on `SandboxStepInput`
- `ProvFileRef.hash` — SHA-256 hex, matches harness's `outputHash`
- `ProvFileRef.size` — matches harness's `outputSize`
- `ProvStepRef.durationMs` — backed by `cortex_step_executions.durationMs` (`state/schema.ts:97`)
- The bus event pattern itself (emit events → CLI recorder appends to tsprov doc) is architecturally sound

## 6. Design Decisions (Resolved)

### Q1: Per-command vs per-step granularity

**Decision: Per-file, not per-command.** Emit one `prov.file_written` event per output file. The stash's `ProvFileRef` is per-file: `{ path, hash, size, producer }`. The `producer` field preserves whether it was a command or file-tool write. Per-command execution metadata (command string, exit code, duration) rides on `prov.step_completed`.

**Rationale:** The W3C PROV document tracks entities (files) and their generation edges. Per-command scoping is an internal harness concern (the collector's `commandReads` scoping) — it doesn't need to cross the bus. The tsprov document records `wasGeneratedBy(file, step)`, not `wasGeneratedBy(file, command)`.

### Q2: Input lineage in tsprov

**Decision: Step-level `used()` edges.** The tsprov document records `used(step, input)` — which inputs the step consumed. The per-command input scoping (which specific command read which specific input) stays internal to the harness collector. If fine-grained lineage is needed later, it can be added as `wasDerivedFrom(output, input)` edges without breaking the step-level model.

**Rationale:** The stash's `appendFileWritten()` already creates `wasDerivedFrom(file, analysis)` — file derived from the analysis. Adding `wasDerivedFrom(file, input)` for each input would multiply edges (N outputs × M inputs per command). Start coarse, refine later.

### Q3: Sandbox hook layer data

**Decision: Internal-only.** Layer attribution (`["python", "inotify"]`) is debugging metadata for the sandbox system. It does NOT enter the tsprov document. The PROV document records what was read/written, not how the observation was made.

### Q4: Signing scope

**Decision: Extend the analysis document.** The stash already extends the per-analysis document with run/step/file records. Each flush re-serializes, re-chains, and re-signs the whole document. No separate per-run document.

**Rationale:** One document per analysis matches the existing signing infrastructure. The chain hash provides tamper-evidence across all flushes. A separate per-run document would require a new signing scope and key management — unnecessary complexity.
