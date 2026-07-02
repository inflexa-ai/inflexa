# Harness Custom Provenance — Verified Inventory (2026-07-02, post-merge tree)

Everything provenance-related in `harness/` and `images/sandbox-base/`, verified against
the merged tree. This is the "what exists" doc; the go/stay verdicts live in
`03-provenance-migration-plan.md`.

## 0. Disambiguation — three things called "provenance"

1. **Artifact/file lineage** — the subsystem this migration replaces. Below.
2. **Session `Provenance`** (`harness/src/auth/types.ts:63`, `{agentId, callPath}`) —
   event-source stamping / sub-agent call lineage. **Not part of this migration; keep.**
3. **Two types named `ProvenanceCollector`**:
   - the step-level lineage **class** (`harness/src/provenance/collector.ts:171`) — the
     real subsystem;
   - a `recordSnapshot(snapshot)` **interface** (`harness/src/workspace/provenance-collector.ts:34`)
     — a write-snapshot seam that is **dead in production**: `grep recordSnapshot` finds
     implementations only in tests; the harness never constructs one.
   `agents/sandbox/shared.ts:28` already aliases the class as `LineageCollector`.

## 1. Core lineage module — `harness/src/provenance/`

| File | Role |
|---|---|
| `types.ts` | Zod schemas: `Producer` (command \| file_tool), `InputSource` = `"data"\|"upstream"\|"prior"\|"artifacts"` (line 37), `InputRef` (line 41: path, hash, source, stepId?, runId?, fileId?), `ProvenanceRecord` (line 60: outputPath, outputHash, outputSize, producer, inputs[], scriptPath, stepId, runId) |
| `collector.ts` | The `ProvenanceCollector` class (line 171): `trackInputAccess` (218), `recordCommandExecution` (284), `recordFileToolWrite` (252), `getDataInputs` (331), `getTrackedInputs` (341), `getRecords` (374), `dropInput`/`removeRecord`/`replaceRecord`, `classifyReadPath` (82, 5 prefix branches) |
| `exec-frame.ts` | `feedExecFrame` (44): sandbox `ProvenanceFrame` → collector. Strips `/{resourceId}/`, classifies reads, records writes. **Only consumes `reads` and `writes` — the `deletes` arm has ZERO consumers in harness/src** (grep-verified) |

Only production instantiation: `new ProvenanceCollector({stepId, runId})` at
`workflows/sandbox-step.ts:382` (`dependsOn` NOT passed). Threaded to the agent via
`SandboxAgentBuildContext.lineageCollector` (212/440) and to post-step via
`PostStepContext.lineageCollector` (276/692) — same instance.

**Coverage hole (finding):** `tasks/data-profile.ts:249` and
`execution/ephemeral-runner.ts:166` build sandbox agents with **no lineage collector**
→ `feedExecFrame` never fires there. Lineage capture is executeAnalysis-steps-only.

**Stale-comment debt:** `processProvenanceFrame` referenced in comments at
`collector.ts:20`, `ignored-dirs.ts:3/10`, `reconcile-manifest.ts:14` — the function no
longer exists. `collector.ts:116-157` comment cites `StepMetadata.sourceRunIds` /
`workspace-profiles.ts:53` — neither type nor field exists anywhere.

## 2. Registration path (provenance-adjacent, mostly must stay)

```
sandbox-step.ts:737 → post-step-pipeline.ts:131 reconcileAndRegisterStepArtifacts
  → reconcile-manifest.ts:53 reconcileManifestWithDisk
      (1) disk-walk manifest rehash + phantom drop        ← NOT provenance; must stay
      (2) fillInputHashesFromDisk (124): content-attests InputRefs from disk,
          throws on missing/out-of-tree input             ← provenance-only
  → artifact-registration.ts:43 registerStepArtifacts
      (a) upsertArtifacts → cortex_artifacts ledger [ALWAYS] ← identity/sync; must stay
      (b) registry.register(input incl. collector, session)  ← THE SEAM
```

- `execution/artifact-registry.ts:67` — `ArtifactRegistry` interface (`register`+`sync`),
  self-described "provenance-agnostic seam", public via `index.ts:30`. BUT
  `ArtifactRegistrationInput.collector` (line 33) is a **required** field — removing
  lineage changes this public seam's shape.
- `execution/filesystem-artifact-registry.ts:83` — OSS impl; writes
  `runs/{runId}/{stepId}/provenance-index.json` (`FilesystemProvenanceIndex` line 50:
  artifacts / inputs=getTrackedInputs / lineage=getRecords). **Nothing in the harness
  ever reads this file back** (grep-verified). This is the custom serialization format.
- `cortex_artifacts` ledger (`state/artifacts.ts`, `state/schema.ts:25`) serves file
  discovery, vector indexing, `inspectRun`, managed sync — not primarily lineage.
- `sandbox/ignored-dirs.ts` — despite the provenance-era doc comment, `IGNORED_DIRS` is
  consumed by `walkStepArtifacts` (`post-step.ts:16`) for the artifact manifest. Stays.

## 3. Wire path: sandbox frame → collector

- `sandbox/types.ts:51-94` — `ProvenanceFrameEntry {path, layers[]}`,
  `ProvenanceFrame {disabled, reads[], writes[], deletes[]}`, `ExecResult.provenance`
  (optional — absence tolerated).
