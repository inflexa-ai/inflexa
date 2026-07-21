## MODIFIED Requirements

### Requirement: The manifest is reconciled against disk before registration

`reconcileManifestWithDisk(input)` SHALL run after the sandbox is destroyed and
before any artifact is registered or synced. For each manifest entry it SHALL
stat the file at `{workspaceRoot}/runs/{runId}/{stepId}/{entry.path}`, bounded
to the step root, and:

- If the file does not exist (`ENOENT`) → drop the entry from the returned manifest, call `collector.removeRecord(path)`, increment the `cortex.artifact.reconcile.dropped` counter (tagged `agent_id`, `step_id`), and emit a debug log line.
- If the path is not a regular file (a directory) → drop it the same way.
- Otherwise → recompute SHA-256 from disk via `computeSha256File` and replace the entry's `hash` and `size` with the on-disk values.

Every surviving entry SHALL be re-hashed from disk — there is no matched-size
fast path that skips hashing. The reconcile step SHALL also content-attest the
collector's tracked inputs via `fillInputHashesFromDisk`: for each tracked input
that is not an `artifacts`-source read and lacks a valid content hash, it maps
the container path onto the host workspace tree, bounds it to
`{workspaceRoot}`, and hashes the file from disk.

**Reconcile attests admissible inputs only.** An input is *admissible* when the
bytes it names are stable across the step's execution: a staged `data` read, a
`prior`-run read **of a step that had `completed`** (a step still running mutates
its directory exactly as a concurrent sibling does, whatever state its run is in,
so an unqualified `prior` read is not admissible), the step's own artifacts
(`artifacts`-source — not attested here), and a same-run **sibling step that had
already completed when the reading step's exec started**. A read of a producing
step that had **not** completed at that moment is **inadmissible**, whether that
step belongs to this run or an earlier one: in both cases the step observed
activity it did not consume, which is noise rather than drift, and such a read
SHALL be dropped from lineage and SHALL NEVER fail the step. One predicate — the
producing step's own status — settles both; the state of the run containing that
step SHALL play no part. Inadmissible edges
SHALL be dropped at **classification**
time, before the ref enters the collector (see the
`explicit-input-classification` capability), so `fillInputHashesFromDisk` SHALL
be entitled to assume every tracked input it sees is already admissible, and by
the time reconcile runs there SHALL be no inadmissible ref left for it to drop.
Reconcile SHALL NOT acquire a completion check of its own: it runs after
teardown, by which time a sibling that was mid-flight *while the file was read*
may have completed, so a check there would admit exactly the racy edge the
classification-time gate exists to reject.

An input that is not a content-attestable file **of this analysis** SHALL be
dropped via `collector.dropInput` and SHALL NOT fail the step:

- An input resolving to a **directory** (e.g. `ls` of a mount) → dropped, logged at debug.
- An input resolving **outside the analysis tree**, at either the container-prefix or the workspace-root bound → dropped, logged at **warn** with the ref and a `boundSite` discriminator; the workspace-root record also carries the resolved host path (the container-prefix bound rejects the path before a host mapping exists).

Every input drop taken **at reconcile** SHALL increment the
`lineageInputDropped` counter (`cortex.artifact.reconcile.input_dropped`), tagged
`agent_id`, `step_id`, and `reason`. That counter's `reason` set SHALL remain
exactly `directory`, `container-prefix`, and `workspace-root`: this change adds
no reason to it and changes nothing else about it.

An inadmissible edge to a producing step SHALL NOT be counted here. It is
counted at its own drop site, at classification, on the separate
`lineageEdgeRejected` counter (`cortex.lineage.edge_rejected`) — tagged
`agent_id`, `step_id`, and `reason` ∈ `producing-step-not-completed`,
`snapshot-unavailable` (see the
`explicit-input-classification` capability) — and SHALL NOT appear among
reconcile's reasons, because reconcile never sees it. The two counters measure
different events at different sites and SHALL NOT be merged.

