## Why

A step can be killed by bookkeeping about a file it never read. In run `19110b58`, step `T2S2`
completed its analysis — every output, figure and summary written — and then failed with
`errorClass: lineage_attestation` because `runs/<runId>/T5S1/output/_ct_for_r_BRAF.csv` was absent at
reconcile. That file was a scratch file belonging to `T5S1`, a step running concurrently in a separate
container, which created and deleted it. `T2S2` had no dependency on `T5S1` and could not have consumed it.

The crash is the lucky half. In the same run, `T4S1` recorded three of `T2S2`'s files
(`logs/run_gsea.log`, `output/wikipathways_symbols.gmt`, `scripts/run_gsea.py`) as its own inputs while
`T2S2` was still running. They survived to reconcile, hashed cleanly, and were **registered as real
lineage edges**. A survival-analysis step did not read a GSEA log. Nothing goes red; the provenance
record is simply wrong.

Two premises combine to produce this. `classifyReadPath` branch 4 turns *any* same-run path outside the
step's own directory into a mandatory, content-attested `upstream` input, justified by "a read of a
same-run step outside `dependsOn` is still a valid upstream input". And reconcile defers input hashing
to teardown because "inputs are immutable for the step — the analysis tree is mounted read-only".
Read-only bounds what *this* step writes; every sibling has its own directory mounted read-write over
the same host inodes and mutates it freely. Concurrency is normal — the scheduler starts every
dependency-satisfied step that fits the machine budget.

## What Changes

- A read under a **same-run sibling's** directory produces a lineage edge **only when that sibling is a
  declared `dependsOn`**. Any other path under `runs/{ownRunId}/` that is not the step's own tree is
  refused: no `InputRef`, no attestation target, no registered edge.
- **BREAKING (lineage completeness, not API):** an undeclared same-run sibling read that would previously
  have produced an `upstream` edge now produces none. This is deliberate under-capture — an incomplete
  lineage graph is recoverable by re-running, a fabricated one is not.
- Every refusal is logged with the read path and the producing step it names. A silent drop would rebuild
  the blind spot that made the `T4S1` half of this defect invisible.
- The step-scoped `ProvenanceCollector` is finally seeded with `dependsOn`. The `exec-provenance-lineage`
  spec already requires this; the implementation never passed it, leaving the declared-dependency branch
  unreachable. This is load-bearing here, not a tidy-up: without it every same-run read — including
  legitimate declared ones — would fall through to the refusal.
- `SandboxStepInput` carries an optional `dependsOn`. It is a durable DBOS workflow-input shape change, so
  the field is optional and its absence degrades fail-closed: an in-flight workflow recovered under the
  old shape refuses all same-run sibling edges rather than admitting them.
- The false immutability premise is corrected in the `exec-provenance-lineage` and `artifact-manifest`
  spec prose, which requirement deltas cannot reach.

**Why declaration is sufficient here, without a runtime completion check.** `scheduleReady`
(`execute-analysis-scheduler.ts`) starts a step only when `step.depends_on.every((d) => completedSet.has(d))`.
A declared dependency is therefore `completed` before the reading step starts — before it submits any exec.
And a step's tree is frozen before its status flips: `generateStepSummaryAndWrite` writes `output/summary.md`,
then reconcile, register, sync and teardown run, and only then does `mark-complete` set
`status: "completed"`. So for a declared edge, stability is guaranteed by construction and needs no
database query, no per-exec snapshot, and no replay-determinism machinery.

## Capabilities

### New Capabilities

None. This narrows the behaviour of existing capabilities; it introduces no new one.

### Modified Capabilities

- `explicit-input-classification`: `classifyReadPath` branch 4 no longer yields
  `{ source: "upstream" }` for an undeclared same-run sibling — it yields an explicit
  not-admissible outcome carrying the scraped producing-step identity for diagnostics. The branch's
  stated justification is replaced. `feedExecFrame` records only admissible reads, and
  `trackInputAccess`'s no-context fallback can now decline to track.
- `exec-provenance-lineage`: `feedExecFrame` no longer calls `trackInputAccess` for *every* read — a
  refused read is dropped and logged, and the command is still recorded with its remaining inputs. The
  requirement that the collector be seeded with `dependsOn` gains a scenario pinning it, since the
  behaviour now depends on it being real rather than declared.

## Impact

**Code**

- `harness/src/provenance/collector.ts` — `classifyReadPath` return type and branch 4; `trackInputAccess` fallback.
- `harness/src/provenance/exec-frame.ts` — skip and log refused reads.
- `harness/src/workflows/sandbox-step.ts` — optional `dependsOn` on `SandboxStepInput`; seed the collector with it.
- `harness/src/workflows/execute-analysis.ts` — populate `dependsOn` when constructing the child workflow input.
- `harness/openspec/specs/exec-provenance-lineage/spec.md`, `harness/openspec/specs/artifact-manifest/spec.md` — Purpose prose only.

**Durable state**

`SandboxStepInput` is DBOS workflow input. The added field is optional; recovery of a workflow started
under the old shape degrades to fail-closed refusal of same-run sibling edges.

**Not affected**

No sandbox image change, no Go changes, no database schema or query, no new DBOS step, no metrics
plumbing. The four-layer capture architecture is untouched — this narrows only what the harness is
willing to *assert* from a frame, not what the container observes.

**Deliberately out of scope** (tracked in issue #187): gating undeclared-but-completed siblings on a
runtime completion snapshot; gating `prior`-run reads; narrowing the inotify watch scope and dropping
bare `IN_OPEN` (needs an image rebuild and version bump); the ungated `data/` branch; reconcile's
fail-fast policy; declared-vs-observed edge labelling; narrowing the container mount itself.

Reconcile's fail-fast on a vanished input is **kept as-is on purpose**: once phantom sibling edges stop
being asserted, an `input-enoent` means a *declared* dependency's file vanished — genuine drift that
should fail loudly.
