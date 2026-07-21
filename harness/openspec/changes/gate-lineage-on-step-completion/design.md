## Context

Lineage inputs are captured at runtime by the sandbox provenance layers, classified by
`classifyReadPath`, accumulated in a step-scoped `ProvenanceCollector`, and content-attested at
reconcile. An input that cannot be hashed at reconcile is treated as drift and fails the step
(`reconcile-manifest.ts:187-191`), which is the correct behaviour for a genuine input that
vanished — it prevents registering a hashless lineage edge.

Two premises in the current design make that fail-fast fire on files the step never consumed:

1. `classifyReadPath` branch 4 turns **any** path under `runs/{ownRunId}/` that is not the
   step's own directory into `{source: "upstream"}`, scraping the step id out of the path. The
   spec justifies it with "`dependsOn` drives only topo-sort ordering, not read authorization:
   a read of a same-run step outside `dependsOn` is still a valid upstream input."
2. Reconcile defers input hashing to teardown "because inputs are immutable for the step — the
   analysis tree is mounted read-only."

Premise 2 is false whenever a sibling runs concurrently. The read-only mount constrains *this*
step's writes; every other step has its own directory mounted read-write and mutates it freely,
including creating and deleting scratch files. Premise 1 then converts that churn into
mandatory attestation targets.

Concurrency is normal, not exceptional: the CLI's machine budget is a user-chosen percentage of
the host (`cli/src/modules/infra/setup.ts:729-748`) and the scheduler starts every
dependency-satisfied step that fits (`execute-analysis-scheduler.ts:206-208`). The capture scope
makes it unavoidable: `mount-plan.ts:140` sets `PROVENANCE_WATCH_DIRS` to the entire analysis
tree, so every step observes every sibling's directory.

The constraint that shapes the implementation is that `execute_command` is
`executionMode: "workflow"` (`execute-command.ts:103`) — its body runs unwrapped in the DBOS
workflow body, where a raw database read is non-deterministic across replay.

## Goals / Non-Goals

**Goals:**

- Make sibling lineage edges admissible only when the producing step actually finished, so a
  concurrently running step can never appear in another step's lineage.
- Stop fabricating edges silently. The `T4S1` case — three `T2S2` files registered as real
  inputs because they happened to survive — must become impossible, not merely rarer.
- Preserve fail-fast for genuine drift. An admissible input that vanished is still a hard
  failure; only inadmissible edges are dropped.
- Keep classification pure and unit-testable. No database access inside `classifyReadPath`.
- Keep lineage deterministic under DBOS replay: the same run must produce the same edges.

**Non-Goals:**

- Reconstructing correct lineage for already-registered runs. Detecting fabricated historical
  edges is a separate audit, tracked in tasks, not attempted inline.
- Changing the `data`, `artifacts`, or `prior` classification branches' behaviour.
- Making provenance capture exhaustive. Provenance stays best-effort and must never fail an
  exec; this change only narrows what it is allowed to *assert*.
- Replacing the capture layers. Narrowing the watch scope and fixing `IN_OPEN` reduces noise at
  the source but is not what makes the rule correct.

## Decisions

### Gate on step completion, not on `dependsOn`

`dependsOn` is a scheduling input: it says what must finish before a step may *start*, and the
current spec explicitly declines to treat it as read authorization. That reasoning is sound — a
step may legitimately read a sibling it did not declare — so tightening the gate to "must be in
`dependsOn`" would break real lineage.

Completion is the causally correct predicate instead. If Y has not completed, Y's directory
contains work in progress, and nothing X observed there is a stable artifact X can be said to
have consumed. This subsumes the parallel case without a separate rule: a step running
concurrently with X is by definition not completed, so it cannot contribute an edge.

`completed` is the only admissible status. `failed`, `canceled`, and `skipped` are terminal but
their outputs were never finalized — that is exactly what a `lineage_attestation` failure means
— so treating them as admissible would let one step's unfinalized output become another's
attested input.