An out-of-tree read is out of scope rather than drift: the analysis tree mounts
at `/{resourceId}`, so a reported read of `/{resourceId}/..` names the container
root and describes nothing about the analysis. The capture hooks are meant to
filter such reads by data prefix, so the lineage graph already describes only
in-tree inputs — dropping a leaked one restores that graph. Dropping upholds
"never register a hashless lineage edge" exactly as a throw would, without
destroying a legitimate analysis over an untracked read, and it mirrors the
out-of-bounds *output* skip in the same function. Warn rather than debug is
deliberate: a directory read is ordinary, whereas an out-of-tree read means a
capture layer reported something it should have filtered — not worth a dead
analysis, but worth noticing.

Fail-fast SHALL remain for genuine drift: an **admissible** input **file** that
is missing at reconcile (`ENOENT`) SHALL throw, as SHALL an unexpected `stat`
failure, never registering a hashless lineage edge. The admissibility rule SHALL
NOT weaken this: dropping applies only to reads excluded *before* reconcile and
to the not-a-file / out-of-tree cases above, never to a tracked input that
reaches `fillInputHashesFromDisk` and cannot be hashed.

#### Scenario: Phantom file is dropped silently

- **GIVEN** the agent wrote `output/temp.csv` and later deleted it, but the walk had already recorded it (or the collector still holds a record)
- **WHEN** `reconcileManifestWithDisk` runs and stat fails with `ENOENT`
- **THEN** the entry for `output/temp.csv` is removed from the returned manifest, `collector.removeRecord("output/temp.csv")` is called, a debug line is logged, and `cortex.artifact.reconcile.dropped` is incremented once
- **AND** `output/temp.csv` reaches neither registration nor the vector index

#### Scenario: Every surviving output is re-hashed from disk

- **GIVEN** a manifest entry for `output/clean.csv` whose on-disk size equals the entry's size
- **WHEN** `reconcileManifestWithDisk` runs
- **THEN** `computeSha256File` IS invoked for `output/clean.csv` and the entry's hash and size are set from the on-disk bytes

#### Scenario: An admissible input missing at reconcile still fails the step

- **GIVEN** the collector tracked a non-`artifacts` input read that is admissible — a `data` read, a `prior`-run read of a step that had completed, or a read of a sibling step that had completed before this step's exec started — and whose file is absent at reconcile time
- **WHEN** `fillInputHashesFromDisk` runs
- **THEN** it throws, the step fails loudly, and no hashless lineage edge is registered
- **AND** the throw is logged first with the ref, its `source`, the resolved `hostPath`, and the `throwSite` discriminator

#### Scenario: An inadmissible sibling read never reaches reconcile

- **GIVEN** sibling step `T5S1` is running concurrently with this step and its scratch file `runs/{runId}/T5S1/output/_scratch.csv` was reported as a read and then deleted by `T5S1`
- **WHEN** the exec frame is classified and `reconcileManifestWithDisk` later runs
- **THEN** the read was dropped as inadmissible at classification and was never tracked by the collector, so `fillInputHashesFromDisk` has no ref for it, does not stat it, and does not throw
- **AND** the step's real outputs still reconcile and register, and the step completes

#### Scenario: A directory read is dropped from lineage, not failed

- **GIVEN** a tracked input that resolves to a directory (e.g. `ls` of a mount)
- **WHEN** `fillInputHashesFromDisk` runs
- **THEN** `collector.dropInput` is called for that ref, `lineageInputDropped` (`cortex.artifact.reconcile.input_dropped`) is incremented with `reason = "directory"`, and the step does NOT fail
- **AND** `lineageEdgeRejected` is NOT incremented — reconcile's drop sites keep exactly the reasons `directory`, `container-prefix`, and `workspace-root`

#### Scenario: A read resolving outside the analysis tree is dropped, not failed

- **GIVEN** a tracked input read of `/{resourceId}/..` — the container root, which maps to a host path above the workspace root
- **WHEN** `fillInputHashesFromDisk` runs
- **THEN** `collector.dropInput` is called for that ref, a warn record naming the ref, its resolved `hostPath`, and `boundSite` is emitted, and the step does NOT fail
- **AND** the step's real outputs still reconcile and register

## ADDED Requirements

