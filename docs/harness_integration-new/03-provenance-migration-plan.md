# Provenance Migration Plan — Harness Custom → cli tsprov (W3C PROV)

Decision frame: **tsprov is the ledger, the harness machinery is the sensor.**
"Only use the cli approach" means the cli's signed tsprov document in SQLite becomes the
ONLY *persisted* provenance. The harness's custom *persistence format*
(`provenance-index.json`) goes. The harness's *collection* machinery (sandbox hooks +
step collector) stays — tsprov cannot observe file I/O inside a Docker sandbox; something
must produce the raw observations that become PROV records. The two are orthogonal:
format vs sensor.

Inputs: `01-provenance-cli-target.md` (target model), `02-provenance-harness-inventory.md`
(current harness state), `05-prior-work.md` (stash + staging verdicts).

## 1. Verdict table

### GOES (delete)

| What | Where | Why safe |
|---|---|---|
| `FilesystemArtifactRegistry` + `provenance-index.json` format | `harness/src/execution/filesystem-artifact-registry.ts` (+test, + `index.ts:28` export) | The custom serialization being replaced. Nothing in the harness ever reads the file back (grep-verified). Its own header names the CLI as the intended consumer — the cli now consumes via its own `ArtifactRegistry` impl instead |
| Dead write-snapshot seam | `harness/src/workspace/provenance-collector.ts` + plumbing in `mutator.ts:61,113-127` and `shared.ts:27,119,257` | Zero production implementations of `recordSnapshot` exist (tests only). The lineage collector's `recordFileToolWrite` covers the same concern if ever needed |
| Stale comments | `processProvenanceFrame` refs (`collector.ts:20`, `ignored-dirs.ts:3/10`, `reconcile-manifest.ts:14`); `StepMetadata.sourceRunIds` block (`collector.ts:116-157`) | Reference removed code; pure debt |
| (Decide) `deletes` arm of `ProvenanceFrame` | `sandbox/types.ts:63`, all 4 sandbox layers capture it | Zero harness consumers today. Either drop from the wire schema, or keep and map to `wasInvalidatedBy` in a later iteration. Recommend: **keep on the wire, document as reserved** — removing it means touching all 4 hook layers + Go for no functional gain |

### STAYS (unchanged)

| What | Why |
|---|---|
| Sandbox 4-layer capture (`images/sandbox-base/provenance/*`, `server/provenance*.go`, executor lifecycle) | The sensor. Observes actual libc/interpreter-level I/O; irreplaceable by tsprov |
| `harness/src/provenance/` (collector, exec-frame, types) | Internal transport: per-step accumulation, input classification, per-command scoping. Never W3C-shaped; never persisted itself |
| `reconcile-manifest.ts` — both halves | Manifest rehash is artifact integrity (non-prov); `fillInputHashesFromDisk` content-attests the lineage that feeds the *signed* cli document — keep the fail-fast attestation |
| `ArtifactRegistry` seam + `cortex_artifacts` ledger + `ignored-dirs.ts` | The seam is the handoff point; the ledger serves discovery/vector-index/sync; IGNORED_DIRS feeds the manifest walk |
| Session `Provenance` (`auth/types.ts:63`) | Different concept (event-source stamping); untouched |
| `mount-plan.ts` `PROVENANCE_WATCH_DIRS` wiring | Scopes the sensor to `/{analysisId}` |

### RESHAPED

| What | How |
|---|---|
| OSS artifact registry realization | cli provides the `ArtifactRegistry` impl (the bus adapter, §2). `FilesystemArtifactRegistry` deleted after cutover |
| Run lifecycle events | Either a new optional `emitProvenance` dep in `ExecuteAnalysisDeps`, or cli-side emission around the trigger (§3) |
| Harness barrel (`index.ts`) | Currently exports neither `StagedInput` nor the data-profile trigger (grep-verified). Extend the barrel for the embedder API |
| Coverage hole (optional, later) | `data-profile.ts:249` and `ephemeral-runner.ts:166` build sandbox agents with NO lineage collector — decide whether data-profile runs deserve provenance; out of scope for cutover |

## 2. How the harness communicates prov to the cli

