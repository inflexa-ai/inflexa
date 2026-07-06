# Harness Integration (post-merge) — Progress Tracker

Successor to `docs/harness_integration/` (16 iterations, written against the pre-merge
tree / old root-`src/` structure). This folder re-verifies everything against the tree
as it exists AFTER the big harness PR merge, and carries the design forward.

Loop ran every 15 min on 2026-07-02, 15:26–16:10. **COMPLETE** — 3 iterations, all
artifacts final. Open items below need a user decision, not more research.

**Reading order for a new developer:** 06 (the change graph — how this all becomes
OpenSpec changes, and why C/embed-harness-runtime goes first) → 03 (the plan and
decisions) → 04 (materialization seam) → 01/02 (the two verified inventories backing
the plan) → 05 (what to salvage from the stash and the leftover root src/). The old `docs/harness_integration/` remains useful
for the Postgres research (07–09) and the sandbox-hook code review (06), which this
folder does not re-do; its provenance/staging/checklist docs (01–05) are superseded here.

---

## Change D2 — deepen-run-provenance (2026-07-06) — LANDED (code-complete, live-verified)

Follow-up to change D, born from the same-day assessment session that audited D against the
tree: it retires D's three deliberate cuts and adopts the tsprov hardening D filed. Specced +
implemented in `cli/openspec/changes/deepen-run-provenance` (proposal, design D1–D5, 3 modified
capability specs, 22/22 tasks). Orchestrated as three Opus worker slices (harness, cli
vocab+bridge, live E2E) with orchestrator-side diff review + independent gate re-runs.

What landed:
- **Harness-observed, replay-stable times**: `RunProvenanceEvent` reshaped to three arms
  (`run_started`/`step_completed`/`run_completed`), every timestamp an epoch-ms `DBOS.now()`
  read (checkpointed → recovery re-emits identical values). Run activities carry true
  workflow start/end plus `inflexa:durationMs` (terminal − start); the cli's
  `occurrenceTime()` guard is demoted to a defense-in-depth safety net.
- **Step events from the scheduler settlement** (`execute-analysis.ts` settlement branches),
  not the registry: every EXECUTED step gets a PROV activity with `inflexa:status`
  (`completed`/`failed`/`canceled`) — zero-artifact and failed steps included; never-dispatched
  steps emit nothing by design. The bus-adapter registry no longer emits `prov.step_completed`.
- **Input lineage**: `prov.input_used` per content-attested tracked input (skip
  `source:"artifacts"`, container path stripped to analysis-relative), recorded as entities in
  the SAME `(path, hash)` file-QName space as outputs — so a `source:"prior"` read merges onto
  the producing run's file entity and cross-run chains fall out with zero extra modeling.