### Requirement: Deferred input hashing is sound only for admissible, stable inputs

Input hashes SHALL be read from disk at reconcile rather than captured at read
time, and that deferral SHALL be justified **only** by the stability of
*admissible* inputs. It SHALL NOT be justified by the analysis tree being mounted
read-only: the read-only mount constrains the **reading** step's own writes and
says nothing about a sibling step, which has its own directory mounted
read-write and mutates it freely, including creating and deleting scratch files
it never intends to publish.

Deferred hashing is sound for, and only for, inputs whose bytes can no longer
change before reconcile:

- staged `data`, immutable for the run;
- outputs of a prior run's step that had **completed** — a step still running writes on, so `prior` is admissible only under the same completion gate, never unconditionally and never on the strength of its run having ended;
- the step's own directory (`artifacts`-source, excluded from attestation anyway);
- a same-run sibling that had **completed** before the reading step's exec started — completion is monotonic, so such a sibling performs no further writes.

The list is one rule, not four: the producing step finished writing. A prior
run's **failed** step is therefore excluded exactly as a running sibling is, even
though its run has ended, because a step that did not complete never finalized
its outputs.

Deferred hashing is **not** sound for a concurrently running sibling, nor for a
step of another run that had not completed: between the
read and reconcile its bytes may change or vanish, so the hash recorded at
reconcile would not be the bytes the command consumed, and its absence would be
indistinguishable from drift. Such an edge SHALL therefore be excluded **before**
reconcile — at classification, per the `explicit-input-classification` capability
— rather than tolerated at reconcile. The harness SHALL NOT reconcile that
unsoundness by relaxing reconcile's fail-fast, because a reconcile that no longer
throws on an unhashable tracked input can register a hashless lineage edge, which
is the invariant reconcile exists to hold.

#### Scenario: A completed sibling's output is attested at reconcile

- **GIVEN** a tracked input naming a file under a sibling step whose `cortex_step_executions.status` was `completed` before this step's exec started
- **WHEN** `fillInputHashesFromDisk` runs
- **THEN** the ref's hash is computed from disk and equals the bytes the sibling finalized, because a completed step performs no further writes
- **AND** the edge is registered and the step does NOT fail

#### Scenario: A prior run's completed step is attested at reconcile

- **GIVEN** a tracked `prior` input naming a file under step `qc` of the earlier run `run-001`, whose `cortex_step_executions.status` was `completed` when this step's exec was submitted
- **WHEN** `fillInputHashesFromDisk` runs
- **THEN** the ref's hash is computed from disk and the edge is registered — the producing step finished, so its bytes are stable, and no state of `run-001` itself was consulted to reach that conclusion

#### Scenario: A prior run's failed step is never an attestation target

- **GIVEN** step `norm` of the earlier run `run-001` ended `failed`, `run-001` itself has finished, and the capture layer reported a read of `runs/run-001/norm/output/partial.csv`
- **WHEN** the read is classified
- **THEN** it is dropped as an inadmissible edge, is never tracked by the collector, and therefore never becomes a deferred-hashing target at reconcile — `norm` never finalized those bytes, and its run having ended does not finalize them for it
- **AND** whether that file survives to reconcile makes no difference to this step's outcome

#### Scenario: A concurrent sibling's file is never an attestation target

- **GIVEN** a sibling step was still running when this step's exec started, and the capture layer reported a read of one of that sibling's files
- **WHEN** the read is classified
- **THEN** it is dropped as an inadmissible edge, is never tracked by the collector, and therefore never becomes a deferred-hashing target at reconcile
- **AND** whether that file survives to reconcile or is deleted by the sibling makes no difference to this step's outcome

#### Scenario: Reconcile is not relaxed to absorb an unsound edge

- **GIVEN** a tracked input reached the collector and its file cannot be hashed at reconcile (`ENOENT` or an unexpected `stat` failure)
- **WHEN** `fillInputHashesFromDisk` runs
- **THEN** it throws and the step fails, regardless of whether the ref names a sibling step's directory
- **AND** the remedy for an inadmissible read SHALL be dropping it at classification, never softening this throw
