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