`dependsOn` is still threaded into the collector, as `exec-provenance-lineage` already requires
and the implementation never honoured (`sandbox-step.ts:380-383` passes only `stepId`/`runId`,
leaving the declared-dependency branch dead code). It no longer gates admissibility; it earns
its place by letting diagnostics distinguish a declared edge from an observed one.

### Snapshot admissibility before the exec, not at reconcile

Reconcile is the wrong moment. It runs after sandbox teardown, so a sibling that was mid-flight
*while the file was read* may have completed by then, and the edge would pass — registering
precisely the fabricated lineage this change exists to prevent. The `T4S1` case would still slip
through a reconcile-time check.

The snapshot is therefore taken **before the exec is submitted**, and submit time — not start
time — is the normative predicate. Submission precedes start, so a set observed at submit is a
subset of what is completed at start; the rule is deliberately stricter than the causal minimum,
and the strictness is the point. Completion is monotonic, so a step observed `completed` at
submit time was necessarily completed before any read that exec performs. The converse is deliberately conservative: a sibling that completes *during* the exec
is treated as inadmissible for that exec, because we cannot tell whether the read landed before
or after its final write. Dropping a marginal edge is strictly better than registering a racy
one, and the drop is logged so the choice is visible rather than silent.

The snapshot is per-exec, not per-step, so a long-running step naturally picks up siblings that
completed since its previous command.

Alternative considered: timestamp comparison, using the frame's per-read times against each
sibling's `completed_at`. Rejected — it buys precision we cannot trust, since the read timestamps
come from capture layers whose clocks and ordering are not guaranteed to agree with the
database's, and it would make the rule depend on the least reliable field in the pipeline.

### Take the snapshot inside `ctx.runStep`

`execute_command` declares `executionMode: "workflow"`, so its body is *not* wrapped in a
durable step; it runs directly in the DBOS workflow body. A bare `queryStepsByRun` there would
re-execute on every replay and return whatever the table says at replay time — a strictly larger
completed-set than the original execution saw. The same run would then produce different lineage
on recovery, which breaks both determinism and the audit value of the record.

The snapshot must therefore go through `ctx.runStep`, which checkpoints the result so replay
returns the original answer. The house rule from `lib/result.ts` applies at that boundary: a
`Result` error crossing a DBOS step must throw (`unwrapOrThrow`), or the step is durably cached
as a success and replayed as one forever.

### Inadmissible reads are dropped, not fatal

An inadmissible read is noise, not drift — the step observed activity it did not consume. The
codebase already has the precedent and the mechanism: out-of-tree reads (`reconcile-manifest.ts:169-181`)
and directory reads (`196-206`) both call `collector.dropInput` and continue. Inadmissible
sibling reads join them.

The drop happens at classification, before the ref enters the collector, so the inadmissible
path never becomes an attestation target in the first place. `classifyReadPath` stays pure: it
receives the completed-step set as an argument and returns an explicit "not an admissible edge"
outcome, which `feedExecFrame` honours by not calling `trackInputAccess`.

### Observability is part of the contract

Every rejection logs through the injected `Logger` seam with the ref path, the scraped step id,
and that step's observed status, and increments a new `lineageEdgeRejected` counter
(`cortex.lineage.edge_rejected`) with a `reason`.

The counter is deliberately separate from reconcile's `lineageInputDropped`, which is registered
as `cortex.artifact.reconcile.input_dropped` (`src/lib/metrics.ts:19`). Reusing it would mean a
counter named for a reconcile-time drop firing from classification, which makes both the metric
and any dashboard built on it lie about where the loss happened.

This is not decoration: the failure that motivated this change was diagnosable only because a previous
fix routed `lineage_attestation` through the Logger, and the silent half of the bug (`T4S1`) is
invisible precisely because nothing recorded the fabricated edges. A silent drop would rebuild
the same blind spot one layer down.