- **tsprov 0.3.0 adopted** (inflexa-ai/tsprov#3, released via PR #4): the flush and export
  `unified()` sites pass `formalAttributeConflict: "first"`, so a formal-attribute conflict
  degrades to keep-first-plus-log instead of permanently unfushable provenance.

Live E2E (analysis `019f23b7`, 7 runs): mixed-outcome plan → run activity with exact
start/end/duration arithmetic, three step activities (completed / completed-zero-artifact /
failed via blocked), attested `input_used` with `source="data"`; cross-run chain → exactly ONE
entity for the shared `(path,hash)` carrying `wasGeneratedBy` from run 1's step AND `used` from
run 2's step; kill/recovery → SIGKILL mid-step, recovery completes with ONE run activity whose
`prov:startTime` is byte-identical to the pre-kill flush (`14:25:32.619Z`), all relation counts
= 1 despite multi-boot re-emission, `prov verify` valid. Gates: harness tsc clean + 696 tests;
cli typecheck clean + 422 tests; lint clean on every touched file (16 pre-existing baseline
problems in 7 untouched files remain).

**Findings noted for follow-up (out of this change's scope):**
- **Agent tool reads are invisible to lineage**: the collector only observes sandbox-exec I/O
  (`feedExecFrame`); a step that inspects a prior file via the workspace `read_file` tool
  leaves no `input_used` edge (observed live — the first cross-run reader used `read_file` and
  produced no lineage). A tool-read tracking hook is the upstream fix if coverage matters.
- **`summary.md` walk-ordering quirk** (pre-existing, found during D's assessment): written
  after the manifest walk → registered neither in provenance nor `cortex_artifacts`. Issue
  drafted; filing pending.
- **Issue #28 wedge mechanism observed live, twice**: `sandbox.create` is a checkpointed DBOS
  step, so recovery REUSES the leaked boot-1 container whose completion-callback ingress died
  with the killed host → `DBOS.recv` never unblocks. Removing the leaked container forces a
  fresh sandbox on the next recovery boot and the run completes — direct evidence for #28's
  diagnosis and a viable manual unwedge.

## Change D — bridge-harness-provenance (2026-07-06) — LANDED (code-complete, live-verified)

Change D of the change graph (06 §"The five changes"), with change B (port-prov-run-events)
folded in as its first slice — the last remaining verified-by-reading work from the research
program, now built. Specced + implemented in `cli/openspec/changes/bridge-harness-provenance`
(proposal, design D1–D8, 3 capability specs — 2 new + 1 modified, 23/23 tasks). Orchestrated as
five Opus worker slices with per-slice diff review + independent gate runs.

What landed:
- **Execution-provenance vocabulary in the cli** (the stash port, by hand): 4 bus events
  (`prov.run_started`/`run_completed`/`step_completed`/`file_written`), 4 domain types, 4 tsprov
  builders, 4 recorder cases. Runs and steps are PROV **activities**, files **entities** —
  correcting two PROV-invalid records in the stash blueprint (double analysis-generation;
  `wasGeneratedBy` a step-entity), found during design.
- **Bus-adapter `ArtifactRegistry`** (`cli/src/modules/harness/prov_bridge.ts`) replaces the
  change-F stub: `register()` → `prov.step_completed` + `prov.file_written` × N, `sync()` no-op,
  never touches `cortex_artifacts` (emits only), returns the file QName as `externalId` for the
  ledger cross-reference. **Correction to the research premise:** manifest entries arrive
  STEP-relative at the seam (`artifact-registration.ts:55,65`), not analysis-scoped — the adapter
  prefixes `runs/{runId}/{stepId}/` itself; verbatim pass-through would have no-op'd the
  external-id write-back and collided same-named files across steps.
- **Run-lifecycle events via Option A** (the harness change, additive): optional
  `emitProvenance?: (RunProvenanceEvent) => void` on `ExecuteAnalysisDeps`, fired guarded at all
  three run boundaries (started + both terminal sites). Harness stays tsprov-free/Bus-free; the
  cli composition maps `RunProvenanceEvent` → bus events. The `inflexa run` failure-exit paths
  were re-routed from `fail()` (bare `process.exit`, skips hooks) through `shutdown(1)` so the
  terminal provenance flush always runs.
- **Two tsprov limitations found and filed** (github.com/inflexa-ai/tsprov#3): `unified()` THROWS
  on conflicting formal `prov:startTime`/`endTime` across same-QName activity re-declarations, and
  dedups by identifier only (anonymous relations duplicate on re-emission). Both matter because
  DBOS re-executes the workflow body on recovery. Mitigated in the cli: `occurrenceTime()` keeps
  the first-observed time, and every execution-builder relation carries a deterministic identifier
  keyed on its full endpoint tuple (agent digest included). Follow-up = a `unified()` merge-policy
  option so the strict-throw is opt-out.

Live E2E (real Postgres + Docker + sandboxes, analysis `019f23b7`): happy-path run →
signed document with run/step/file records, `prov verify` valid, `cortex_artifacts.artifact_id`
= the file QName. **Detach durability proven** (the Option-A rationale): SIGKILL mid-run → run
stuck `running` → reattach + DBOS recovery re-emits the terminal event → exactly ONE run activity
survives (independently re-confirmed: a separate run replayed 4× still shows one activity, no
throw, no duplicated relation). A failed run additionally exercised the `data-run-failed` →
`run_completed(status:"failed")` + `shutdown(1)` flush path live. Gates: harness `tsc` clean +
692 tests pass; cli `typecheck` clean + 412 pass; eslint clean on all 13 touched files.

**What this unblocks:** change E (remove-custom-provenance-persistence) is now unblocked — the cli
bus adapter is the live `ArtifactRegistry` realization, so `FilesystemArtifactRegistry` has no
hypothetical consumer left. E is a separate change and deletes harness code; **this change deletes
none**. Coverage carried forward unchanged: no data-profile/ephemeral lineage (executeAnalysis-only),
bare `producer` discriminant, `ProvenanceFrame.deletes` reserved.

**Findings noted for follow-up (out of this change's scope):**
- **Embedding config-key convergence** (predicted in 06 §"origin/feat/local-embeddings"): the
  run/profile path resolves the embedder from the top-level `embedding` key
  (`modules/embedding/resolve.ts`), but `harness.embedding` is a separate key — a config carrying
  only `harness.embedding` boots to "embeddings not configured". The two keys still need folding
  into one surface. (The E2E machine's `~/.config/inflexa/config.json` was given a top-level
  `embedding` block to run; backup in the session scratchpad.)
- **`inflexa run` detach UX**: `run.ts:463` advertises "Ctrl+C detaches", but a plain SIGINT is
  swallowed by the clack spinner and the run completes in-process (observed non-TTY; interactive
  Ctrl+C unverified). The provenance durability property does not depend on this — it was proven
  via host kill, the strictly harder case — but the run-command messaging may overstate detach.
- **Harness sandbox-exec recovery wedge** (issue #28 class): a host killed after a sandbox command
  finishes but before its completion callback lands leaves the surviving sandbox retrying the dead
  host's ephemeral ingress port forever; a recovery boot reconnecting to that sandbox's
  `DBOS.recv` never unblocks. Independent of provenance.

---

## Iteration 3 (2026-07-02 16:06–16:10) — Close-out

Final coherence pass on the tracker itself: retired the iteration-1 "planned artifacts"
list (working titles that no longer match the shipped filenames), resolved the backlog
items the artifacts already answer, and left only the genuine user decisions open (see
"Open user decisions" below — they are enumerated with full context in 03 §6 and 04 §5).
No artifact-content changes were needed; 01–05 stand as written after the iteration-2
verification pass.

## Iteration 2 (2026-07-02 15:45–15:55) — Verification pass

Spot-verified the highest-stakes claims by direct read (not agent-relayed) and folded
corrections into the artifacts:

1. **Staging double-segment bug confirmed** (`staging.ts:93-95` + JSDoc `:124`).
2. **NEW bug found in staging module:** `walkFiles` comment says "symlinks are followed"
   but Dirent-based checks drop symlink entries silently — neither traversed nor staged
   (`staging.ts:68-88`). Added as a fix-during-port item in 05.
3. **Orphan-action quirk is ALL FOUR stash builders**, not two (verified in stash diff;
   strengthened in 03 §4.5).
4. **Run boundaries verified:** `data-run-started` `:324`, `data-run-completed` `:779`,
   `data-run-failed` `:797` — old docs missed the failed path; `prov.run_completed`
   must fire at both terminal sites (03 §3 updated).
5. **`ExternalRegistrationResult` shape verified** (`artifact-registry.ts:50-65`), plus
   the "MUST NOT touch cortex_artifacts" contract note that the bus adapter satisfies
   by construction (03 §5.3 updated).
6. **Barrel-gap softened:** deep imports are sanctioned per harness/CLAUDE.md ("the
   barrel is additive, not a wall"); extending the barrel is still the consistent move
   (04 §1 updated).
7. **Error-handling precision** on `stageInputs`: only unresolvable inputs are skipped;
   I/O errors fail the whole staging (05 §3 updated).

## Iteration 1 (2026-07-02 15:26–15:45) — Re-baseline after harness merge

**Status: COMPLETE** — all 4 research agents finished; all 5 artifacts written.

**Artifacts:**
- `01-provenance-cli-target.md` — the tsprov target model, storage/signing invariants,
  extension seams, spec-vs-code drift (4 items), hard constraints (i)–(v).
- `02-provenance-harness-inventory.md` — full harness+sandbox provenance inventory,
  delete-cleanly vs entangled analysis, governing specs.
- `03-provenance-migration-plan.md` — go/stay/reshape verdicts, the bus-bridge design,
  event-schema fixes (incl. 3 NEW ones: orphan-action/QName determinism, run
  activity-vs-entity double-use, actor kind), 7 migration phases, open user decisions.
- `04-file-materialization.md` — the single-placement contract, three read surfaces,
  the corrected staging wiring (old doc §6 double-segment bug), layout decision.
- `05-prior-work.md` — stash timeline + port-don't-pop verdict with drift evidence,
  staging-module relocate verdict, fixed_list draft delete verdict, old-doc corrections.

**Headline corrections to the old research (beyond the 8 findings below):**
9. `git stash pop` is impossible: stash targets the old root-src tree from a dangling
   base commit, with signing/flush API drift. Port by hand (~verbatim for the builders).
10. Old §6 wiring bug: `stageInputs` targetDir must be `{sessionTreeRoot}/data`, NOT
    `dataInputsDir()` — else `data/inputs/inputs/local/{key}`.
11. `executeAnalysis` takes NO manifest; only the data-profile trigger does.
12. No file-transfer endpoints exist at all — outputs return purely via the RW step
    mount on host disk.
13. Barrel gap: `harness/src/index.ts` exports neither `StagedInput` nor
    `triggerDataProfile` — deep-import or extend.
14. Layout ambiguity to settle: spec/prompts say `data/inputs/{fileId}/`, cli draft
    produces `data/inputs/local/{key}`; harness enforces neither.
15. `sessionsBasePath` would be per-analysis under the stash's `sessionTreeRoot` design
    — deliberate decision needed (per-analysis vs global base).

**New findings beyond the old docs (both verified with file:line by agents):**
1. cli has NO harness import anywhere — the wiring is fully greenfield.
2. `ProvActor` has no harness/agent kind; `appendAgent` throws on unknown kinds —
   actor-model growth is a REQUIRED cli change.
3. cli prov specs have drifted from code in 4 places (degrade-to-unsigned described in
   specs, never done in code; migration history; VerifyResult variants; export failure).
4. The harness workspace `ProvenanceCollector` seam (`recordSnapshot`) has NO production
   implementation — dead seam, delete freely.
5. `ProvenanceFrame.deletes` is captured by all 4 sandbox layers but has ZERO harness
   consumers — write-only telemetry today.
6. Lineage capture is executeAnalysis-steps-only: data-profile and ephemeral agents run
   without a collector.
7. Stale-comment debt: `processProvenanceFrame`, `StepMetadata.sourceRunIds`,
   `workspace-profiles.ts` references point at code that no longer exists.
8. `lib/hash.ts sha256File` in cli has zero callers — content-hash identity for
   harness artifacts is new ground on the cli side (harness already hashes everything).

**Structural facts verified so far (direct `ls`/`git`):**

- `cli/src/modules/` = `analysis, anchor, auth, infra, intelligence, project, prov` —
  the tsprov provenance module HAS been migrated into `cli/`.
- Root `src/modules/` contains ONLY `staging` — the staging module is the single
  leftover of the previous project structure. It was never ported to `cli/`.
- `harness/src/` top level: `agents, app, auth, billing, config, contracts, data,
  execution, lib, loop, memory, prompts, providers, runtime, sandbox, schemas, state,
  tasks, tools, workflows, workspace, provenance` — matches what the old docs describe.
- `stash@{0}: On feat/provenance: lmao` still exists. Suspicion (to verify): its diff
  targets the OLD root-`src/` paths, so the old checklist's "Phase 1: git stash pop"
  no longer applies cleanly — content must be transplanted into `cli/src/`.

**Stale-doc hypotheses — all four verified during the loop:**

1. ~~`git stash pop` viability~~ — confirmed broken (wrong tree, dangling base, API
   drift); port by hand. Full evidence in 05 §2.
2. ~~staging module location~~ — confirmed: untracked root-`src/` draft that cannot
   compile where it sits; relocation to `cli/src/modules/staging/` is a task (05 §3).
3. ~~harness file:line re-checks~~ — done; every citation in 01–05 is post-merge.
4. ~~Postgres provisioning~~ — confirmed shipped (PR #20, `cli/src/modules/infra`);
   no DBOS-wiring changes surfaced.

## Resolved during the loop

- [x] Stash applies to current paths? **No — manual transplant** (05 §2).
- [x] Where does cli call into harness today? **Nowhere** — zero harness imports in
      `cli/`; the embedding is fully greenfield (iteration-1 finding 1).
- [x] Sandbox hook output → tsprov mapping: settled by the bus-bridge design + event
      schema fixes in 03 §4–§5 (frames reconcile into `prov.file_written` /
      `prov.step_completed`; old Q1–Q4 decisions carried forward where still valid).

## Open user decisions (research done; needs a call, not more digging)

All argued with evidence and a recommendation where one exists:

- [ ] `ProvFileRef.producer`: bare discriminant (accept data loss) vs rich object
      (03 §4).
- [ ] Run-lifecycle emission: Option A — optional `emitProvenance` harness dep
      (recommended) vs Option B — cli emits around the trigger (03 §5).
- [ ] `ProvenanceFrame.deletes` wire arm: keep reserved vs remove (captured by all 4
      sandbox layers, zero consumers today — 02/03).
- [ ] Lineage coverage for data-profile + ephemeral agents (currently collector-less
      — 02; 03 §7 phases).
- [ ] Input layout: keep `data/inputs/local/{key}` and fix spec/prompt examples
      (recommended) vs switch to `{fileId}/` (04 §5).
- [ ] `sessionsBasePath`: per-analysis (`resolveOutputDir(analysis)`, the stash's
      implied design) vs one global base (04 §3).
