# Composition & Wiring: CLI → Harness Integration

## Status: Research Complete — Implementation-Ready

## 1. How the CLI Will Embed the Harness

The harness is a package dependency: `@inflexa-ai/harness` (via `file:../harness` or a published version). The CLI builds a composition root that calls `assembleCoreRuntime(deps)` from the harness barrel export.

### Entry Point: `assembleCoreRuntime()`

**Location:** `harness/src/runtime/assemble.ts:72-97`

```typescript
function assembleCoreRuntime(deps: CoreRuntimeDeps): CoreRuntime
```

**Input:** `CoreRuntimeDeps` = `{ conversation: ConversationAssemblyDeps, workflows: CoreWorkflowDeps }`

**Output:** `CoreRuntime` = `{ conversationAgent: AgentDefinition, workflows: RegisteredWorkflows }`

### Registration order (load-bearing)

```
assembleCoreRuntime(deps)
  1. registerSandboxStep(deps.workflows.sandboxStep)         ← child first
  2. registerExecuteAnalysis(deps.buildExecuteAnalysis(sandboxStep))  ← parent closes over child
  3. registerExecuteTargetAssessment(deps.workflows.executeTargetAssessment)
  4. registerDataProfileWorkflow(deps.workflows.dataProfile)
  5. registerEphemeralWorkflow(deps.workflows.ephemeral)
  6. createConversationAgent({ ...conversation, executeAnalysisWorkflow, ephemeralWorkflow })
```

## 2. Where ArtifactRegistry Is Wired

The `ArtifactRegistry` seam is passed as `SandboxStepDeps.artifactRegistry`:

```typescript
// sandbox-step.ts:227-257
interface SandboxStepDeps {
    readonly pool: Pool;
    readonly provider: AgentChat;
    readonly embedding: EmbeddingProvider;
    readonly sandboxClient: SandboxClient;
    readonly artifactRegistry: ArtifactRegistry;  // ← THE SEAM
    readonly workspaceFs: WorkspaceFilesystem;
    readonly sessionsBasePath: string;
    readonly model: string;
    buildAgent(ctx: SandboxAgentBuildContext): AgentDefinition;
    resolveWritePrefix(input: SandboxStepInput): string;
}
```

This feeds into `CoreWorkflowDeps.sandboxStep`:

```typescript
// assemble.ts:39-44
interface CoreWorkflowDeps {
    readonly sandboxStep: SandboxStepDeps;         // ← ArtifactRegistry lives here
    readonly buildExecuteAnalysis: (sandboxStep: SandboxStepCallable) => ExecuteAnalysisDeps;
    readonly executeTargetAssessment: ExecuteTargetAssessmentDeps;
    readonly dataProfile: DataProfileDeps;
    readonly ephemeral: EphemeralDeps;
}
```

### Flow: ArtifactRegistry → Post-Step Pipeline

```
SandboxStepDeps.artifactRegistry
  ↓ threaded into PostStepPipelineDeps
post-step-pipeline.ts:152 → registerStepArtifacts(db, deps.artifactRegistry, ...)
  ↓
artifact-registration.ts:45 → registry.register(input, session)
  ↓
FilesystemArtifactRegistry.register()  ← current OSS
  OR
BusProvenanceAdapter.register()        ← proposed replacement
```

## 3. Where prov.run_started / prov.run_completed Should Be Emitted

The parent workflow (`execute-analysis.ts`) already emits UI stream events at run boundaries:

```typescript
// execute-analysis.ts:323-328
await emitStreamPart({
    type: "data-run-started",
    runId,
    planSummary: input.planSummary,
    stepCount: input.steps.length,
});

// execute-analysis.ts:778-794
await emitStreamPart({
    type: "data-run-completed",
    runId,
    status,
    completedSteps: completed.size,
    ...
});
```

The `prov.run_started` / `prov.run_completed` bus events should be emitted alongside these, but NOT through `emitStreamPart` (which writes to the DBOS stream). Instead, they go through the injected emit function:

### Option A: Inject a provenance emit function into `ExecuteAnalysisDeps`

```typescript
// Proposed addition to ExecuteAnalysisDeps
interface ExecuteAnalysisDeps {
    // ... existing deps ...
    readonly emitProvenance?: (event: ProvBusEvent) => void;
}
```

The parent workflow body calls:
```typescript
// After emitStreamPart("data-run-started"):
deps.emitProvenance?.({
    type: "prov.run_started",
    analysisId: input.analysisId,
    actor: { kind: "system" },
    run: { runId, goal: input.planSummary },
});

// In collectAndComplete, after emitStreamPart("data-run-completed"):
deps.emitProvenance?.({
    type: "prov.run_completed",
    analysisId: input.analysisId,
    actor: { kind: "system" },
    outcome: { runId, status, durationMs },
});
```

### Option B: Emit from the `BusProvenanceAdapter`

The `prov.step_completed` events already flow through `ArtifactRegistry.register()`. For `prov.run_started`/`prov.run_completed`, the adapter would need to be called at the run boundaries too, which doesn't fit the per-step seam.

**Recommendation: Option A** — add an optional `emitProvenance` callback to `ExecuteAnalysisDeps`. The CLI wires it to `Bus.emit`; the harness stays Bus-unaware.

## 4. The Bus Is CLI-Only

**Critical finding:** The harness has NO `Bus` module. Zero imports of `Bus` or any event emitter in `harness/src/`.

The event bus lives exclusively in the CLI (`cli/src/lib/bus.ts`). The harness communicates provenance to the CLI through injected callbacks, not by importing a shared Bus:

```
CLI (owns Bus)                              Harness (Bus-unaware)
─────────────                               ────────────────────
Bus.emit("inflexa", event)  ←── wired as ── emitProvenance(event)
                                            in ExecuteAnalysisDeps
Bus.emit("inflexa", event)  ←── wired as ── ArtifactRegistry.register()
                                            calls deps.emit(channel, event)
```

This is consistent with the harness DI philosophy: construction-time deps are injected, no globals.

## 5. ProvenanceCollector Name Collision

The harness has two types named `ProvenanceCollector`:

### 1. Workspace seam: `workspace/provenance-collector.ts:34`

```typescript
interface ProvenanceCollector {
    recordSnapshot(snapshot: ProvenanceSnapshot): Promise<void>;
}
```

Used by: `tools/workspace/mutator.ts`, `agents/sandbox/shared.ts`
Purpose: Records SHA-256 snapshots of write_file/edit_file outputs (harness-side writes)

### 2. Step-level class: `provenance/collector.ts:171`

```typescript
class ProvenanceCollector {
    trackInputAccess(...): InputRef
    recordFileToolWrite(...): void
    recordCommandExecution(...): void
    getRecords(): ProvenanceRecord[]
    getDataInputs(): InputRef[]
    // ... more methods
}
```

Used by: `workflows/sandbox-step.ts`, `execution/artifact-registration.ts`, `execution/reconcile-manifest.ts`, `provenance/exec-frame.ts`
Purpose: Accumulates per-step lineage (inputs, outputs, per-command scoping)

### The collision is acknowledged

`agents/sandbox/shared.ts:28` already imports the class with an alias:
```typescript
import type { ProvenanceCollector } from "../../workspace/provenance-collector.js";
import type { ProvenanceCollector as LineageCollector } from "../../provenance/collector.js";
```

### Resolution recommendation

Rename the workspace seam to `WriteTracker` or `WriteSnapshotCollector`. It's a single-method interface and doesn't represent the broader "provenance collection" concept. The step-level class is the real `ProvenanceCollector`. This rename is optional — the DI pattern means consumers don't need both in scope unless they're wiring them (like `shared.ts`).

## 6. Complete Wiring Plan