### Watch the immutable set, not the declared set

The criterion for what to inotify-watch is **immutability**, not declaration. A step that has
completed will never write again, so its directory cannot churn — watching it is free, and any
read of it is admissible under the completion gate anyway. A *running* sibling's directory is
the only thing that churns, and that is precisely what caused this defect.

`PROVENANCE_WATCH_DIRS` therefore enumerates `data/`, the step's own tree, and the tree of every
sibling of the same run that is `completed` at sandbox creation. `dependsOn` is not the
criterion: the scheduler already guarantees declared dependencies completed before the step
starts, so they are a strict subset of that set.

Scoping to `dependsOn` instead was considered and rejected — it would exclude completed
non-declared siblings, which classification admits, so the capture layer and the admissibility
rule would have contradicted each other and made a whole class of legitimate edge unreachable.
Using the same immutability criterion in both places keeps one concept with two enforcement
points.

Known limitation, stated rather than implied: the watcher walks once at container start and
never re-walks, so a sibling that completes *after* this sandbox was created is not
inotify-watched. That is under-capture, conservative in the same direction as the gate, and the
in-process hooks still cover it (below).

### Decouple the hook prefixes from the watch dirs

`PROVENANCE_DATA_PREFIXES` and `PROVENANCE_WATCH_DIRS` are derived from the same value today
(`provenance.go:198-199`), which forces the hooks to inherit whatever narrowing inotify needs.
They should be independent, because the two layers have fundamentally different exposure.

The Python audit hook, the R hooks, and the `provtrack.c` LD_PRELOAD interposer observe only
**their own process's** opens. They cannot see another container's writes at all, so they were
never a source of sibling contamination. Only inotify watches the shared filesystem, and only
inotify needs the narrow scope.

So the hook prefixes stay at the analysis mount root while the watch dirs narrow. A legitimate
cross-step or prior-run read performed by the command *itself* therefore stays capturable even
when the path is not inotify-watched — which is what keeps the previous decision's
under-capture from becoming a real lineage gap.

### Snapshot failure fails closed, loudly, and durably

If the completed-step query fails, three things must hold at once. The exec must not die —
provenance is best-effort and failing an exec over bookkeeping is the exact failure mode this
change exists to remove. The result must not be silent — a quiet empty set would drop every
sibling edge with no record, rebuilding the blind spot one layer down. And the outcome must be
deterministic under replay.

The durable step therefore resolves to an explicit "snapshot unavailable" outcome rather than
throwing. All same-run sibling reads for that exec become inadmissible, the unavailability is
logged at error level and counted under its own reason, and the step completes.

The subtle part is that the *degradation itself* must be checkpointed. If only the success path
were durable, a replay could re-run the query, succeed where the original failed, and produce a
different lineage graph for the same run — the same determinism hazard as the unwrapped query,
arriving through the error path instead.

### One predicate for every producing step, whatever run it belongs to

The defect generalizes from steps to runs: nothing stops a second run over the same workspace
from being in flight, and a `prior` read of its directory reproduces this bug across runs
instead of within one. The `prior` branch is currently ungated, and reconcile treats `prior`
reads as attestable, so both the crash and the fabricated-edge case recur there.

Gating `prior` on "the referenced **run** is terminal" was the obvious move and is the wrong
one. `cortex_runs` counts `partial`, `failed`, and `canceled` as terminal (`runs.ts:121`), so
that rule would admit a *failed* step inside a finished run — whose outputs were never
finalized, which is exactly what the sibling rule exists to reject. It also introduces a second
predicate, and a second table, for what is really the same question.

The predicate is therefore uniform across branches 3, 4, and 5: **the producing step is
`completed`**. Which run it belongs to is irrelevant — what makes an artifact stable is that the
step that writes it has finished, not that its run has. A prior run's completed step qualifies;
a prior run's failed step does not; a concurrent sibling does not.