- `sandbox/await-exec.ts:70` — HMAC-verify callback → `ExecResultSchema.parse`; the frame
  rides the recv payload into the durable DBOS step output.
- `tools/workspace/run-exec.ts:35` → `tools/workspace/execute-command.ts:130-143` —
  after each exec, best-effort `feedExecFrame` if `lineageCollector` + `mountRoot` wired
  (`ExecuteCommandDeps` lines 87-89; wiring at `agents/sandbox/shared.ts:272`).
- `sandbox/mount-plan.ts:93` — the SOLE harness→sandbox provenance config:
  `env.PROVENANCE_WATCH_DIRS = /{analysisId}`.
- The harness ships **no HTTP route** for `/sandbox/{execId}/complete` — receiving the
  callback and `DBOS.send`-ing it is the embedder's job.

## 4. Sandbox-side capture (`images/sandbox-base/`) — 4 layers

Per-command lifecycle in `server/executor.go:110`: `NewProvenanceTracker(id, watchDirs)`
(126) → `Start()` (131) → child env from `provTracker.Env()` (135) → run → `Stop()` (199)
→ `completionPayload.Provenance` (200-205) → HMAC-signed POST to
`{CORTEX_BASE_URL}/sandbox/{execId}/complete` (`callback.go:61-120`).

| Layer | File | Mechanism | Captures |
|---|---|---|---|
| Python | `provenance/sitecustomize.py` | PEP-578 `sys.addaudithook` (line 88), loaded via PYTHONPATH=/opt/provenance | `open` read/write by mode (68-80), `os.remove/unlink` (82) |
| R | `provenance/Rprofile.site` | `trace()` on base/utils IO + `setHook(packageEvent onLoad)` for data.table/readr/readxl/arrow/vroom/haven; writes `$SOCK.rlog` (R lacks unix sockets) | read.csv/readRDS/scan/load/source…, write.csv/saveRDS/sink…, file.remove/unlink |
| C | `provenance/provtrack.c` | LD_PRELOAD `provtrack.so` (Dockerfile:28-31) | open/open64/openat/openat64/fopen/fopen64 (214-324), unlink/remove (326-344); prefix-filter + 32768 dedup cap |
| inotify | `server/provenance_inotify_linux.go` | walk watchDirs, 1000-watch cap, IN_OPEN/CREATE/DELETE/MOVED | verification channel; macOS stub is no-op |

Aggregation: `server/provenance.go` — `ops: op → path → set<layer>` (63); socket
`readLoop` (205) + `readRlog` (267); `Stop()` (121) drains 200ms → sorted
`provenanceResult{Reads,Writes,Deletes}` of `{path, layers[]}`. Watch scope from
`PROVENANCE_WATCH_DIRS` (default `/data`, line 304).

**Entanglement in executor.go:** the same `run` body also starts the (non-provenance)
`treediff.go` live file-tree differ → `/sandbox/{execId}/event`. Independent subsystems;
provenance removal there means excising lines 126-135 / 199-205 / 268 only.

## 5. Governing OpenSpec specs (harness/openspec/specs)

- `exec-provenance-lineage/spec.md` — frame→collector threading; post-step registration
  MUST receive the populated collector, MUST NOT synthesize an empty one; watch scope =
  `/{resourceId}`. **Directly invalidated by the migration** — must be revised/archived.
- `sandbox-provenance-tracking/spec.md` — the 4-layer in-container capture, "production-
  wired, not a prototype". Fate depends on the keep/remove decision on hooks (see 03).
- `explicit-input-classification/spec.md` — `InputRef.source` model + `classifyReadPath`
  5-branch order. Tied to the collector's fate.
- `artifact-manifest/spec.md` — manifest = disk walk, *separate* from provenance
  (lines 9-16); fail-fast attestation requirements. The manifest half stays regardless.

## 6. Delete-cleanly vs entangled (verdict inputs for doc 03)

**Deletes cleanly** (no non-lineage consumer):
`harness/src/provenance/` (entire dir); lineage threading in `sandbox-step.ts`
(212/276/382/440/692); `feedExecFrame` block in `execute-command.ts` (87-90, 128-143);
`fillInputHashesFromDisk` (`reconcile-manifest.ts:124-160`); the dead write-snapshot seam
(`workspace/provenance-collector.ts` + `mutator.ts:61,113-127` + `shared.ts:27,119,257`);
lineage/inputs arms of `provenance-index.json`; sandbox capture layers + `provenance*.go`
+ executor lines above.

**Entangled** (must be split or reshaped, not deleted):
`reconcile-manifest.ts` (manifest rehash stays); `ArtifactRegistry` seam
(`collector` is a required input field — public API change); `cortex_artifacts` ledger
(stays); `ExecResult.provenance` (optional field; schema tolerates absence — removal is
back-compat-safe but ripples `run-exec.ts` → `execute-command.ts`); `ignored-dirs.ts`
(stays — manifest consumer); `executor.go` (shares body with treediff).

## Gaps

- CLI-side embedder wiring (composition root, `/sandbox/:execId/complete` route) not yet
  inventoried — the cli has **no harness import today** (see 01 §1), so this is
  greenfield, not undiscovered code.
- `main.go` and `treediff.go` were not read in full; if the removal plan needs the exact
  executor construction site, read `main.go` first.
