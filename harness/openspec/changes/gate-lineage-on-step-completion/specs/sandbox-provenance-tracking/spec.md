# sandbox-provenance-tracking — delta

## ADDED Requirements

### Requirement: Provenance capture is scoped to the step's own run tree

The container's `PROVENANCE_WATCH_DIRS` SHALL name exactly one path — the step's own run tree,
`/{resourceId}/runs/{runId}/{stepId}` — and SHALL be empty when the mount plan emits no
read-write step mount (a read-only sandbox), which writes nowhere. It SHALL NOT be set to the
analysis resource mount root (`/{resourceId}`), to the `data/` tree, or to any sibling step's
tree. A configured watch dir that does not exist when the container starts SHALL be skipped
without failing the exec: provenance is best-effort and never fails a command.

The criterion is **what this exec mutates**, not what it may read. inotify reports only
creations, deletions, and moves — never reads, since a bare `IN_OPEN` may not be reported as one
(see "inotify provides verification channel for all file operations"). The only tree this exec
writes is its own. The `data/` tree is staged before the run and frozen for its duration, and a
completed sibling is immutable by the completion gate's own premise, so neither can emit a
create, delete, or move while this step runs. Watching them would register watches that
structurally cannot fire.

Narrowing SHALL NOT cost a read edge, because reads do not come from inotify. A read the command
itself performs — of `data/`, of a sibling's tree, or of a prior run — is intercepted by the
in-container hooks, whose prefix filter (`PROVENANCE_DATA_PREFIXES`) is the analysis resource
mount root and is configured independently of the watch dirs. The hooks are the authoritative
read signal; inotify verifies mutations.

Excluding `data/` also removes the only **unbounded** term from the walk. `data/` is user-staged
and its directory count follows the shape of the input dataset, so a per-sample cohort makes it
arbitrarily large; a sibling's output tree grows the same way whenever a step writes per-entity
directories. Neither is bounded by anything the harness controls, and the walk is a startup cost
paid before the child process spawns. What remains — the step's own tree — holds only the
directories `precreateStepTree` created, plus, on a retry, whatever the previous attempt left.

**Accepted limitation — reads by uninstrumented processes are not captured.** A process the
hooks cannot instrument (a statically-linked binary, which `LD_PRELOAD` does not apply to, or a
runtime with no hook) performs reads that no layer observes. This is deliberate rather than an
oversight: inotify cannot attribute an event to the process that caused it, so restoring
`IN_OPEN` to recover those reads would also manufacture reads from other containers' opens of
the same shared tree — including opens of *completed* siblings, which the completion gate
admits, so the gate does not contain the damage. An under-reported read leaves a lineage graph
that is incomplete; a fabricated one leaves a graph that is wrong, and only the second is
unrecoverable by inspection.

This narrowing is **capture-layer scoping, not the correctness rule**. What an observed read is
allowed to assert is decided by the harness when it classifies the read (see the
explicit-input-classification and exec-provenance-lineage specs).

#### Scenario: The step's own tree is the only watch dir

- **GIVEN** step `de` of run `run-002` with `dependsOn: ["qc"]`, a completed sibling `norm`, and a running sibling `T2S2`
- **WHEN** the sandbox for `de` is created
- **THEN** `PROVENANCE_WATCH_DIRS` is exactly `/{resourceId}/runs/run-002/de`
- **AND** it contains neither `/{resourceId}/data`, nor `/{resourceId}/runs/run-002/qc`, nor `/{resourceId}/runs/run-002/norm`, nor `/{resourceId}/runs/run-002/T2S2`, nor the mount root `/{resourceId}`

#### Scenario: A write to the step's own tree is verified by inotify

- **GIVEN** a sandbox for step `de` of run `run-002`
- **WHEN** the command creates `/{resourceId}/runs/run-002/de/output/tmm.csv`
- **THEN** the inotify watcher receives an `IN_CREATE` event for it and the exec frame records that path as a write

#### Scenario: The data tree is not watched, and its reads are still captured

- **GIVEN** a sandbox whose `PROVENANCE_WATCH_DIRS` omits `/{resourceId}/data`
- **WHEN** the command reads `/{resourceId}/data/inputs/Lab/counts.csv` and an in-container hook intercepts the open
- **THEN** the path matches `PROVENANCE_DATA_PREFIXES` (the mount root), the read reaches the exec frame's `reads`, and it classifies as `source: "data"`
- **AND** no inotify watch under `data/` was required for that edge

#### Scenario: No sibling's tree is watched, completed or running

