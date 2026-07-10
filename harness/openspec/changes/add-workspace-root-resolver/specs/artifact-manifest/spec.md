# artifact-manifest Delta

## MODIFIED Requirements

### Requirement: The manifest is reconciled against disk before registration

Before registration, the draft manifest SHALL be reconciled against disk by
`reconcileManifestWithDisk`. For each manifest entry the helper SHALL stat the
absolute step path (`{workspaceRoot}/runs/{runId}/{stepId}/{path}`, where
`{workspaceRoot}` is the analysis's resolved workspace root),
bounded to the step root, and:

- If the file does not exist (`ENOENT`) → drop the entry from the returned manifest, call `collector.removeRecord(path)`, increment the `cortex.artifact.reconcile.dropped` counter (tagged `agent_id`, `step_id`), and emit a debug log line.
- If the path is not a regular file (a directory) → drop it the same way.
- Otherwise → recompute SHA-256 from disk via `computeSha256File` and replace the entry's `hash` and `size` with the on-disk values.

Every surviving entry SHALL be re-hashed from disk — there is no matched-size
fast path that skips hashing. The reconcile step SHALL also content-attest the
collector's tracked inputs via `fillInputHashesFromDisk`: for each tracked input
that is not an `artifacts`-source read and lacks a valid content hash, it maps
the container path onto the host workspace tree, bounds it to
`{workspaceRoot}`, and hashes the file from disk. A directory input is
dropped via `collector.dropInput`. An input file that is missing or resolves
outside the analysis tree SHALL throw (fail-fast attestation), never register a
hashless lineage edge.

#### Scenario: Phantom file is dropped silently

- **GIVEN** the agent wrote `output/temp.csv` and later deleted it, but the walk had already recorded it (or the collector still holds a record)
- **WHEN** `reconcileManifestWithDisk` runs and stat fails with `ENOENT`
- **THEN** the entry for `output/temp.csv` is removed from the returned manifest, `collector.removeRecord("output/temp.csv")` is called, a debug line is logged, and `cortex.artifact.reconcile.dropped` is incremented once
- **AND** `output/temp.csv` reaches neither registration nor the vector index

#### Scenario: Every surviving output is re-hashed from disk

- **GIVEN** a manifest entry for `output/clean.csv` whose on-disk size equals the entry's size
- **WHEN** `reconcileManifestWithDisk` runs
- **THEN** `computeSha256File` IS invoked for `output/clean.csv` and the entry's hash and size are set from the on-disk bytes

#### Scenario: An input that cannot be hashed fails the step

- **GIVEN** the collector tracked a non-`artifacts` input read whose file is absent at reconcile time (or resolves outside the analysis tree)
- **WHEN** `fillInputHashesFromDisk` runs
- **THEN** it throws, the step fails loudly, and no hashless lineage edge is registered

#### Scenario: A directory read is dropped from lineage, not failed

- **GIVEN** a tracked input that resolves to a directory (e.g. `ls` of a mount)
- **WHEN** `fillInputHashesFromDisk` runs
- **THEN** `collector.dropInput` is called for that ref and the step does NOT fail
