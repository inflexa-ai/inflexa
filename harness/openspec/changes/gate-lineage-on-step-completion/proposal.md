## Why

A step currently records a **concurrently running** sibling step's files as mandatory,
content-attested `upstream` lineage inputs. When that sibling deletes the file — a scratch
file it never meant to publish — the reading step's reconcile ENOENTs and kills the step with
`errorClass: lineage_attestation`, after the science has already completed successfully.

This is not hypothetical. In run `19110b58`, step `T2S2` (enrichment) died attesting
`runs/<runId>/T5S1/output/_ct_for_r_BRAF.csv` — a scratch file belonging to `T5S1`, the
statistical-modeling step, which was running at the same time. The failure is symmetric:
`T5S1` was simultaneously failing to attest `T2S2/output/gseapy_hallmark`. Two steps each
claimed the other's outputs as inputs, which is not a DAG.

The crash is the *lucky* case. In the same run, `T4S1` recorded three `T2S2` files
(`logs/run_gsea.log`, `output/wikipathways_symbols.gmt`, `scripts/run_gsea.py`) as its inputs
while `T2S2` was still running. Those files happened to survive to reconcile, hashed cleanly,
and were **registered as real lineage edges**. A survival-analysis step did not read a GSEA
log. Silent provenance corruption is the worse half of this defect, and it is invisible today.

The root premise is wrong. `classifyReadPath` branch 4 is justified in the spec by "a read of
a same-run step outside `dependsOn` is still a valid upstream input", and reconcile defers
input hashing on the grounds that "inputs are immutable for the step — the analysis tree is
mounted read-only". Read-only describes *this* step's write capability. A concurrent sibling
has its own directory mounted read-write and mutates it freely, so the tree is shared mutable
state for exactly the paths that branch marks as attestable inputs.

## What Changes

- **BREAKING (lineage semantics)**: an input edge from step X to a sibling step Y in the same
  run is admissible **iff Y's `cortex_step_executions.status` was `completed` at the moment
  X's exec started**. Y running, queued, failed, canceled, skipped, blocked, or absent means
  there is no lineage relationship — the read is dropped from lineage, never fatal. Two steps
  running in parallel therefore have no lineage relationship to each other, which falls out of
  the same predicate rather than needing its own rule.
- `completed` is the only admissible status. A failed or canceled step's outputs were never
  finalized (that is precisely what the `lineage_attestation` failure means), so they must
  never become another step's attested input.
- The admissibility snapshot is taken **before the exec is submitted**, not at reconcile.
  Reconcile runs after teardown, by which time a sibling that was mid-flight *during* the read
  may have completed and the edge would wrongly pass. Completion is monotonic, so a step
  `completed` at submit time was necessarily completed before any read that exec performs —
  conservative in the safe direction.
- `classifyReadPath` gains an explicit "not an admissible edge" outcome so `feedExecFrame`
  drops the read rather than tracking it. The function stays pure and unit-testable; the
  completed-set is passed in, not queried inside.
- The step-scoped `ProvenanceCollector` is finally seeded with `dependsOn`, which the
  `exec-provenance-lineage` spec already requires and the implementation never did. Under the
  new rule `dependsOn` is no longer the admissibility gate; it is retained to distinguish a
  *declared* edge from an *observed* one in diagnostics.
- The predicate is uniform across same-run siblings and earlier runs alike: **the producing step
  is `completed`**. Which run it belongs to is irrelevant — an artifact is stable because the
  step writing it finished, not because its run did. This closes the same hole in `prior`-run
  reads, where a second in-flight run over one workspace reproduces the defect across runs.
  Gating `prior` on the *run* being terminal was rejected: `cortex_runs` treats `partial`,
  `failed`, and `canceled` as terminal, so it would admit a failed step's unfinalized outputs.
- If the completed-step snapshot cannot be taken, the exec still succeeds but every same-run
  sibling read for it becomes inadmissible — fail closed, logged at error level, and counted.
  The degraded outcome is itself checkpointed so a replay cannot succeed where the original
  failed and produce different lineage.