### CLI composition root builds:

```typescript
// CLI's composition root (proposed)

import {
    assembleCoreRuntime,
    createLocalRunAuthorizer,
    createNoopBillingResolver,
    createNoopRunCharge,
    UnavailablePreviewPublisher,
    createDbosRunLauncher,
    makeLocalAuth,
    type ArtifactRegistry,
} from "@inflexa-ai/harness";

import { Bus } from "./lib/bus.js";

// 1. Build the BusProvenanceAdapter (replaces FilesystemArtifactRegistry)
const artifactRegistry: ArtifactRegistry = createBusProvenanceAdapter({
    emit: (channel, event) => Bus.emit(channel, event),
    actor: { kind: "system" },
});

// 2. Build the provenance emit callback for run lifecycle
const emitProvenance = (event) => Bus.emit("inflexa", event);

// 3. Wire assembleCoreRuntime
const runtime = assembleCoreRuntime({
    conversation: { /* chat deps */ },
    workflows: {
        sandboxStep: {
            pool,
            provider,
            embedding,
            sandboxClient,
            artifactRegistry,      // ← BusProvenanceAdapter
            workspaceFs,
            sessionsBasePath,
            model,
            buildAgent: ...,
            resolveWritePrefix: ...,
        },
        buildExecuteAnalysis: (sandboxStep) => ({
            pool,
            provider,
            embedding,
            sandboxStepCallable: sandboxStep,
            sessionsBasePath,
            synthesisModel,
            bioKeys,
            runCharge: createNoopRunCharge(),
            runAuthorizer: createLocalRunAuthorizer({ pool, auth: makeLocalAuth() }),
            emitProvenance,        // ← NEW: run lifecycle events
        }),
        executeTargetAssessment: { /* ta deps */ },
        dataProfile: { /* dp deps */ },
        ephemeral: { /* ephemeral deps */ },
    },
});
```

### Events flow:

```
Run start:
  execute-analysis.ts → deps.emitProvenance({ type: "prov.run_started", ... })
    → Bus.emit("inflexa", event)
    → prov.ts::onEvent() → appendRunStarted()

Per step (post-step pipeline):
  sandbox-step.ts → post-step-pipeline → artifactRegistry.register(input, session)
    → BusProvenanceAdapter.register()
    → deps.emit("inflexa", { type: "prov.step_completed", ... })
    → deps.emit("inflexa", { type: "prov.file_written", ... }) × N outputs
    → Bus.emit("inflexa", event) × (1 + N)
    → prov.ts::onEvent() → appendStepCompleted() + appendFileWritten() × N

Run complete:
  execute-analysis.ts → deps.emitProvenance({ type: "prov.run_completed", ... })
    → Bus.emit("inflexa", event)
    → prov.ts::onEvent() → appendRunCompleted()

All events → async flush → serialize(unified()) → chain hash → sign → DB
```

## 7. Public API Surface for CLI Embedder

From `harness/src/index.ts`, the CLI needs:

| Export | Type | Purpose |
|--------|------|---------|
| `assembleCoreRuntime` | function | Single assembly point |
| `CoreRuntimeDeps` | type | Composition input |
| `ArtifactRegistry` | interface | Seam to implement |
| `ArtifactRegistrationInput` | type | What register() receives |
| `ExternalRegistrationResult` | type | What register() returns |
| `createLocalRunAuthorizer` | function | OSS auth seam |
| `createNoopBillingResolver` | function | OSS billing seam |
| `createNoopRunCharge` | function | OSS charge seam |
| `UnavailablePreviewPublisher` | class | OSS preview seam |
| `createDbosRunLauncher` | function | Workflow launcher |
| `makeLocalAuth` | function | OSS auth context |
| `StagedInput` | interface | Deep import from `@inflexa-ai/harness/execution/staged-input.js` |

The `BusProvenanceAdapter` would live in the CLI (not the harness), since it depends on the Bus.
