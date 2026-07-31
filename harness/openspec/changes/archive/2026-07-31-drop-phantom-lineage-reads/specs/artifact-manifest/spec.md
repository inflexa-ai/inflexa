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

An input that is not a content-attestable file **of this analysis** SHALL be
dropped via `collector.dropInput` and SHALL NOT fail the step:

- An input resolving to a **directory** (e.g. `ls` of a mount) → dropped, logged at debug.
- An input resolving **outside the analysis tree**, at either the container-prefix or the workspace-root bound → dropped, logged at **warn** with the ref and a `boundSite` discriminator; the workspace-root record also carries the resolved host path (the container-prefix bound rejects the path before a host mapping exists).
- An input naming a path that is **not present** at reconcile (`ENOENT`) → dropped, logged at **warn** with the ref, its resolved host path, and `dropSite: "input-enoent"`.

Every input drop SHALL increment the `cortex.artifact.reconcile.input_dropped`
counter, tagged `agent_id`, `step_id`, and `reason` (`directory`,
`container-prefix`, `workspace-root`, or `missing`).

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

An absent path is not drift either, and for a reason that belongs to the capture
layers: they report **attempted** operations, not completed ones. The Python
audit hook fires on the `open` audit event, which CPython raises before the open
is attempted; R's `trace()` fires at call entry over a
`normalizePath(mustWork = FALSE)` name. A read that failed therefore arrives
indistinguishable from one that succeeded, and the commonest source of them is
ordinary: displaying an uncaught traceback whose frame carries a relative
`co_filename` (every Cython frame — pandas' `.pxi`/`.pyx`) makes CPython open
`<entry>/<basename>` for every `sys.path` entry until one succeeds, and the
entries under the analysis mount become reported reads of files that were never
there. Nothing was consumed, so there is no edge to attest, and the step that
already produced its outputs is not made more correct by dying. Warn rather than
debug for the same reason as an out-of-tree read: the count of these is how a
reader tells a noisy capture layer from an artifact that genuinely vanished
under a step.

Fail-fast SHALL remain for a `stat` that fails any **other** way — the file is
there and cannot be read, which says something is wrong with the tree itself —
and no drop SHALL ever register a hashless lineage edge.

#### Scenario: Phantom file is dropped silently

- **GIVEN** the agent wrote `output/temp.csv` and later deleted it, but the walk had already recorded it (or the collector still holds a record)
- **WHEN** `reconcileManifestWithDisk` runs and stat fails with `ENOENT`
- **THEN** the entry for `output/temp.csv` is removed from the returned manifest, `collector.removeRecord("output/temp.csv")` is called, a debug line is logged, and `cortex.artifact.reconcile.dropped` is incremented once
- **AND** `output/temp.csv` reaches neither registration nor the vector index

#### Scenario: Every surviving output is re-hashed from disk

- **GIVEN** a manifest entry for `output/clean.csv` whose on-disk size equals the entry's size
- **WHEN** `reconcileManifestWithDisk` runs
- **THEN** `computeSha256File` IS invoked for `output/clean.csv` and the entry's hash and size are set from the on-disk bytes

#### Scenario: An input that is not present at reconcile is dropped, not failed

- **GIVEN** the collector tracked a non-`artifacts` input read whose file is absent at reconcile time
- **WHEN** `fillInputHashesFromDisk` runs
- **THEN** `collector.dropInput` is called for that ref, a warn record naming the ref, its resolved `hostPath`, and `dropSite: "input-enoent"` is emitted, `cortex.artifact.reconcile.input_dropped` is incremented with `reason: "missing"`, and the step does NOT fail
- **AND** the step's real outputs still reconcile and register, and no hashless lineage edge is registered

#### Scenario: A traceback's source-file probe does not fail the step

- **GIVEN** a step whose script lives in a declared dependency's `scripts/` directory and died with an uncaught pandas `KeyError`, so the capture layer reported a read of `runs/{runId}/{depStepId}/scripts/hashtable_class_helper.pxi` — a `sys.path` probe for the Cython frame's source, which never existed
- **WHEN** `fillInputHashesFromDisk` runs
- **THEN** the ref is dropped from lineage and the step completes, while the real read of the script itself is attested with its on-disk hash

#### Scenario: A directory read is dropped from lineage, not failed

- **GIVEN** a tracked input that resolves to a directory (e.g. `ls` of a mount)
- **WHEN** `fillInputHashesFromDisk` runs
- **THEN** `collector.dropInput` is called for that ref and the step does NOT fail

#### Scenario: A read resolving outside the analysis tree is dropped, not failed

- **GIVEN** a tracked input read of `/{resourceId}/..` — the container root, which maps to a host path above the workspace root
- **WHEN** `fillInputHashesFromDisk` runs
- **THEN** `collector.dropInput` is called for that ref, a warn record naming the ref, its resolved `hostPath`, and `boundSite` is emitted, and the step does NOT fail
- **AND** the step's real outputs still reconcile and register