- **GIVEN** step `T4S1` of run `run-002`, a completed sibling `qc`, and a sibling `T2S2` still running
- **WHEN** the sandbox for `T4S1` is created
- **THEN** no watch is added anywhere under either sibling's tree
- **AND** `T2S2` creating and deleting `output/_ct_for_r_BRAF.csv` while `T4S1` runs produces no entry in any `T4S1` exec frame
- **AND** a `T4S1` command that itself reads `/{resourceId}/runs/run-002/qc/output/qc.csv` still has that read captured by the hooks, where classification decides whether it may assert lineage

#### Scenario: A read-only sandbox configures no watch dirs

- **GIVEN** a mount plan that emits no read-write step mount
- **WHEN** the sandbox is created
- **THEN** `PROVENANCE_WATCH_DIRS` is empty, the watcher registers no watches, and the exec completes with a provenance frame carrying whatever the hooks reported

#### Scenario: A missing watch dir does not fail the command

- **GIVEN** a configured watch dir that does not exist in the container
- **WHEN** a command executes
- **THEN** the watcher skips that dir and the exec completes with a provenance frame

### Requirement: The inotify watch budget is configurable, and every form of exhaustion is observable

The watcher's cap on registered watches SHALL be configurable through the environment, in
keeping with every neighbouring knob in this capability (`PROVENANCE_WATCH_DIRS`,
`PROVENANCE_DATA_PREFIXES`, the tree-diff interval). A bare compile-time constant is not a
conforming realization: the value bounds a walk over user-shaped trees, so the one deployment
that outgrows it must be able to raise it without a rebuilt image. The shipped default remains
the pre-existing `maxInotifyWatches` (1000), which this change neither introduces nor alters.

Reaching that cap SHALL be observable to the harness. When the walk stops adding watches, the
sandbox-server SHALL surface the fact — as a signal on the exec `provenance` frame (a flag, or
the count of directories left unwatched) or as a counter the harness increments on receipt — and
the harness SHALL record it through the injected `Logger` with the run's structured identifiers.
An in-container `log.Printf` alone SHALL NOT be a conforming realization: that line never
reaches the harness log, so exhaustion would silently degrade capture — the same class of blind
spot as the silently fabricated edges this change exists to remove.

**Kernel-side exhaustion SHALL be reported distinctly from the configured cap.** Registering a
watch can fail because the kernel's own per-uid limit
(`/proc/sys/fs/inotify/max_user_watches`) is exhausted, which is a different condition with a
different remedy: the configured cap is the harness declining to watch more, while `ENOSPC` is
the host refusing. A failed registration SHALL NOT be silently skipped — it SHALL be counted and
surfaced alongside the cap signal, distinguishable from it. Reporting only the self-imposed cap
would leave the genuine resource failure exactly as invisible as it is today, which is the blind
spot one layer down.

Neither form of exhaustion SHALL fail the exec: capture is best-effort, so the signal rides
alongside a normal completion rather than turning degraded capture into a failed command.

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

#### Scenario: The cap is raised without rebuilding the image

- **GIVEN** a deployment whose step trees walk to more directories than the default cap
- **WHEN** the operator sets the cap's environment variable to a higher value and a command executes
- **THEN** the watcher registers watches up to the configured value rather than the shipped default, and no image rebuild was required

#### Scenario: Kernel watch exhaustion is distinguishable from the configured cap

- **GIVEN** a host whose `/proc/sys/fs/inotify/max_user_watches` is already exhausted by other processes, and a step whose walk stays well inside the configured cap
- **WHEN** the watcher attempts to register a watch and the kernel returns `ENOSPC`
- **THEN** the failure is counted and surfaced to the harness, distinguishable from a configured-cap refusal, and the exec still completes with whatever the hooks reported
- **AND** the failure is not silently skipped, so degraded capture is never reported as a clean walk

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
configured watch dir at startup and add a watch on each subdirectory. If the configured tree is
too deep or too large, the watcher SHALL log a warning and watch only the top-level
directories — the pre-existing `maxInotifyWatches` bound, which this change neither introduces
nor alters in value, and whose configurability and exhaustion reporting are required by "The
inotify watch budget is configurable, and every form of exhaustion is observable".

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
`buildMountPlan` sets `PROVENANCE_WATCH_DIRS` to the step's own run tree alone, as required by
"Provenance capture is scoped to the step's own run tree" — never to the mount root, the `data/`
tree, or a sibling's tree — while `PROVENANCE_DATA_PREFIXES` stays the mount root.

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

- **GIVEN** a sandbox whose `PROVENANCE_WATCH_DIRS` is the step's own run tree alone, omitting `data/` and every sibling's tree
- **WHEN** the command itself reads a file under a sibling's tree and the LD_PRELOAD hook intercepts the open
- **THEN** the path matches `PROVENANCE_DATA_PREFIXES` (the mount root `/{resourceId}`), the datagram is sent, and the read appears in the frame despite there being no watch on that tree
- **AND** the harness rejects it at classification if the sibling was not `completed` in the exec's snapshot — the capture layer does not make that decision

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
