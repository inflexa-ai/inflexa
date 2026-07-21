## Context

Runtime file lineage is captured inside the sandbox, classified by `classifyReadPath`, accumulated in a
step-scoped `ProvenanceCollector`, and content-attested at reconcile. An input that cannot be hashed at
reconcile is treated as drift and fails the step — correct behaviour for a genuine input that vanished,
since it prevents registering a hashless edge.

Two premises make that fail-fast fire on files a step never consumed.

1. `classifyReadPath` branch 4 turns **any** path under `runs/{ownRunId}/` that is not the step's own
   directory into `{ source: "upstream" }`, scraping the step id from the path. Its stated justification:
   *"`dependsOn` drives only topo-sort ordering, not read authorization: a read of a same-run step outside
   `dependsOn` is still a valid upstream input."*
2. Reconcile defers input hashing to teardown *"because inputs are immutable for the step — the analysis
   tree is mounted read-only."*

Premise 2 is false whenever a sibling runs concurrently. The read-only mount constrains *this* step's
writes; every other step has its own directory mounted read-write over the same host inodes and mutates it
freely, scratch files included. Premise 1 then converts that churn into mandatory attestation targets.

Concurrency is the normal case: the scheduler starts every dependency-satisfied step that fits the machine
budget, and `buildMountPlan` sets `PROVENANCE_WATCH_DIRS` to the whole analysis tree, so every step's
inotify watcher observes every sibling's directory. Because bind mounts share inodes across containers and
inotify carries no process attribution, a sibling's activity is reported as *this* step's read.

This change is scoped to shipping a correct fix quickly. The structural follow-up — moving enforcement to
the container mount and collapsing the three points at which the predicate is evaluated — is issue #187 and
is deliberately not attempted here.

## Goals / Non-Goals

**Goals:**

- A concurrently-running sibling can never appear in another step's lineage, in either direction.
- Stop fabricating edges silently. The `T4S1` case must become impossible, not rarer.
- Stop killing a step over a file it never consumed.
- Preserve every legitimate declared-dependency edge.
- Preserve fail-fast for genuine drift — an admissible input that vanished is still terminal.
- Keep classification pure and unit-testable: no database access, no I/O, no clock.
- Ship without a sandbox image rebuild, so the fix is deployable on the current image.

**Non-Goals:**

- Admitting an undeclared sibling that has genuinely completed. That requires a runtime completion
  snapshot; it is issue #187 and is not attempted here.
- Gating `prior`-run reads. Unchanged behaviour, pre-existing exposure, tracked in #187.
- Narrowing the inotify watch scope or changing `IN_OPEN` handling. Both need an image rebuild and version
  bump; the harness-side refusal is independently sufficient for the reported failure.
- Changing the `data/`, `artifacts`, or `prior` classification branches.
- Changing reconcile's fail-fast policy.
- Making provenance capture exhaustive. It stays best-effort and must never fail an exec.

## Decisions

### Gate on declaration, not on a runtime completion query

The causally correct predicate is *"the producing step had finished"*. The insight that keeps this change
small is that for a **declared** dependency, that predicate is already guaranteed by the scheduler and needs
no runtime check.

`scheduleReady` (`execute-analysis-scheduler.ts`) admits a step only when
`step.depends_on.every((d) => completedSet.has(d))`. So every declared dependency is `completed` before the
reading step starts — therefore before it submits any exec, therefore before any read it performs.

Completion in turn implies a frozen tree. In `sandbox-step.ts` the post-step sequence is: walk artifacts →
generate file metadata → **`generateStepSummaryAndWrite` (the last write into the tree, `output/summary.md`)**
→ reconcile + register → sync → index → teardown → **`mark-complete` sets `status: "completed"`**. The status
flips after the final write, so `completed` ⇒ will never write again.

Composing the two: a declared dependency's directory is immutable for the whole lifetime of the reading
step. An edge to it can be asserted unconditionally.

Everything else under `runs/{ownRunId}/` is a sibling whose state is unknown without a query. Rather than
query, this change refuses. That trades some real edges for the elimination of every fabricated one.

**Alternatives considered:**

