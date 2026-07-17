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

Every input drop SHALL increment the `cortex.artifact.reconcile.input_dropped`
counter, tagged `agent_id`, `step_id`, and `reason` (`directory`,
`container-prefix`, or `workspace-root`).

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

Fail-fast SHALL remain for genuine drift: an input **file** that is missing at
reconcile (`ENOENT`) SHALL throw, as SHALL an unexpected `stat` failure, never
registering a hashless lineage edge.

#### Scenario: Phantom file is dropped silently

- **GIVEN** the agent wrote `output/temp.csv` and later deleted it, but the walk had already recorded it (or the collector still holds a record)
- **WHEN** `reconcileManifestWithDisk` runs and stat fails with `ENOENT`
- **THEN** the entry for `output/temp.csv` is removed from the returned manifest, `collector.removeRecord("output/temp.csv")` is called, a debug line is logged, and `cortex.artifact.reconcile.dropped` is incremented once
- **AND** `output/temp.csv` reaches neither registration nor the vector index

#### Scenario: Every surviving output is re-hashed from disk

- **GIVEN** a manifest entry for `output/clean.csv` whose on-disk size equals the entry's size
- **WHEN** `reconcileManifestWithDisk` runs
- **THEN** `computeSha256File` IS invoked for `output/clean.csv` and the entry's hash and size are set from the on-disk bytes

#### Scenario: A missing input file fails the step

- **GIVEN** the collector tracked a non-`artifacts` input read whose file is absent at reconcile time
- **WHEN** `fillInputHashesFromDisk` runs
- **THEN** it throws, the step fails loudly, and no hashless lineage edge is registered

#### Scenario: A directory read is dropped from lineage, not failed

- **GIVEN** a tracked input that resolves to a directory (e.g. `ls` of a mount)
- **WHEN** `fillInputHashesFromDisk` runs
- **THEN** `collector.dropInput` is called for that ref and the step does NOT fail

#### Scenario: A read resolving outside the analysis tree is dropped, not failed

- **GIVEN** a tracked input read of `/{resourceId}/..` — the container root, which maps to a host path above the workspace root
- **WHEN** `fillInputHashesFromDisk` runs
- **THEN** `collector.dropInput` is called for that ref, a warn record naming the ref, its resolved `hostPath`, and `boundSite` is emitted, and the step does NOT fail
- **AND** the step's real outputs still reconcile and register