Same-process embedding (cli imports `@inflexa-ai/harness`). The harness stays
**tsprov-free and Bus-free**; everything crosses via DI at the composition root.
(The "should tsprov live in the harness?" question was settled NO in the old research —
DI alignment, no double serialization, containment in one cli file — and nothing in the
re-verified tree changes that. The tsprov `ProvDocument.update()` merge seam exists as a
fallback but is not the plan.)

```
HARNESS (tsprov-free, Bus-free)               CLI (owns Bus + tsprov)
──────────────────────────────                ─────────────────────────
sandbox hooks → ProvenanceFrame               cli/src/modules/prov/
  → feedExecFrame → ProvenanceCollector         harness-registry.ts (NEW)
  → reconcile (content-attest)                  implements ArtifactRegistry:
  → registerStepArtifacts                       register() →
     → registry.register(input, session) ────►    Bus.emit prov.file_written × N
        [input carries the collector]             Bus.emit prov.step_completed × 1
                                                  (paths prefixed runs/{runId}/{stepId}/)
execute-analysis run boundaries  ────────────►  prov.run_started / prov.run_completed
  (via emitProvenance dep, OR cli emits           ↓
   around its own trigger/await — §3)           prov.ts::onEvent → append* → flush
                                                  → unified().serialize → chain hash
                                                  → Ed25519 sign → analyses.provenance
```

Two properties make this work with **zero harness changes for step/file events**
(confirmed by the stash investigation):
- `ArtifactRegistrationInput` already carries `{resourceId, runId, stepId, artifacts, collector}` — everything the events need.
- `FilesystemArtifactEntry.path` already uses the `runs/{runId}/{stepId}/…` convention
  the stash's `ProvFileRef.path` expects, and `ProvenanceRecord.producer.type` is the
  same `"command" | "file_tool"` vocabulary (both grep-verified against current code).

Hard constraint: events are keyed by `analysisId` and silently dropped for unknown rows
(`cli prov.ts:115`) — so **harness `resourceId` must be the cli `analysisId`**, which the
trigger contract already guarantees (`DataProfileTriggerParams.analysisId`,
`data-profile.ts:387-391`).

## 3. Run lifecycle events — two options

**Option A (old plan): `emitProvenance?: (event) => void` on `ExecuteAnalysisDeps`.**
Harness emits at the same points as the run-boundary stream parts — verified post-merge:
`data-run-started` at `execute-analysis.ts:324`, `data-run-completed` at `:779`, and
`data-run-failed` at `:797`. Note the old docs missed the failed path entirely:
`prov.run_completed` must be emitted at BOTH terminal sites (status distinguishes them).
One small harness PR; events carry authoritative status/duration.

**Option B (zero-harness-change): cli emits around its own call.** The cli triggers the
run and can emit `prov.run_started` before, `prov.run_completed` when the workflow handle
resolves. No harness edit at all. Caveat to verify: whether the handle's result carries
the final `RunStatus` and duration — if not, A wins.

**Recommendation: A** — the harness owns run status truth (6-value `RunStatus`,
`state/schema.ts:46`), and the optional-callback pattern matches its DI style. Keep B in
mind if we want the first cutover PR to touch only the cli.

## 4. Event schema (port of the stash, with required fixes)

Stash shapes port nearly verbatim (see `05-prior-work.md`), with these fixes — items
1–4 were known from the old research and re-confirmed; 5–7 are new findings:

1. **Widen `ProvRunOutcome.status`** to the harness vocabulary minus `running`:
   `"completed" | "partial" | "failed" | "canceled" | "suspended_insufficient_funds"`.
2. **Drop `command?`/`exitCode?` from `ProvStepRef`** — they're per-output-file in the
   harness (`recordCommandExecution`), not per-step.
3. **`ProvFileRef.producer`: user decision still open.** Bare `"command"|"file_tool"`
   discriminant (simple, loses command/args/exitCode/tool detail) vs the rich `Producer`
   object mapped to entity attributes. Default if undecided: bare now, rich later —
   additive change.
4. **Rename `ProvRunRef.goal` → `planSummary`** (harness vocabulary).
5. **Fix the orphan-action quirk (NEW — verified in the stash diff):** ALL FOUR new
   builders call `startAction(...)` without using the returned `actionQn`
   (`appendRunStarted` destructures `{analysisQn, time, agentQn}`, `appendStepCompleted`
   only `{analysisQn}`, `appendRunCompleted` only `{time}`, `appendFileWritten` discards
   everything) — every event mints an orphan `inflexa:action-{randomUUIDv7()}` activity
   linked only to its agent. Worse under DBOS recovery: replayed emits mint *fresh*
   UUIDs, so orphans duplicate.
   **Rule: every QName in the new builders must be deterministic** from
   (runId, stepId, path|hash) — run/step/file QNames already are; remove the orphan
   `startAction` calls or key actions deterministically. This is what actually makes
   replay idempotent under `unified()`; the old docs' "unified() deduplicates" claim
   holds only with deterministic identifiers.
