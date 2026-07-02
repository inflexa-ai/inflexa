# File Materialization: CLI → Harness Input Staging

## Status: Research Complete — Ready for Wiring

## 1. Architecture Overview

The CLI owns user-facing file selection. The harness expects files to be pre-staged on local disk with a `StagedInput[]` manifest. Since the harness runs as a package dependency of the CLI (same machine, same filesystem), files can be hardlinked or copied — no network transfer needed.

```
USER selects files (TUI/CLI)
  ↓
CLI staging module (src/modules/staging/staging.ts)
  ↓  stageInputs(analysisId, targetDir)
  ↓  hardlink (fallback: copy) + SHA-256 hash
  ↓
/{sessionPath}/{resourceId}/data/inputs/local/{key}
  ↓  StagedInput[] manifest
  ↓
Harness trigger (triggerDataProfile / executeAnalysis)
  ↓  manifest rides in DataProfileWorkflowInput.stagedInputs
  ↓
Sandbox mounts /{resourceId} read-only
  ↓
Agent reads files via execute_command / read_file
```

## 2. The StagedInput Contract (Verified Wire-Compatible)

Both sides define a `StagedInput` shape. They are verified identical:

### CLI Side (`src/modules/staging/staging.ts:17-32`)

```typescript
type StagedInput = {
    readonly fileId: string;      // Bun.hash(anchorId|path).toString(36)
    readonly mountName: string;   // Always "local"
    readonly key: string;         // Relative path within mount
    readonly fileName: string;    // Basename
    readonly hash: string;        // SHA-256 hex
    readonly size: number;        // Bytes
    readonly relativePath: string; // "inputs/local/{key}"
};
```

### Harness Side (`harness/src/execution/staged-input.ts:22-31`)

```typescript
interface StagedInput {
    readonly fileId: string;        // Opaque source identifier
    readonly mountName: string;     // Source mount name
    readonly key: string;           // Source key/path
    readonly fileName: string;      // Original filename
    readonly hash: string;          // SHA-256 content hash
    readonly size: number;          // File size in bytes
    readonly relativePath: string;  // Path relative to data dir
}
```

**Compatibility:** Field names and types match exactly. The CLI's concrete type satisfies the harness's interface. The harness's doc comment at `staged-input.ts:1-14` explicitly states:

> The harness's durable workflows assume an analysis's input tree is already populated under `data/inputs/` — they never download or copy input data, and never call a staging step. The embedder stages the tree at the async edge, once, BEFORE invoking the harness.

## 3. CLI Staging Module (Complete, Tested)

**Location:** `src/modules/staging/staging.ts` (162 lines, exists in working tree)

### Entry point

```typescript
// staging.ts:130-161
async function stageInputs(
    analysisId: string,
    targetDir: string
): Promise<Result<StagedInput[], DbError | StagingError>>
```

### Behavior

1. `listAnalysisInputs(analysisId)` — fetches inputs from DB
2. `resolveInputPath(input)` — resolves each to an absolute path (handles orphaned anchors gracefully)
3. For each input:
   - **File:** `stageSingleFile(absPath, key, fileId, targetDir)` → hash + hardlink/copy + return `StagedInput`
   - **Directory:** `walkFiles(absPath)` recursively → stage each file with subpath-derived `fileId`
4. Returns `StagedInput[]` manifest

### Key implementation details

```typescript
// staging.ts:39-42 — deterministic identity (same key space as provenance inputQName)
function deriveFileId(input: AnalysisInput, subpath?: string): string {
    const key = `${input.anchorId ?? ""}|${subpath ? `${input.path}/${subpath}` : input.path}`;
    return Bun.hash(key).toString(36);
}

// staging.ts:49-62 — hardlink with cross-filesystem fallback
function stageFile(src: string, dest: string): Result<void, FsError> {
    // linkSync(src, dest); catch → copyFileSync(src, dest)
}

// staging.ts:93-114 — per-file staging: hash + link/copy + stat
async function stageSingleFile(absPath, key, fileId, targetDir): Promise<Result<StagedInput, FsError>>
```

### Error handling

Best-effort — orphaned anchors (deleted directories) are skipped via `resolveInputPath` returning null. Partial staging is preferred over total failure. All results are `neverthrow` `Result<T, E>`.

### Tests (`staging.test.ts`)

- Single file staging with hash verification
- Directory tree staging with subpath resolution
- Distinct fileIds for multiple inputs
- Empty manifest handling
- Orphaned anchor graceful skip
- Content integrity verification

## 4. Harness Workspace Layout

The harness expects this structure under `/{sessionPath}/{resourceId}/`:

```
/{resourceId}/
├── data/
│   ├── inputs/                    # ← CLI stages files here
│   │   └── local/{key}            #    e.g., inputs/local/counts.csv
│   └── dataprofile/               # Data profiling output
├── runs/{runId}/
│   ├── synthesis.json
│   └── {stepId}/
│       ├── scripts/               # Generated analysis scripts
│       ├── output/                # Analysis output files
│       ├── figures/               # Plots and visualizations
│       ├── logs/                  # Execution logs
│       └── notebooks/             # Generated notebooks
└── reports/{reportId}/
```

### Path Helpers (from stash `feat/provenance`)

The stash adds to `src/modules/analysis/output.ts`:

```typescript
// output.ts (stash additions, verified from diff)

// Base path the harness receives as sessionPath
function sessionTreeRoot(analysis: Analysis): Result<string, DbError>
// → resolveOutputDir(analysis).map(dir => join(dir, analysis.id))

// Where staged inputs go
function dataInputsDir(analysis: Analysis): Result<string, DbError>
// → sessionTreeRoot(analysis).map(root => join(root, "data", "inputs"))

// Step working directory (matches harness convention)
function runStepDir(runId: string, stepId: string): string
// → join("runs", runId, stepId)
```

The harness has its own `runStepDir` at `harness/src/workspace/paths.ts`:

```typescript
// harness/src/workspace/paths.ts — same convention
function runStepDir(resourceId: string, runId: string, stepId: string): string
```

## 5. Sandbox Mount Strategy (Verified from `harness/src/workspace/mount-strategy.ts`)

The harness mounts the session tree into sandbox containers as a composite filesystem:

```
Sandbox Container
├── /{resourceId}/                          (read-only mount)
│   ├── data/inputs/local/{key}             ← staged inputs visible here
│   ├── runs/{prior-runId}/{prior-stepId}/  ← prior run outputs visible
│   └── runs/{runId}/{stepId}/              ← overridden by RW mount below
│
└── /{resourceId}/runs/{runId}/{stepId}/    (read-write nested mount)
    ├── scripts/                            ← agent writes scripts here
    ├── output/                             ← agent writes results here
    └── figures/                            ← agent writes plots here
```

**Key invariant:** Scripts run inside the sandbox see inputs at `/{resourceId}/data/inputs/local/{key}` — the same `relativePath` field the CLI staging module produces in each `StagedInput`.

## 6. Integration Wiring

### What exists today

- `src/modules/staging/staging.ts` — complete staging module (not yet wired to launch)
- Stash `feat/provenance` — path helpers (`sessionTreeRoot`, `dataInputsDir`, `runStepDir`)
- `harness/src/execution/staged-input.ts` — interface the manifest must satisfy

### What needs to be built

```
1. User runs `inflexa analyze` or triggers from TUI
2. CLI resolves analysis → gets inputs from anchors
3. CLI calls:
   sessionRoot = sessionTreeRoot(analysis)
   dataDir = dataInputsDir(analysis)
   manifest = await stageInputs(analysis.id, dataDir)
4. CLI emits prov.input_added events for each staged input (already works)
5. CLI calls harness trigger:
   - triggerDataProfile(resourceId, manifest, ...)
   - or executeAnalysis(resourceId, manifest, plan, ...)
6. Manifest rides in the DBOS workflow input
7. Harness sandbox agent reads from /{resourceId}/data/inputs/local/{key}
8. Post-step: provenance events emitted back via Bus
```

### Path contract

| Component | Path | Who creates | Who reads |
|-----------|------|-------------|-----------|
| Session root | `{outputDir}/{analysisId}/` | CLI (stash: `sessionTreeRoot()`) | Harness (receives as `sessionPath`) |
| Data inputs | `{sessionRoot}/data/inputs/local/{key}` | CLI (`stageInputs()`) | Harness (sandbox RO mount) |
| Run directory | `{sessionRoot}/runs/{runId}/` | Harness (at run start) | CLI (for result files) |
| Step directory | `{sessionRoot}/runs/{runId}/{stepId}/` | Harness (at step start) | CLI (for result files) |

## 7. Hardlink vs Symlink vs Copy

### Current approach: Hardlink (fallback: copy) — correct, keep it

The staging module uses `linkSync()` with `copyFileSync()` fallback (`staging.ts:49-62`). This is optimal:

- **Zero disk overhead** (hardlink shares inode)
- **Immutable guarantee** (harness mounts inputs read-only)
- **Cross-filesystem fallback** (copy if hardlink fails)
- **Docker-transparent** (bind-mount sees regular files, unlike symlinks)
- **Hash computation reads the original** (before or after link, same content)

### Why not symlinks?

- Docker bind-mount doesn't follow host symlinks inside the container
- Dangling risk if user moves/deletes original during analysis
- No practical benefit over hardlink

## 8. Design Decisions (Resolved)

### Q1: Session tree location

**Decision: Under the analysis output directory.** The stash's `sessionTreeRoot()` returns `resolveOutputDir(analysis).map(dir => join(dir, analysis.id))`. This means the session tree (inputs, runs, outputs) lives under the analysis's managed output directory — alongside the `.inflexa` metadata that provenance export already targets.

### Q2: Cleanup

**Decision: CLI owns cleanup.** The CLI created the session tree, so it cleans it up. The harness never deletes input data. Cleanup should happen after archiving the analysis (or on explicit user action), not immediately after a run — the user may want to inspect outputs.

### Q3: Re-run detection

**Decision: Defer.** For now, re-running an analysis re-stages all inputs (idempotent — hardlinks to the same files). If performance becomes an issue with large datasets, add a hash cache keyed by `(path, mtime, size)` in the staging module. The harness doesn't care — it sees the same `StagedInput[]` manifest either way.

### Q4: Large files

**Decision: Defer.** SHA-256 hashing is the bottleneck for multi-GB files. The staging module hashes sequentially. If needed, add streaming hash + mtime cache. Not a blocker for initial integration.