- *Per-exec completed-step snapshot (the approach in PR #183).* Strictly more precise — it additionally
  admits an undeclared sibling that has completed. Rejected **for this change only**, on cost: it requires a
  database read per exec, a durable DBOS checkpoint to keep replay deterministic (`execute_command` is
  `executionMode: "workflow"`, so an unwrapped query re-executes on replay and returns a larger completed
  set), a snapshot-unavailable failure arm, and metrics plumbing. That is the right eventual design and is
  issue #187; it is not the minimal fix.
- *Make reconcile non-fatal on a missing input.* Roughly ten lines and it stops the crash. Rejected: it
  fixes only the loud half and removes the sole signal that the silent half is happening, making fabricated
  edges strictly harder to notice.
- *Fix only the capture layer (inotify scope + `IN_OPEN`).* Addresses the true source of the phantom
  observations, but requires an image rebuild and version bump before it takes effect, and still leaves a
  genuine read of a sibling's scratch file attestable. Deferred to #187.

### Threading `dependsOn` is load-bearing, not incidental

`sandbox-step.ts` constructs `new ProvenanceCollector({ stepId, runId })` — `dependsOn` is never passed, so
the declared-dependency branch of `classifyReadPath` is unreachable today. The `exec-provenance-lineage`
spec already requires the collector be seeded with it.

This matters because the two halves of the change are not independent. Refusing branch 4 without seeding
`dependsOn` would send **every** same-run read — declared dependencies included — into the refusal, deleting
all legitimate same-run lineage. The seeding is what makes the refusal safe.

`SandboxStepInput` is DBOS workflow input, so adding a field is a durable shape change. It is added as
optional and treated as an empty list when absent, which degrades fail-closed: a workflow recovered under
the old shape refuses same-run sibling edges rather than admitting them. Under-capture on recovery is
consistent with the direction of the whole change.

### Refusal is a returned value, not a throw and not a `data` classification

`classifyReadPath` returns a discriminated result: an admissible classification context, or an explicit
not-admissible outcome carrying the scraped `runId`/`stepId`.

- Not a throw: provenance is best-effort and must never fail an exec.
- Not `{ source: "data" }`: that would silently launder a sibling's scratch file into an attestable
  analysis-level input — a different fabrication, not a fix.
- The scraped ids ride on the refusal because they are the only thing that makes a drop attributable to a
  producing step in a log line.

The refusal is honoured in `feedExecFrame`, **before** `trackInputAccess` is called, so the path never
enters the collector and can never become an attestation target. Filtering downstream would leave the ref
reachable by registration.

**Alternative considered:** returning `null` instead of a union. Rejected — it carries no identity for
diagnostics, and the union mirrors the shape the follow-up in #187 needs, so that change becomes a delta
(add a parameter, change a predicate) rather than a rewrite of this one.

### Every refusal is logged

The silent half of this defect was invisible precisely because nothing recorded the fabricated edges. A
silent drop would rebuild that blind spot one layer down. Each refusal logs through the injected `Logger`
seam with the read path and the producing step it names.

Metrics are deliberately excluded: the existing OTel counters bind their meter at module load, before an
embedder can register a `MeterProvider`, so they are no-ops in production. Fixing that is real but
independent, and folding it in would widen this change for no benefit to the fix. Logging is the channel
that works today.

### Reconcile's fail-fast is kept

Once phantom sibling edges stop being asserted, a remaining `input-enoent` means a *declared* dependency's
file vanished between the read and reconcile — genuine drift, which should be terminal. Softening it here
would re-hide the class of problem this change exists to surface.

### Correct the false premise in spec prose

Both `exec-provenance-lineage` and `artifact-manifest` state, in their Purpose prose, that inputs are
immutable because the tree is mounted read-only. That sentence is the reason deferred hashing looked safe.
Requirement deltas cannot reach Purpose prose, so the two files are edited directly. Leaving it would let
the next reader re-derive the same mistake from the spec itself.

## Risks / Trade-offs

**Real edges are lost where a step read an undeclared sibling that had genuinely completed** → Accepted,
and logged at each occurrence so the loss is visible rather than silent. This is the project's stated
preference: an incomplete lineage graph is recoverable by re-running, a fabricated one is not. #187 restores
these edges via a completion snapshot.

**A step that genuinely depends on a sibling it never declared now registers no edge for it** → The read
still succeeds; only the lineage assertion is dropped. The log line naming the producing step is the signal
that the plan has an undeclared dependency. Surfacing that to the planner is #187 (R3).

**`prior`-run reads remain ungated** → Unchanged from today, so this change is a strict improvement rather
than a regression. Reproducing the defect through that branch requires a second run in flight over the same
workspace, which is rare. Tracked in #187.

**`data/` reads remain ungated and fail-fast** → Same failure class survives at lower probability, since
input data is staged before the run. Pre-existing; tracked in #187 (R4).

**Phantom observations continue until the image is rebuilt** → inotify still manufactures cross-container
reads; they are now refused rather than asserted. Phantom *writes* are already inert: the manifest is built
by walking the step's own write prefix, not from the collector, and only tracked inputs are fatal at
reconcile. A test pins that behaviour so the assumption is not folklore.

**Durable workflow-input shape change** → The field is optional and its absence is fail-closed. Workflows
in flight across the deploy under-capture same-run sibling edges; none crash.

**Branch-order regression risk** → Branch 4 sits between the declared-dependency branch and the prior-run
branch. An error in ordering would silently reroute declared reads into the refusal. Covered by tests that
assert each of the five branches independently, including a declared dependency that is *also* reachable by
the sibling branch's prefix.
