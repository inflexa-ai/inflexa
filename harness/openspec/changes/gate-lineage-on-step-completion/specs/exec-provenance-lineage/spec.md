# exec-provenance-lineage Specification

## MODIFIED Requirements

### Requirement: Each exec frame is threaded into the step-scoped collector

The sandbox-step body SHALL construct one `ProvenanceCollector` per step, seeded
with the step's `stepId`, `runId`, and `dependsOn`. Seeding is not optional: a
construction site that passes only `stepId` and `runId` SHALL NOT be conformant,
because the declared-dependency classification branch is then unreachable and
every declared upstream read is indistinguishable from an undeclared sibling
read. `dependsOn` no longer gates admissibility (see "A sibling lineage edge
requires the producing step to have completed"); it is seeded so diagnostics can
tell a *declared* edge from a merely *observed* one.

The frame-threading path SHALL additionally supply the set of `(runId, stepId)`
pairs observed `completed` at the moment the exec was **submitted** — submit is
the normative instant throughout this capability — and SHALL pass that set into
classification: `classifyReadPath` SHALL be called with the step's `stepId`,
`runId`, `dependsOn`, **and** that completed-step set. The set SHALL be scoped to
the **analysis**, not to the step's own run, so that a read of an earlier run's
step is decided by the same set and the same predicate as a same-run sibling; it
SHALL be the only admissibility input, with no second run-level parameter beside
it. The snapshot SHALL be taken per exec, at submit, and SHALL be checkpointed
durably, so a DBOS replay classifies against the set the original execution saw
rather than a larger one read at replay time.

The snapshot SHALL be a SINGLE query over `cortex_step_executions` scoped by
`analysis_id`, which that table already indexes, so the analysis-wide scope costs
no additional query and no additional index. `cortex_runs` SHALL NOT be consulted
by this capability at all: run state answers no question the gate asks.

When the completed-step query fails, the frame-threading path SHALL receive an
explicit "snapshot unavailable" outcome rather than a thrown error, and that
degraded outcome SHALL be checkpointed durably exactly as a successful snapshot
is, so replay reproduces the degradation rather than succeeding where the
original execution failed (see "A sibling lineage edge requires the producing
step to have completed").

After each `execute_command` resolves its `ExecResult`, the workspace
`execute_command` tool SHALL feed that result's `provenance` frame into the
collector via `feedExecFrame` (`src/provenance/exec-frame.ts`). `feedExecFrame`
SHALL strip the `/{resourceId}/` mount prefix from each frame path — collapsing
separators doubled at the boundary so an in-mount name lands on its canonical
relative form — classify every read via `classifyReadPath`, call
`trackInputAccess` per admissible read, and call `recordCommandExecution` once
per exec with that exec's own reads scoped to its outputs. A read that
classification reports as inadmissible SHALL NOT reach `trackInputAccess`: it is
dropped at classification, so it never becomes an attestation target. A frame
path that does not lie under the mount SHALL ride onto its `InputRef` verbatim,
never with the mount root prepended: forging an in-tree name for a foreign path
would surface at reconcile as phantom drift (a missing file, which fails the
step) instead of the out-of-tree read it is (which reconcile drops from
lineage). Read hashes SHALL be left unset at track time and filled from disk by
`reconcileManifestWithDisk` before registration. When the frame is absent or
`disabled`, `feedExecFrame` SHALL record the command with no inputs and no
writes rather than throw.

#### Scenario: Command reading an input and writing an output produces a lineage edge

- **GIVEN** an `execute_command` whose argv is `["python3", "scripts/tmm.py"]` and whose `ExecResult.provenance` reads `/{rid}/data/inputs/Lab/counts.csv` and writes `/{rid}/runs/{run}/{step}/output/tmm.csv`
- **WHEN** the tool feeds the frame via `feedExecFrame`
- **THEN** `getRecords()` contains a record for `output/tmm.csv` with `producer.type: "command"`, an inferred `scriptPath: "scripts/tmm.py"`, and an input with `source: "data"` for `data/inputs/Lab/counts.csv`

#### Scenario: The collector is seeded with the step's declared dependencies

- **WHEN** the sandbox-step body constructs the step's `ProvenanceCollector`
- **THEN** it passes the step's `dependsOn` alongside `stepId` and `runId`, so the declared-dependency branch of `classifyReadPath` is reachable at runtime and a declared edge is distinguishable from an observed one in the drop diagnostics

#### Scenario: Upstream read is classified by step metadata

- **GIVEN** step `de` in run `run-002` with `dependsOn: ["qc"]`, `qc` observed `completed` at exec-submit time, and an exec whose frame reads `/{rid}/runs/run-002/qc/output/qc.csv`
- **WHEN** the read is classified and tracked
- **THEN** the resulting `InputRef` has `source: "upstream"`, `stepId: "qc"`, `runId: "run-002"`

#### Scenario: The completed-step snapshot reaches classification

- **GIVEN** an exec in run `run-002` submitted while `qc` is `completed`, `norm` is `running`, and step `qc` of the earlier run `run-001` is `completed`
- **WHEN** the tool feeds the resulting frame via `feedExecFrame`
- **THEN** `classifyReadPath` is called for every read with the snapshot taken at submit time — `(run-002, qc)` and `(run-001, qc)` present, `(run-002, norm)` absent — not with an empty set, and not with a set re-read after teardown
- **AND** the set spans the analysis, so no separate run-level lookup is made for the `run-001` read

#### Scenario: An inadmissible read never enters the collector

- **GIVEN** step `de` in run `run-002` whose frame reports a read of `/{rid}/runs/run-002/norm/output/_scratch.csv` while `norm` is absent from the completed-step snapshot
- **WHEN** the tool feeds the frame via `feedExecFrame`
- **THEN** `trackInputAccess` is NOT called for that path, no `InputRef` exists for it, and `reconcileManifestWithDisk` never stats or hashes it

#### Scenario: A read outside the mount keeps its own name

- **GIVEN** an exec whose frame reports a read of `/etc/passwd` — naming nothing under the mount, a path the hooks should have filtered
- **WHEN** the tool feeds the frame via `feedExecFrame`
- **THEN** the tracked `InputRef` carries `path: "/etc/passwd"` verbatim, and `reconcileManifestWithDisk` later drops it at the container-prefix bound rather than failing the step

#### Scenario: Missing or disabled frame degrades to no inputs

- **GIVEN** an `ExecResult` whose `provenance` is absent or has `disabled: true`
- **WHEN** the tool feeds it via `feedExecFrame`
- **THEN** the command is recorded with an empty `inputs` array and no error is thrown

### Requirement: Sandbox provenance capture is scoped to the analysis resource mount

`buildMountPlan` SHALL set the container's `PROVENANCE_WATCH_DIRS` to the step's
own run tree alone — `/{resourceId}/runs/{runId}/{stepId}` — and SHALL leave it
empty when the mount plan emits no read-write step mount (a read-only sandbox),
which writes nowhere. It SHALL NOT be set to the analysis resource mount root
(`/{resourceId}`), to the `data/` tree, or to any sibling step's tree.

The criterion is **what this exec mutates**, not what it may read. inotify
reports only creations, deletions, and moves — a bare `IN_OPEN` may not be
reported as a read (see the sandbox-provenance-tracking spec) — and the only tree
this exec writes is its own. `data/` is staged before the run and frozen for its
duration; a completed sibling is immutable by this capability's own completion
gate. Neither can emit a create, delete, or move while this step runs, so
watching them would register watches that structurally cannot fire.

Exclusion from the watch set SHALL NOT be read as inadmissibility. A completed
sibling's outputs remain a perfectly admissible lineage input; they are simply
not something inotify has anything to say about. Capture scope and admissibility
answer different questions, and this requirement answers only the first.

Narrowing SHALL NOT cost a read edge, because reads do not come from inotify at
all. That is what makes the scope safe to shrink, and it holds only because the
layer prefixes are configured separately (below).

Excluding `data/` also removes the only **unbounded** term from the walk.
`data/` is user-staged and its directory count follows the shape of the input
dataset, as does a sibling's output tree whenever a step writes per-entity
directories. Neither is bounded by anything the harness controls, and the walk is
a startup cost paid before the child process spawns. What remains is bounded by
what this step itself created.

`PROVENANCE_DATA_PREFIXES` SHALL be configured **independently** of
`PROVENANCE_WATCH_DIRS`, and SHALL NOT be derived from it. The in-container
hooks — the Python audit hook, the R hooks, and the `LD_PRELOAD` `provtrack.c`
interposer — intercept only **their own process's** opens: they are an
`LD_PRELOAD` interposer and interpreter-level hooks, so they physically cannot
observe another container's writes, and they need no narrowing to be safe. Their
prefix filter MAY therefore remain the analysis resource mount root
(`/{resourceId}`). Only inotify observes the shared filesystem, so only inotify
needs the narrow scope.

The consequence is deliberate: a legitimate cross-step or prior-run read
performed by the command **itself** stays capturable via the hooks even when the
path is not inotify-watched. Whether such a read becomes a lineage edge is
decided by classification, not by capture scope (see "A sibling lineage edge
requires the producing step to have completed"). Narrowing the watch scope is
noise reduction at the capture layer, not the correctness rule. Reads and writes
outside the configured prefixes (system libraries, `/mnt/libs`, interpreter
internals) SHALL NOT appear in the frame.

#### Scenario: Input read under the resource mount is captured

- **GIVEN** an analysis mounted at `/{resourceId}` and a sandbox whose watch dirs do NOT include `/{resourceId}/data`
- **WHEN** a script reads `/{resourceId}/data/inputs/Lab/counts.csv`
- **THEN** the exec frame's `reads` includes that path, because the hook that intercepted the open filters on the mount-root prefix rather than on the watch dirs

#### Scenario: Library read is not captured

- **GIVEN** the same sandbox
- **WHEN** a script imports a package from `/mnt/libs`
- **THEN** the exec frame's `reads` does NOT include any `/mnt/libs` path

#### Scenario: No tree but the step's own is watched

- **GIVEN** step `T4S1` of run `run-002` with `dependsOn: ["qc"]`, a sibling `qc` that is `completed`, and a sibling `T2S2` that is `running` when `T4S1`'s sandbox is created
- **WHEN** `buildMountPlan` composes the sandbox for `T4S1`
- **THEN** `PROVENANCE_WATCH_DIRS` is exactly `/{resourceId}/runs/run-002/T4S1`, containing neither `/{resourceId}/data`, nor either sibling's tree, nor the mount root `/{resourceId}`
- **AND** `T2S2` creating and deleting `output/_ct_for_r_BRAF.csv` while `T4S1` runs produces no entry in any `T4S1` exec frame

#### Scenario: A completed non-declared sibling is unwatched yet admissible

- **GIVEN** step `de` of run `run-002` with `dependsOn: ["qc"]`, and a sibling `norm` that is NOT in `de`'s `dependsOn` but whose status is `completed` when `de`'s exec is submitted
- **WHEN** `de` reads `/{resourceId}/runs/run-002/norm/output/norm.csv` and a hook intercepts the open
- **THEN** `PROVENANCE_WATCH_DIRS` does NOT contain `/{resourceId}/runs/run-002/norm`, yet the read still appears in the exec frame and classification admits it as `source: "upstream"`
- **AND** capture scope did not decide admissibility — being unwatched costs the edge nothing, because inotify was never the source of reads

#### Scenario: Admissibility tracks each exec's submit time, not sandbox creation

- **GIVEN** step `de` whose sandbox was created while sibling `norm` was still `running`, and `norm` reaching `completed` before `de` submits a later exec
- **WHEN** that later exec's command opens `/{resourceId}/runs/run-002/norm/output/norm.csv`
- **THEN** the read is admissible, because each exec snapshots the completed set at its own submit time rather than inheriting one fixed at sandbox creation
- **AND** the same read performed by an earlier exec, submitted while `norm` was still running, is rejected — the sandbox is shared but the snapshot is per-exec

## ADDED Requirements

### Requirement: A sibling lineage edge requires the producing step to have completed

An input edge from step X to a producing step Y SHALL be admissible if and only
if Y's `cortex_step_executions.status` was `completed` at the moment X's exec was
**submitted** — regardless of which run Y belongs to. Submit time is the normative predicate
throughout this capability — every statement of the gate SHALL be expressed
against it, and no other instant (start, first read, teardown, reconcile) SHALL
be used. Submit necessarily precedes the exec's start, so gating on the
submit-time set is deliberately **stricter** than gating on the set as of start
time: a sibling that reaches `completed` in the window between submit and start
is inadmissible for that exec. That stricter reading is intentional — it costs
at most one exec before the sibling becomes admissible, and it keeps the rule
anchored to an instant the harness actually observes rather than one it would
have to infer.

The snapshot SHALL NOT be taken at reconcile: reconcile runs after sandbox
teardown, by which time a sibling that was mid-flight *while the file was read*
has often reached `completed`, and the edge would wrongly pass. Completion is
monotonic, so a step observed `completed` at submit time was necessarily
completed before any read that exec performs; the converse is deliberately
conservative — a sibling that completes *during* the exec SHALL be treated as
inadmissible for that exec, because nothing distinguishes a read that landed
before its final write from one that landed after.

`completed` SHALL be the only admissible status. `running`, `pending`/`queued`,
`failed`, `canceled`, `skipped`, `blocked`, and the absence of any row for Y
SHALL all be inadmissible: a step that did not complete never finalized its
outputs, so nothing under its directory is a stable artifact another step can be
said to have consumed — and a step that failed attestation is precisely a step
whose outputs are not attestable. Two steps executing concurrently SHALL
therefore have no lineage relationship to each other in either direction; this
falls out of the same predicate rather than needing a separate rule.

`dependsOn` SHALL NOT be the admissibility gate. A declared dependency observed
in a non-`completed` state is inadmissible, and a completed sibling outside
`dependsOn` is admissible.

A `prior`-run edge SHALL be gated by the SAME predicate, applied to the same
table, with no run-level notion anywhere in it: a read classified as `prior` —
naming a run other than the step's own — SHALL be admissible if and only if the
producing step it names was `completed` at X's submit time. What makes an
artifact stable is that the step which wrote it finished, not that its run
finished. A prior run's completed step is therefore admissible; a prior run's
failed step is NOT, even though its run has ended; and a step of a concurrent
run is not. The failure mode this closes is the sibling case one level out —
nothing stops two runs over one workspace from interleaving — but it is closed
by the same rule rather than a parallel one.

The state of the referenced **run** SHALL NOT enter this decision, and
`cortex_runs` SHALL NOT be consulted by this gate at all. A run that has ended
does not finalize the outputs of a step inside it that failed, so a run-level
predicate would admit precisely the unfinalized bytes the step-level rule exists
to reject — and would answer one question with two predicates over two tables.

If the completed-step query fails, the durable step SHALL resolve to an explicit
"snapshot unavailable" outcome rather than throwing. Throwing would fail the
exec, and provenance SHALL never fail an exec. Under that outcome **every** read
naming a producing step for that exec — a same-run sibling and another run's step
alike — SHALL be inadmissible: the gate fails **closed**, because an unknown
status is not a completed one. The unavailability
SHALL be logged at error level and counted with its own `reason`. The degraded
outcome SHALL itself be checkpointed durably, so a DBOS replay classifies
identically instead of succeeding where the original execution failed —
otherwise the same run would register on replay exactly the edges the failure
suppressed.

An inadmissible read SHALL be dropped from lineage — never tracked as an input,
never content-attested, never registered as an edge — and SHALL NOT fail the
step. Every rejection SHALL be logged through the injected `Logger` seam with
the ref path, the step id scraped from the path, and that step's observed
status, and SHALL increment a **new** counter `lineageEdgeRejected`
(`cortex.lineage.edge_rejected`), tagged `agent_id`, `step_id`, and `reason`,
where `reason` is one of exactly two values: `producing-step-not-completed` —
carried by a same-run sibling and a prior-run step alike, since one rule rejected
both — or `snapshot-unavailable`. It SHALL NOT increment `lineageInputDropped`
(`cortex.artifact.reconcile.input_dropped`): that counter belongs to reconcile
and keeps only its existing reasons, so the two remain separately attributable.
A silent drop SHALL NOT be acceptable: the fabricated-edge half of this defect
is invisible exactly because nothing recorded it.

Genuine drift on an **admissible** input remains fatal and unchanged: an
admissible input file that cannot be hashed at reconcile SHALL still fail the
step rather than register a hashless lineage edge.

#### Scenario: A completed sibling's file is admitted as upstream

- **GIVEN** step `de` in run `run-002` and step `norm`, whose `cortex_step_executions.status` was `completed` when `de`'s exec was submitted
- **WHEN** `de`'s frame reports a read of `runs/run-002/norm/output/norm.csv`
- **THEN** the read is tracked with `source: "upstream"`, `stepId: "norm"`, `runId: "run-002"`, is content-attested at reconcile, and registers as a lineage edge — whether or not `norm` is in `de`'s `dependsOn`

#### Scenario: A running sibling's file is dropped

- **GIVEN** step `T4S1` in run `19110b58` and step `T2S2`, whose status was `running` when `T4S1`'s exec was submitted
- **WHEN** `T4S1`'s frame reports reads of `runs/19110b58/T2S2/logs/run_gsea.log`, `runs/19110b58/T2S2/output/wikipathways_symbols.gmt`, and `runs/19110b58/T2S2/scripts/run_gsea.py`
- **THEN** all three reads are dropped from lineage, each logged with path, scraped step id `T2S2`, and observed status `running`, and `lineageEdgeRejected` is incremented once per drop with `reason = "producing-step-not-completed"` — no `T2S2` edge is registered for `T4S1` even though the files survive to reconcile and would hash cleanly

#### Scenario: Two concurrent steps get no edge in either direction

- **GIVEN** steps `T2S2` and `T5S1` executing at the same time in one run, each of whose frames reports reads under the other's step directory, and neither of which is `completed` in the other's snapshot
- **WHEN** both steps' frames are classified
- **THEN** neither step tracks an input naming the other, no lineage edge exists between them in either direction, and both rejections are logged and counted on `lineageEdgeRejected`

#### Scenario: A prior run's completed step is admitted as prior

- **GIVEN** step `de` of run `run-002` whose frame reports a read of `runs/run-001/qc/output/qc.csv`, where `run-001` is an earlier run over the same workspace and its step `qc` was `completed` when `de`'s exec was submitted
- **WHEN** the read is classified
- **THEN** the read is tracked with `source: "prior"`, `stepId: "qc"`, `runId: "run-001"`, is content-attested at reconcile, and registers as a lineage edge — the producing step finished, which is the whole of what the gate asks

#### Scenario: A prior run's failed step is rejected even though its run has ended

- **GIVEN** step `de` of run `run-002` whose frame reports a read of `runs/run-001/qc/output/partial.csv`, where `run-001` has ended and its step `qc` was `failed` when `de`'s exec was submitted
- **WHEN** the read is classified
- **THEN** the `prior` edge is rejected — not tracked, not attested, not registered — logged with the ref path and `qc`'s observed status `failed`, and `lineageEdgeRejected` is incremented with `reason = "producing-step-not-completed"`
- **AND** the rejection does NOT depend on `run-001`'s own state: `cortex_runs` is never consulted, so a finished run cannot vouch for a step inside it that failed

#### Scenario: A step of a concurrent other run is rejected

- **GIVEN** step `de` of run `run-002` whose frame reports a read of `runs/run-003/norm/output/norm.csv`, where `run-003` is a second run over the same workspace and its step `norm` was `running` when `de`'s exec was submitted
- **WHEN** the read is classified
- **THEN** the `prior` edge is rejected and counted with `reason = "producing-step-not-completed"` — a running step mutates its directory whether or not it belongs to the reading step's run

#### Scenario: A failed snapshot degrades instead of failing the exec

- **GIVEN** an exec whose completed-step query fails (the database is unreachable when the snapshot step runs)
- **WHEN** the snapshot step resolves and the exec's frame is classified
- **THEN** the step resolves to an explicit "snapshot unavailable" outcome rather than throwing, the exec runs and completes normally, every read naming a producing step for that exec — same-run sibling or prior-run step — is inadmissible, the unavailability is logged at error level, and `lineageEdgeRejected` is incremented with `reason = "snapshot-unavailable"`

#### Scenario: The degraded snapshot is replayed as degraded

- **GIVEN** an exec whose snapshot resolved to "snapshot unavailable", checkpointed durably, and a subsequent DBOS replay of the same workflow in which the database is reachable again
- **WHEN** the replay re-executes the step body
- **THEN** the checkpointed "snapshot unavailable" outcome is returned rather than a fresh query, and the replay classifies the same reads inadmissible — the run does not acquire on replay the sibling edges the original execution suppressed

#### Scenario: A failed sibling's file is dropped

- **GIVEN** step `de` in run `run-002` and step `qc`, whose status was `failed` (equivalently `canceled`, `skipped`, or `blocked`) when `de`'s exec was submitted
- **WHEN** `de`'s frame reports a read of `runs/run-002/qc/output/partial.csv`
- **THEN** the read is dropped from lineage with the observed status recorded — `qc` never finalized its outputs, so they SHALL NOT become `de`'s attested input

#### Scenario: A dropped read does not fail the step

- **GIVEN** step `T2S2` whose exec read `runs/{runId}/T5S1/output/_ct_for_r_BRAF.csv` — a scratch file of the concurrently running `T5S1`, which deletes it before `T2S2`'s reconcile
- **WHEN** the read is classified as inadmissible and `reconcileManifestWithDisk` subsequently runs
- **THEN** the path is absent from the collector, reconcile never stats it, the step does NOT fail with `errorClass: lineage_attestation`, and `T2S2`'s own outputs reconcile and register normally

### Requirement: The read-only mount bounds this step's writes, not the tree's mutability

The read-only mount of the analysis tree at `/{resourceId}` SHALL be understood
to guarantee exactly one thing: the step running in that container cannot write
anywhere except its own nested read-write mount at
`/{resourceId}/runs/{runId}/{stepId}`. It SHALL NOT be read as a guarantee that
the tree's contents are stable while the step runs. Every other step of the run
has its **own** directory mounted read-write in its own container and mutates it
freely — creating, overwriting, and deleting scratch files it never intended to
publish — so from any one step's point of view the analysis tree is shared
mutable state, and the churned paths are exactly the ones sibling classification
would otherwise mark as attestable inputs.

Deferred input hashing — `reconcileManifestWithDisk` / `fillInputHashesFromDisk`
filling an `InputRef`'s hash from disk after teardown rather than at read time —
is therefore sound ONLY for admissible inputs:

- the step's own artifacts (`source: "artifacts"`), written by this step alone;
- `data/` inputs, staged before the run and immutable for its duration;
- same-run siblings that were already `completed` at exec-submit time and will therefore write no more;
- reads of a step of a **prior** run that was already `completed` at exec-submit time, for the same reason and under the same predicate — the producing step's own status, never its run's.

For any other path naming another step — in this run or any other — the bytes
present at reconcile SHALL NOT be assumed to be the bytes that were read, and no
hash taken then SHALL be attested as that read's content. Documentation, prose,
and in-code comments in this capability SHALL NOT justify deferred hashing with
the claim that inputs are immutable because the analysis tree is mounted
read-only — that claim is false for exactly the paths the completion gate now
excludes.

#### Scenario: A sibling mutates a tree this step has mounted read-only

- **GIVEN** steps `T2S2` and `T5S1` running concurrently, each seeing the analysis tree read-only with only its own step directory read-write
- **WHEN** `T5S1` creates `runs/{runId}/T5S1/output/_ct_for_r_BRAF.csv` and deletes it before finishing
- **THEN** `T2S2`'s read-only mount did not and cannot prevent that mutation, and the file's absence at `T2S2`'s reconcile is ordinary sibling churn — not drift on a `T2S2` input

#### Scenario: Deferred hashing stands only for admissible inputs

- **WHEN** reconcile fills input hashes from disk after teardown
- **THEN** it does so only for the step's own artifacts, `data/` inputs, and reads of steps admissible under the completion gate — same-run siblings and prior-run steps alike — every read of a step that had not completed having been rejected at classification, so no hash is attested for a path another step was still free to rewrite or delete between the read and the hash

#### Scenario: A prior run's completed step is a sound deferred-hashing target, its failed step is not

- **GIVEN** two reads by step `de` of run `run-002`: one of `runs/run-001/qc/output/qc.csv` where `run-001`'s step `qc` was `completed` at exec-submit time, and one of `runs/run-001/norm/output/partial.csv` where `norm` was `failed`
- **WHEN** reconcile fills input hashes from disk
- **THEN** the `qc` read is hashed and attested — a completed step writes no more, so its bytes at reconcile are the bytes that were read — while the `norm` read never reached the collector and is not a hashing target at all
- **AND** the fact that both files sit under the same finished run changes nothing: soundness follows the producing step's status, not its run's