6. **Resolve the activity/entity double-use (NEW):** stash `appendRunCompleted` writes
   `doc.entity(runQName, …)` on the QName that `appendRunStarted` declared as an
   *activity*. Decide: record completion as attributes on the activity (with an end
   time) instead of a same-QName entity.
7. **Actor kind (NEW):** run/step/file events originate from machine execution — use the
   existing `{kind:"system"}` actor at minimum. If we want the *model/agent* identity in
   PROV (`prov:SoftwareAgent` per model, `actedOnBehalfOf` user), that's an additive
   `ProvActor` variant + `appendAgent` case; the switch throws on unknown kinds, so this
   must be deliberate, not accidental.

Input lineage: keep the old Q2 decision (start coarse — no per-input `used()` edges at
cutover). The collector's `getTrackedInputs()` is content-attested and richer than
anything the stash modeled; adding `prov.input_used` or `wasDerivedFrom(file, input)`
edges later is additive. Sandbox layer attribution stays internal (old Q3). One signed
document per analysis (old Q4).

## 5. Migration phases (supersedes old `05-implementation-checklist.md`)

1. **Port the stash by hand into `cli/src`** — NOT `git stash pop` (old checklist is
   wrong: old-structure paths, dangling base, API drift). Port types → events →
   builders → recorder cases → bus fields → tests, applying §4 fixes. Test-import
   adaptations: `flushProvenance` → `flushProvenanceAsync`, `verifyChainHash` →
   `verifyHexDigest`.
2. **Relocate `src/modules/staging/` → `cli/src/modules/staging/`** and port the stash's
   path helpers (`sessionTreeRoot`, `dataInputsDir`; rename its `runStepDir` — name
   collides with harness's 3-arg version). Detail in `04-file-materialization.md`.
3. **Build the cli-side registry adapter** (`ArtifactRegistry` impl translating
   `register()` → bus events; prefix paths with `runs/{runId}/{stepId}/`; `sync()`
   no-op — bytes already live locally; return the verified result shape
   `{registered: [], failed: [], failedCount: 0}`, `ExternalRegistrationResult` at
   `artifact-registry.ts:50-65`). Contract note that fits the adapter exactly:
   implementations "MUST NOT touch the local `cortex_artifacts` ledger — that is the
   harness's responsibility, applied around this call" (`artifact-registry.ts:69-71`) —
   the bus adapter only emits events, so it complies by construction.
4. **Wire the composition root**: cli `package.json` gets `"@inflexa-ai/harness":
   "file:../harness"`; `assembleCoreRuntime()` with the adapter as
   `sandboxStep.artifactRegistry`; run lifecycle per §3; extend the harness barrel for
   `StagedInput` + trigger exports.
5. **Harness cleanup**: delete the GOES table items; reshape `ArtifactRegistrationInput`
   only if we choose to (the collector field can stay — the adapter uses it).
6. **Spec hygiene**: revise/archive `exec-provenance-lineage` (registration is now
   embedder-bound); keep `sandbox-provenance-tracking` + `explicit-input-classification`
   (sensor stays); fix the 4 cli spec drifts (01 §6); add a spec for the prov bridge
   events on the cli side.
7. **End-to-end test**: stage → trigger → sandbox exec → frames → collector → adapter →
   bus → recorder → signed document; verify `inflexa:Run/Step/File` in PROV-N export and
   `prov verify` passes.

## Open decisions for the user

- [ ] `ProvFileRef.producer`: bare discriminant vs rich object (§4.3).
- [ ] Run lifecycle: Option A (harness `emitProvenance` dep) vs B (cli-side emission) —
      recommendation A (§3).
- [ ] `deletes` wire arm: keep-reserved (recommended) vs remove (§1).
- [ ] Should data-profile runs collect lineage too, or is executeAnalysis-only
      acceptable for the first cut? (coverage hole, 02 §1)