- Provenance capture is narrowed at the source, on an **immutability** criterion rather than a
  declaration one: `PROVENANCE_WATCH_DIRS` stops being the whole analysis tree and becomes
  `data/`, the step's own directory, and the directory of every sibling already `completed` at
  sandbox creation. A completed step never writes again, so watching it cannot produce churn;
  only a running sibling can, and it is never watched.
- `PROVENANCE_DATA_PREFIXES` is decoupled from `PROVENANCE_WATCH_DIRS`. The in-container hooks
  observe only their own process's opens and were never a contamination source, so their prefix
  filter stays broad while inotify — the one layer that sees the shared filesystem — narrows.
- The inotify layer stops classifying every non-CREATE/DELETE/MOVE event as a read. `IN_OPEN`
  fires on opens for writing and on opens by unrelated processes, so it cannot by itself mean
  "this command consumed this file as input".
- Every rejected edge is logged through the injected `Logger` seam (ref path, scraped step id,
  that step's observed status) and counted on a **new** `lineageEdgeRejected` counter with a
  `reason`. It is deliberately separate from reconcile's `lineageInputDropped`, which is named
  for a reconcile-time drop and keeps only its three existing reasons. A silent drop would hide
  exactly the class of bug this change exists to fix.

## Capabilities

### New Capabilities

None. This change corrects the requirements of existing capabilities; it introduces no new
capability surface.

### Modified Capabilities

- `explicit-input-classification`: branch 4 of `classifyReadPath` becomes completion-gated
  rather than unconditional, its stated justification is replaced, and the
  "Same-run sibling outside dependsOn classified as upstream" scenario is inverted. The
  `feedExecFrame` requirement gains the completed-step set and the drop behaviour.
- `exec-provenance-lineage`: the false "inputs are immutable for the step" premise is replaced
  with an accurate statement of what the read-only mount does and does not guarantee, and the
  completion-gated admissibility rule is added as a requirement.
- `artifact-manifest`: the reconcile rules gain the distinction between an inadmissible edge
  (dropped) and genuine drift on an admissible edge (still fatal, unchanged).
- `sandbox-provenance-tracking`: `PROVENANCE_WATCH_DIRS` is narrowed from the analysis resource
  mount root to the immutable set (data, own tree, completed siblings); `PROVENANCE_DATA_PREFIXES`
  is decoupled from it and stays broad; the inotify read classification stops treating a bare
  `IN_OPEN` as evidence of a read; and exhaustion of the pre-existing 1000-watch budget becomes
  observable to the harness instead of only an in-container log line.

## Impact

**Harness (TypeScript)**
- `src/provenance/collector.ts` — `classifyReadPath` branch 4; inadmissible outcome.
- `src/provenance/exec-frame.ts` — `feedExecFrame` carries the completed-step set and drops
  inadmissible reads.
- `src/tools/workspace/execute-command.ts` — snapshots the completed-step set. This tool is
  `executionMode: "workflow"`, so it runs unwrapped in the DBOS workflow body: the snapshot
  **must** be taken inside `ctx.runStep` or it re-executes on replay and can return a different
  answer, producing different lineage for the same run.
- `src/workflows/sandbox-step.ts` — seed the collector with `dependsOn`.
- `src/state/step-executions.ts` — a narrow query for the run's completed step ids.
- `src/sandbox/mount-plan.ts` — narrowed `PROVENANCE_WATCH_DIRS`, computed from a
  completed-sibling list the caller resolves and passes in so the plan stays a pure function.
- `src/lib/metrics.ts` — new `lineageEdgeRejected` counter.
- `SandboxStepInput` (`src/workflows/sandbox-step.ts`) — gains `dependsOn`. This is a **durable
  DBOS workflow input shape change**: workflows persisted before it must still recover, so the
  field is optional and its absence degrades fail-closed.

**Sandbox image (Go)**
- `images/sandbox-base/server/provenance_inotify_linux.go` — read classification.

**Data already written**
Lineage edges registered before this change may contain fabricated sibling edges of the
`T4S1` kind. They are indistinguishable from real edges by inspection alone, so an audit pass
over registered inputs is in scope for follow-up and is called out in tasks rather than
silently ignored.

**Not affected**
The `data`, `artifacts`, and `prior` classification branches keep their current behaviour, and
genuine drift on an admissible input stays fatal.