That collapses two rules into one and two queries into one. The snapshot becomes a set of
`(runId, stepId)` pairs for the analysis, which `cortex_step_executions` already indexes by
`analysis_id` (`state/init.ts:102-103`), so the wider scope costs nothing and `cortex_runs` is
not consulted at all.

### Stop treating a bare `IN_OPEN` as a read

`classifyInotifyMask` (`provenance_inotify_linux.go:145-153`) returns `"read"` for everything
that is not CREATE/DELETE/MOVE, and the watch mask includes `IN_OPEN`. `IN_OPEN` fires on opens
for *writing* and on opens by processes unrelated to the command, so it cannot on its own mean
"this command consumed this file". The mode-aware Python, R, and C hooks already classify by
open mode and remain the authoritative read signal; inotify's role is verification.

## Risks / Trade-offs

**A legitimate edge is dropped when a sibling completes mid-exec** → The read is dropped and
logged with the sibling's observed status, so the gap is visible and attributable rather than
silent. The step's next exec sees the sibling as completed. Accepted deliberately: an
under-reported edge is a recoverable gap, a fabricated edge is a corrupt record.

**Narrowing the watch scope hides genuinely useful reads** → Declared upstream directories stay
in scope, so ordinary dependency reads are unaffected. Reads outside that scope were already
inadmissible under the new rule, so nothing that would have survived classification is lost.

**Harness and sandbox image ship on different cadences** → The change is sequenced so the
harness-side rule is independently sufficient for the reported failure and requires no image
rebuild. The Go changes are additive noise reduction and can land in a later image version
without leaving a window where lineage is wrong.

**A per-exec database read adds latency** → The query is a prefix scan on the
`(run_id, step_id)` primary key, measured against exec durations of seconds to minutes. The
`ctx.runStep` wrapper also makes it a cached step on replay rather than a repeated query.

**Historical lineage is already corrupted** → Not fixable in this change and not pretended
otherwise. Fabricated edges from before this change are indistinguishable from real ones by
inspection, so an audit pass is called out explicitly in tasks rather than left implicit.

**Seeding `dependsOn` changes a durable workflow input shape** → `SandboxStepInput` has no
`dependsOn` field today (verified: the identifier appears nowhere in `sandbox-step.ts`), so the
parent must thread it through DBOS workflow input. Workflows already in flight were persisted
without the field, so it must be optional at the type level and absence must degrade to the same
fail-closed posture as an unavailable snapshot — never to "declared nothing, so everything is a
plain sibling".

**`buildMountPlan` is pure today and now needs to know which siblings completed** → It takes
coordinates and stores, with no database access. The completed-sibling list must be resolved by
the caller and passed in, keeping the mount plan a pure function of its inputs rather than
growing a query. Otherwise sandbox creation acquires a hidden I/O dependency that its tests
cannot express.

## Migration Plan

1. **Harness-only (fixes the reported failure).** Admissibility rule, `dependsOn` seeding,
   drop-and-log path, metric reason, and tests. No sandbox image rebuild required, so this can
   ship on the harness's own cadence.
2. **Sandbox image.** Narrowed `PROVENANCE_WATCH_DIRS` and the `IN_OPEN` classification fix,
   with a `sandbox-base` rebuild and version bump.
3. **Audit.** Survey registered lineage edges for sibling edges that could not have been
   admissible, using each step's recorded completion time against the reading step's window.

Rollback is per-phase and independent: phase 1 reverts to the previous classification behaviour
without touching the image, and phase 2 reverts to the previous watch scope without touching the
rule.

## Open Questions

- **Should an inadmissible read be retained as a non-attested observation** (visible for
  debugging, excluded from the registered lineage graph) rather than dropped outright? This
  would preserve evidence of cross-step interference without asserting an edge, at the cost of a
  second class of ref the registration translator must understand.
