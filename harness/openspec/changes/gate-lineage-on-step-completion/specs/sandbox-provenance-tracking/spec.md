# sandbox-provenance-tracking — delta

## ADDED Requirements

### Requirement: Provenance capture is scoped to the immutable set — data, the step's own tree, and completed siblings

The container's `PROVENANCE_WATCH_DIRS` SHALL enumerate, for a given step, exactly:

1. the analysis `data/` tree — `/{resourceId}/data`,
2. the step's own run tree — `/{resourceId}/runs/{runId}/{stepId}`, omitted when the mount plan emits no read-write step mount (a read-only sandbox), since no such tree exists,
3. `/{resourceId}/runs/{runId}/{siblingStepId}` for every sibling step of the **same run** whose status is `completed` at sandbox-creation time — one entry per completed sibling.

It SHALL NOT be set to the analysis resource mount root (`/{resourceId}`). The read-only
mount of the analysis tree is **flat** — no single directory has exactly this set as its
contents — so the value SHALL be an enumeration of absolute container paths rather than one
root. A configured watch dir that does not exist when the container starts SHALL be skipped
without failing the exec: provenance is best-effort and never fails a command.

Completion is the criterion because a completed step's directory is **immutable** — it will
never be written again — so watching it costs nothing in churn, *and* its reads are admissible
under the completion gate (see the exec-provenance-lineage spec, "A sibling lineage edge
requires the producing step to have completed"). A **running** sibling's tree SHALL NOT be
watched, which is exactly the churn that caused the defect this change exists to remove.

`dependsOn` SHALL NOT be the criterion. The scheduler already guarantees that every declared
dependency completed before the step starts, so the declared set is a strict subset of (3).
Scoping to declared dependencies alone was wrong because it excluded completed non-declared
siblings that classification admits.

**Known limitation — the watch set is fixed at container start.** The watcher walks each
configured dir once when the container starts and never re-walks, so a sibling that completes
*after* this sandbox was created is not inotify-watched for the remainder of the sandbox's
life. That is under-capture, conservative in the same direction as the completion gate, and it
is not a capture hole: a read the command itself performs under such a tree is still observed
by the in-container hooks, whose prefix filter is configured independently of the watch dirs
(see "inotify provides verification channel for all file operations").

This narrowing is **noise reduction at the capture layer, not the correctness rule**. What an
observed read is allowed to assert is decided by the harness when it classifies the read (see
the explicit-input-classification and exec-provenance-lineage specs); narrowing the watch scope
only keeps unusable observations out of the frame. It also relieves the watcher's **pre-existing**
watch budget — the recursive walk is capped at `maxInotifyWatches` (1000), a bound this
capability already carries and this change neither introduces nor alters — by reducing the
number of directories the walk has to cover.

#### Scenario: A running sibling's directory is not watched

- **GIVEN** step `T4S1` of run `run-002`, and a sibling step `T2S2` in the same run whose status is `running` when `T4S1`'s sandbox is created
- **WHEN** the sandbox for `T4S1` is created and its watch dirs are configured
- **THEN** `PROVENANCE_WATCH_DIRS` does NOT contain `/{resourceId}/runs/run-002/T2S2` or the mount root `/{resourceId}`, and no watch is added anywhere under `T2S2`'s tree
- **AND** `T2S2` creating and deleting `output/_ct_for_r_BRAF.csv` while `T4S1` runs produces no entry in any `T4S1` exec frame

#### Scenario: A completed sibling is watched whether or not it is declared

- **GIVEN** step `de` of run `run-002` with `dependsOn: ["qc"]`, and a sibling `norm` that `de` does not declare, both `qc` and `norm` being `completed` when `de`'s sandbox is created
- **WHEN** the sandbox for `de` is created
- **THEN** `PROVENANCE_WATCH_DIRS` contains `/{resourceId}/runs/run-002/qc` **and** `/{resourceId}/runs/run-002/norm` — membership follows observed completion, not declaration
- **AND** a read of `/{resourceId}/runs/run-002/norm/output/norm.csv` is captured and appears in the exec frame's `reads`

#### Scenario: The data tree and the step's own tree are watched

- **GIVEN** step `de` of run `run-002`
- **WHEN** the sandbox for `de` is created
- **THEN** `PROVENANCE_WATCH_DIRS` contains `/{resourceId}/data` and `/{resourceId}/runs/run-002/de`
- **AND** a read of `/{resourceId}/data/inputs/Lab/counts.csv` and a write of `/{resourceId}/runs/run-002/de/output/tmm.csv` both appear in the exec frame

#### Scenario: A sibling that completes after sandbox creation is not watched but stays capturable

- **GIVEN** step `de` whose sandbox was created while sibling `norm` was `running`, and `norm` subsequently reaching `completed`
- **WHEN** a `de` command later reads `/{resourceId}/runs/run-002/norm/output/norm.csv`
- **THEN** no inotify watch exists under `norm`'s tree — the walk is not repeated — yet the in-container hook that intercepted the open reports the path, since the layer prefixes are not derived from the watch dirs, and the read reaches the frame
- **AND** whether that read may assert lineage is decided by classification against the completed-step snapshot, not by whether it was inotify-watched

#### Scenario: A missing watch dir does not fail the command

- **GIVEN** a configured watch dir that does not exist in the container (a completed sibling whose tree was never created, or a read-only sandbox with no step tree)
- **WHEN** a command executes
- **THEN** the watcher skips that dir, the remaining watch dirs are watched normally, and the exec completes with a provenance frame

### Requirement: Reaching the inotify watch budget is observable to the harness

Reaching the pre-existing `maxInotifyWatches` cap SHALL be observable to the harness. When the
watcher's recursive walk stops adding watches at the cap, the sandbox-server SHALL surface that
fact — as a signal on the exec `provenance` frame (a flag, or the count of directories left
unwatched) or as a counter the harness increments on receipt — and the harness SHALL record it
through the injected `Logger` with the run's structured identifiers. An in-container
`log.Printf` alone SHALL NOT be a conforming
realization: that line never reaches the harness log, so watch-budget exhaustion silently
degrades capture — the same class of blind spot as the silently fabricated edges this change
exists to remove.

The cap itself is unchanged and is not introduced here: it is `maxInotifyWatches` in
`images/sandbox-base/server/provenance_inotify_linux.go:16`, and the degraded behaviour on
reaching it (warn, then watch only the top-level directories) is already specified by "inotify
provides verification channel for all file operations". This requirement adds observability
only.

Exhaustion SHALL NOT fail the exec: capture is best-effort, so the signal rides alongside a
normal completion rather than turning a degraded capture into a failed command.

This signal counts **capture degradation**, not a rejected edge. It SHALL NOT be counted on
`lineageEdgeRejected` (`cortex.lineage.edge_rejected`, tagged `agent_id`, `step_id`, `reason`),
which counts lineage edges rejected at classification, nor on `lineageInputDropped`
(`cortex.artifact.reconcile.input_dropped`), which stays reconcile's with its existing reasons
only.

#### Scenario: Watch-budget exhaustion reaches the harness

- **GIVEN** a step whose configured watch dirs contain more subdirectories than `maxInotifyWatches`
- **WHEN** the watcher walks them at container start and stops adding watches at the cap
- **THEN** the completion payload carries a watch-budget signal alongside the provenance frame, and the harness records it through the injected `Logger` with `runId`, `stepId`, and `execId` as structured fields
- **AND** the in-container log line is not the only record of the degradation

#### Scenario: Exhaustion degrades capture without failing the step

- **GIVEN** the same step, with the watcher having fallen back to watching only the top-level directories
- **WHEN** the command completes
- **THEN** the exec completes normally with a provenance frame carrying whatever was captured, and the step does NOT fail

#### Scenario: A run inside the budget carries no signal

- **GIVEN** a step whose configured watch dirs walk to fewer watches than the cap
- **WHEN** the command completes
- **THEN** no watch-budget signal is present on the frame and no exhaustion record is logged

## MODIFIED Requirements

### Requirement: inotify provides verification channel for all file operations

The sandbox-server SHALL use inotify to watch the configured watch dirs during command
execution for `IN_CREATE`, `IN_DELETE`, `IN_MOVED_FROM`, and `IN_MOVED_TO` events. Inotify
operates as a **verification layer** over the reports the in-container layers send: an
operation observed only by inotify SHALL be surfaced — folded into the frame as a write or a
delete, or logged as an untracked alert — rather than silently lost.

A bare `IN_OPEN` SHALL NOT by itself be reported as a read. `IN_OPEN` fires on opens for
**writing** and on opens performed by processes unrelated to the command, so it cannot on its
own establish that the command consumed the file as an input. The mode-aware Python and R
hooks (Layer 1) and the LD_PRELOAD hook (Layer 2) classify by open mode and SHALL remain the
authoritative read signal. The requirement is the absence of the unsupported read, not one
mechanism: omitting `IN_OPEN` from the watch mask, and retaining `IN_OPEN` while suppressing
any `IN_OPEN`-derived read whose path was also observed created or written during the same
exec, are both conforming realizations. No read SHALL enter the exec provenance frame on the
strength of an `IN_OPEN` alone.

Since `inotify_add_watch` is per-directory (not recursive), the watcher SHALL walk each
configured watch dir at startup and add a watch on each subdirectory. If the configured trees
are too deep or too large (> 1000 watches), the watcher SHALL log a warning and watch only the
top-level directories — the pre-existing `maxInotifyWatches` bound, which this change neither
introduces nor alters and whose exhaustion SHALL additionally be surfaced per "Reaching the
inotify watch budget is observable to the harness".

The inotify watcher SHALL be started before the child process is spawned and stopped after the
child process exits (with a short drain window for late events). The watcher SHALL use
`golang.org/x/sys/unix` raw inotify syscalls (no CGO required).

The data directories to watch SHALL be configurable via the `PROVENANCE_WATCH_DIRS`
environment variable (comma-separated list of absolute paths, default: `/data`).
`PROVENANCE_WATCH_DIRS` and `PROVENANCE_DATA_PREFIXES` SHALL be configured **independently**,
and the sandbox-server SHALL NOT derive the in-container layer prefixes from the watch dirs.
Only inotify observes the shared filesystem, so only inotify needs the narrow scope: the
in-container hooks (the Python audit hook, the R hooks, and the LD_PRELOAD `provtrack.c`)
intercept only **their own process's** opens — LD_PRELOAD interposition and interpreter-level
hooks cannot observe another container's writes — so their prefix filter MAY remain the
analysis resource mount root `/{resourceId}`, unchanged. In production the harness's
`buildMountPlan` sets `PROVENANCE_WATCH_DIRS` to the enumerated, step-scoped list required by
"Provenance capture is scoped to the immutable set — data, the step's own tree, and completed
siblings" — never to the mount root — while `PROVENANCE_DATA_PREFIXES` stays the mount root.

The consequence is intended: a legitimate cross-step or prior-run read performed by the command
itself remains capturable through the hooks even when its path is not inotify-watched, and
reaches the frame where classification decides whether it may assert lineage — a visible,
counted drop rather than an invisible non-observation. Keeping the prefixes at the mount root
also preserves the canonicalization and bounds behaviour the prefix layer performs (see "The
sandbox-server activates the in-container layers per command").

#### Scenario: inotify observes a file creation inside gVisor

- **GIVEN** a sandbox container running under gVisor with the inotify watcher active on the configured watch dirs
- **WHEN** a script creates `/{resourceId}/runs/{runId}/{stepId}/output/result.csv`
- **THEN** the inotify watcher receives an `IN_CREATE` event for `result.csv` and records it as a write

#### Scenario: inotify watches nested subdirectories

- **GIVEN** a configured watch dir `/{resourceId}/runs/{runId}/{stepId}` containing `output/sub/`
- **WHEN** the inotify watcher starts
- **THEN** watches are added on `/{resourceId}/runs/{runId}/{stepId}/`, its `output/`, and its `output/sub/`
- **AND** a file created at `/{resourceId}/runs/{runId}/{stepId}/output/sub/file.csv` triggers an event attributed to that directory

#### Scenario: The layer prefixes are not narrowed to the watch dirs

- **GIVEN** a sandbox whose `PROVENANCE_WATCH_DIRS` omits the tree of a sibling that was still running at sandbox creation
- **WHEN** the command itself reads a file under that sibling's tree and the LD_PRELOAD hook intercepts the open
- **THEN** the path matches `PROVENANCE_DATA_PREFIXES` (the mount root `/{resourceId}`), the datagram is sent, and the read appears in the frame despite there being no watch on that tree
- **AND** the harness drops it at classification if the sibling was not `completed` in the exec's snapshot — the capture layer does not make that decision

#### Scenario: A write-open does not produce a read edge

- **GIVEN** a sandbox with the watcher active on the step's own run tree
- **WHEN** the command opens `/{resourceId}/runs/{runId}/{stepId}/output/result.csv` for writing, and the mode-aware layers report it with `"op": "write"`
- **THEN** the exec provenance frame records that path as a write
- **AND** the frame's `reads` does NOT contain it, even though the open raised an `IN_OPEN`

#### Scenario: An open no layer reported does not become a read

- **GIVEN** a command execution where Layer 1 and Layer 2 reported reads for files A and B
- **WHEN** inotify observes opens of A, B, and C
- **THEN** the exec provenance frame's `reads` contains A and B and does NOT contain C
- **AND** any retained inotify evidence for C is confined to an untracked-read diagnostic, never a lineage read

#### Scenario: inotify works under runc

- **GIVEN** a sandbox container running under runc (no gVisor)
- **WHEN** a script creates a file under a configured watch dir
- **THEN** the inotify watcher receives an `IN_CREATE` event for it

### Requirement: The sandbox-server activates the in-container layers per command

For each `POST /exec` command, the sandbox-server SHALL inject the provenance
layers into the child process environment when their files are present:
`PYTHONPATH` prepended with `/opt/provenance` (Layer 1 Python), `R_PROFILE`
pointing at `/opt/provenance/Rprofile.site` (Layer 1 R), `LD_PRELOAD` pointing at
`/opt/provenance/provtrack.so` (Layer 2), `PROVENANCE_SOCKET` set to the
per-command socket path, and `PROVENANCE_DATA_PREFIXES` set from the server's
**own** configured prefix list — the analysis resource mount root — never derived
from `PROVENANCE_WATCH_DIRS`, which is configured independently and narrower.
After the child exits, the server SHALL drain the socket, combine the socket
reports with the inotify verification channel, and surface the result as the exec
`provenance` frame.

The server SHALL canonicalize every reported path — collapsing `.` and `..`
segments — and SHALL record it only if the canonical path lies **within** a
configured data prefix, at the single point where all layers converge. A prefix
root itself SHALL NOT be recorded: a read of the mount root is a directory, never
an attestable file.

Each in-container layer filters by string prefix on whatever path its caller
passed, and an absolute path need not be canonical: `/{resourceId}/..` literally
begins with the prefix `/{resourceId}/` yet names its parent, so it survives
every layer's own filter. The host maps such a path to a location above the
analysis tree, where it cannot attest it. The layer filters are therefore an
optimization — they keep a datagram off the socket — and this re-check is the
boundary that decides what a frame may contain. Canonicalization is **lexical**:
resolving symlinks would make the reported path disagree with the name the
workload used, and the layers report names, not inodes.

#### Scenario: Layers are injected for a Python command

- **GIVEN** a sandbox-server with the provenance files installed at `/opt/provenance`
- **WHEN** a command is executed via `POST /exec`
- **THEN** the child process environment carries `PYTHONPATH` including `/opt/provenance`, `R_PROFILE`, `LD_PRELOAD`, `PROVENANCE_SOCKET`, and `PROVENANCE_DATA_PREFIXES` set to the configured prefix list — the mount root — and NOT to the enumerated watch dirs

#### Scenario: Socket reports fold into the exec frame

- **WHEN** a script reads `/{resourceId}/data/inputs/test.csv` via `pandas.read_csv` and the command completes
- **THEN** the exec `provenance` frame's `reads` contains that path
- **AND** does not contain stdlib paths like `/usr/lib/python3/...`

#### Scenario: A read of the mount's parent is not reported

- **GIVEN** a configured prefix of `/{resourceId}/` and a layer reporting a read of `/{resourceId}/data/..` (the analysis mount root, which the workload may legitimately open)
- **WHEN** the server records the report
- **THEN** the canonical path is `/{resourceId}`, the prefix root itself and therefore a directory rather than an attestable file, and the exec `provenance` frame does NOT contain it

#### Scenario: A traversal out of the tree is not reported

- **GIVEN** a layer reporting a read of `/{resourceId}/data/../../../etc/passwd`
- **WHEN** the server records the report
- **THEN** the canonical path is `/etc/passwd`, which lies outside every configured prefix, and the exec `provenance` frame does NOT contain it

#### Scenario: A non-canonical in-tree path folds onto its canonical name

- **GIVEN** a configured prefix of `/{resourceId}`, R's `normalizePath(mustWork = FALSE)` reporting a write to `/{resourceId}/runs/r1/T3S1/scripts/../output/enrich.csv` (it leaves `..` intact whenever a component does not exist yet — the common case for a new output file), and the inotify layer reporting `/{resourceId}/runs/r1/T3S1/output/enrich.csv`
- **WHEN** the server records both reports
- **THEN** the frame carries ONE entry, under the canonical path, attributed to both layers
