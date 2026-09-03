# artifact-manifest Specification

## Purpose

Define the local artifact ledger (`cortex_artifacts`) and the per-step manifest
pipeline: how a step's produced files are discovered, content-attested, written
to the ledger, and registered through the injected `ArtifactRegistry` seam.

A step's manifest is a **disk walk**, not a projection of provenance records.
After the sandbox agent loop finishes, `walkStepArtifacts` walks the step's
writable directory (`runs/{runId}/{stepId}/...`), hashes every file from disk,
and infers each file's type from its subdirectory. The step-scoped
`ProvenanceCollector` is a *separate* concern — it carries the runtime
input/script lineage edges (which inputs each command read), consumed only by
the `ArtifactRegistry` call, never by the manifest. Disk is the source of truth
for *what was produced*; the collector is the source of truth for *what it was
derived from*.

**Content-attested lineage; no hashless edge ever registered.** The sandbox provenance
frame is path-only — it reports
which files were read and written, never their bytes. So Cortex recomputes
SHA-256 hashes from disk at `reconcileManifestWithDisk` for **every surviving
output** and **every tracked input**, and registers those. Output hashes must be
re-read because outputs mutate during the step (a long-running script flushes
after the frame fires; an atomic-rename swaps content under a stable byte count);
input hashes can be read from disk now because every tracked input's producer
has finished writing: a same-run sibling contributes an edge only when it was a
declared dependency, which the scheduler guarantees completed before this step
started, and a completed step never writes into its tree again. The read-only
mount does not establish that — it bounds what *this* step writes, while every
sibling has its own directory mounted read-write over the same host inodes and
mutates it freely. This makes the registered hash equal `sha256sum` of
the bytes the sync target receives at upload time. The reconcile/register/sync
stages are pulled out of the best-effort net, and inside that net **severity
follows what a rejection puts at risk**. An external registry commits per leaf
and per activity rather than per batch, so a result carrying accepted and
rejected rows together is an ordinary outcome, not an error. A rejected
**output** orphans bytes that exist nowhere but the step tree, so it is
**terminal** — it fails the step loudly rather than finishing green — and so is
any rejection cascaded from a real one. A rejection of a file that no activity
references registers nothing, so it orphans nothing: it is logged with its path
and reason, and the step continues. Byte sync is attempted whatever registration
returned, because it uploads exactly the rows registration accepted, while a
registration error remains the cause the step fails on.

A ref that cannot be hashed is dropped from lineage, whatever put it out of
reach: a **directory** (e.g. `ls` of a mount), a read **resolving outside the
analysis tree** (e.g. `/{resourceId}/..`, the container root, which the sandbox
may legitimately open), and a read naming a path that is **not there at all**.
None of the three is drift. The last one is not even evidence that something
was read: the capture layers report *attempted* operations — the Python audit
hook fires ahead of the open, R's `trace()` at call entry — so a read that failed
arrives indistinguishable from one that succeeded, and CPython's own traceback
printer manufactures them by the dozen (a relative Cython `co_filename` sends it
opening `<entry>/<basename>` down all of `sys.path`). Dropping upholds "never
register a hashless lineage edge" exactly as a throw would, without destroying a
legitimate analysis that has already produced its outputs; what remains terminal
is a `stat` that fails some *other* way, where the file is there and cannot be
read. The enrichment stages — file-metadata, step-summary, vector-index — stay
best-effort and keep degrading via `safeRun`, because they are search/UX quality,
not integrity.

The ledger is a thin index: identity (`path`, `hash`, `size`), provenance
(`source_step`, `source_run`), and optional external registration state
(`artifact_id`, `file_id`). It stores no file descriptions — the per-analysis
vector index is the sole source of truth for descriptions and discovery.
## Requirements
### Requirement: The step manifest is a disk walk of the writable step directory

The per-step artifact manifest SHALL be produced by `walkStepArtifacts`, which
recursively walks the step's writable directory (`writePrefix`,
`runs/{runId}/{stepId}/...`), and for each regular file emits an
`ArtifactManifestEntry` of `{ stepId, runId, path, size, type, hash }` where
`path` is relative to `writePrefix`, `hash` is the SHA-256 computed from disk via
`computeSha256File`, and `type` is inferred from the path subdirectory by
`inferArtifactType` (`output` | `figure` | `script` | `log` | `notebook`). The
walk SHALL skip directories in `IGNORED_DIRS`. The manifest SHALL NOT be built
from `ProvenanceCollector.getRecords()` — the collector holds lineage edges, not
the manifest.

#### Scenario: Step produces agent-written and command-produced files

- **GIVEN** a step wrote `scripts/analysis.py` via `write_file` and then ran it, producing `output/results.csv`, `figures/volcano.png`, and `logs/run.log`
- **WHEN** `walkStepArtifacts` walks the step's writable directory
- **THEN** all five files appear in the manifest, each with a SHA-256 hash computed from disk and the type inferred from its subdirectory
- **AND** no provenance-collector record is consulted to build the manifest

#### Scenario: Ignored directories are not walked

- **WHEN** the step directory contains a path under an `IGNORED_DIRS` directory
- **THEN** files under that directory do NOT appear in the manifest

### Requirement: cortex_artifacts is the local ledger

The `cortex_artifacts` table SHALL be the local ledger for file registration and
provenance tracking. Each row SHALL carry: `analysis_id` (TEXT, NOT NULL),
`path` (TEXT, NOT NULL — analysis-relative canonical path), `hash` (TEXT, NOT
NULL), `size` (BIGINT, NOT NULL), `role` (TEXT, NOT NULL — one of `'input'` or
`'step_output'`), `source_step` (TEXT, nullable), `source_run` (TEXT, nullable),
`artifact_id` (TEXT, nullable — external artifact ID, set only when the registry
returns one), `file_id` (TEXT, nullable — external file ID, set only when an
adapter syncs bytes), `file_type` (TEXT, nullable), `unrecoverable_at` (TEXT,
nullable), and `created_at` (TEXT, NOT NULL). The primary key is `(analysis_id,
path)`. The table SHALL NOT store file descriptions or metadata — the vector
index owns those.

#### Scenario: Artifact registered with canonical path

- **WHEN** a step produces `output/results.csv` in the sandbox
- **THEN** the artifact is registered with `path = 'runs/{runId}/{stepId}/output/results.csv'`
- **AND** `hash` contains the SHA-256 content hash and `role = 'step_output'`

### Requirement: The manifest is reconciled against disk before registration

`reconcileManifestWithDisk(input)` SHALL run after the sandbox is destroyed and
before any artifact is registered or synced. For each manifest entry it SHALL
stat the file at `{workspaceRoot}/runs/{runId}/{stepId}/{entry.path}`, bounded
to the step root, and:

- If the file does not exist (`ENOENT`) → drop the entry from the returned manifest, call `collector.removeRecord(path)`, increment the `cortex.artifact.reconcile.dropped` counter (tagged `agent_id`), and emit a debug log line.
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
counter, tagged `agent_id` and `reason` (`directory`,
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

### Requirement: Registration through the ArtifactRegistry seam

`registerStepArtifacts(db, registry, input, session)` SHALL: (1) build the
`cortex_artifacts` rows from the reconciled manifest — `role = 'step_output'`,
`path` prefixed `runs/{runId}/{stepId}/`, `file_type` from the entry's inferred
type — and upsert them; (2) call the injected `ArtifactRegistry.register(input,
session)`; (3) write each returned external id back via `updateArtifactId` for
paths the local upsert owns. It SHALL return `{ localCount, externalRegistered,
externalFailed, failureDetails }`. When the artifacts array is empty it SHALL
return all-zero counts immediately and SHALL NOT call the registry.

The registry's outcome is partial by contract — it commits per leaf and per
activity, with no batch-wide rollback — so `registered` and `failed` arriving
together describes a normal registration. `failed`, surfaced as
`failureDetails`, and `failedCount`, surfaced as `externalFailed`, SHALL both
describe only the **terminal** rejections: a rejected artifact whose bytes exist
nowhere but the step tree, and any rejection cascaded from one — a row the
registry rejected as a consequence of a genuine failure. A rejection of a file
that no activity in the payload references SHALL NOT appear in either, because
it registers nothing and so puts no bytes at risk. The two move together so that
the fail-fast message lists exactly the paths that cost the step something: a
`failed` array padded with harmless rejections would name them, during an
incident, in the same breath and the same format as the real ones.

A rejection the registry excludes SHALL still be reported, in `notCounted`, and
`registerStepArtifacts` SHALL log a warn record naming each such path and the
registry's reason for it. Excluding a rejection decides only that it is not
worth failing a step over; it is never licence to drop it silently, because that
record is the only place a reader can check the verdict against what the
external system actually said. The log SHALL be emitted by
`registerStepArtifacts` rather than left to the registry: the seam is
implementable by an embedder, and a rejection does not get to go unrecorded
because one implementation chose not to log it.

#### Scenario: Successful registration

- **WHEN** `registerStepArtifacts` is called with 3 reconciled artifacts
- **THEN** 3 rows are upserted into `cortex_artifacts`, the registry's `register` is called, returned external ids are stored via `updateArtifactId`, and the result is `{ localCount: 3, externalRegistered: 3, externalFailed: 0, failureDetails: [] }`

#### Scenario: External registration partially fails

- **WHEN** the registry returns some of the step's outputs in `failed`
- **THEN** accepted artifacts get their `artifact_id` stored, rejected ones retain `artifact_id = NULL`, and `externalFailed` reflects the count of terminal rejections

#### Scenario: A rejection that nothing references is surfaced, not counted

- **WHEN** the registry accepts every row except a file that no activity in the payload references
- **THEN** `notCounted` carries that path with the registry's reason, a warn record names the path and that reason, and both `externalFailed` and `failureDetails` are empty

#### Scenario: Empty artifact list short-circuits

- **WHEN** `registerStepArtifacts` is called with an empty artifacts array
- **THEN** it returns `{ localCount: 0, externalRegistered: 0, externalFailed: 0, failureDetails: [] }` and the registry is NOT called

### Requirement: Integrity stages fail-fast; enrichment stages degrade

`reconcileAndRegisterStepArtifacts` SHALL reconcile, then register, and the
sandbox-step body SHALL then `ArtifactRegistry.sync` the step's artifacts. The
sequence is fail-fast: a non-zero `externalFailed` SHALL throw with the per-file
failure detail, and the sandbox-step body SHALL tear down the sandbox, mark the
step failed, and re-raise so the parent's fail-fast cascade fires.

Byte sync SHALL be attempted whatever registration returned, including when
registration threw. Sync is defined over the rows registration accepted
(`artifact_id IS NOT NULL AND file_id IS NULL`), so attempting it after a throw
uploads exactly those rows and reaches nothing that was rejected — whereas
skipping it leaves every accepted artifact registered and never uploaded,
orphaned by the very throw raised to prevent orphaning. A registration error
SHALL remain the surfaced cause: a sync failure that follows one SHALL be logged
with its own detail and SHALL NOT replace the registration error the step fails
on. The OSS `createNoopArtifactRegistry` returns `externalFailed: 0` and never
trips this.

The enrichment stages — file-metadata generation, step-summary generation, and
vector indexing — SHALL run under `safeRun`/`safeRunValue` so any single failure
degrades without failing the step.

Within the vector-index stage, degradation SHALL be per-item: each surviving
file description and the step summary SHALL be embedded and upserted under its
own failure boundary, so one rejected input costs only its own index entry and
every remaining item is still attempted. Index setup (ensuring the search index
exists and constructing the store) SHALL remain all-or-nothing — a setup failure
degrades the whole stage. Each per-item failure SHALL be logged with the item's
id and input text length, and when at least one item fails the stage SHALL log a
summary carrying the counts of items indexed and items failed — a partial index
returns fewer search hits rather than an error, so the logged counts are the
only signal that degradation occurred.

#### Scenario: An output rejection fails the step

- **WHEN** `reconcileAndRegisterStepArtifacts` gets `externalFailed > 0` from registration
- **THEN** it throws with the per-file detail and the step is marked failed

#### Scenario: A rejection that orphans nothing does not fail the step

- **GIVEN** a step whose outputs all registered and whose only rejection is a file no activity references
- **WHEN** `reconcileAndRegisterStepArtifacts` runs
- **THEN** `externalFailed` is `0`, the rejection is logged with its path and reason, and the step completes with its artifacts synced

#### Scenario: Registered bytes sync even when registration throws

- **GIVEN** registration that accepted most of the step's artifacts and threw on a rejected output
- **WHEN** the sandbox-step body handles the throw
- **THEN** `ArtifactRegistry.sync` is still attempted, the accepted rows are uploaded, and the step fails with the registration error as its cause

#### Scenario: A degraded enrichment stage does not fail the step

- **WHEN** vector indexing throws while indexing a step's outputs
- **THEN** the failure is logged and swallowed and the step still completes

#### Scenario: One rejected input costs only its own entry

- **WHEN** embedding one file description fails while the step has other file descriptions and a summary
- **THEN** every other file description and the summary are still embedded and upserted, and the step completes

#### Scenario: Partial indexing is observable in the logs

- **WHEN** at least one item fails to index while others succeed
- **THEN** each failed item is logged with its id and text length, and a summary log reports the indexed and failed counts

#### Scenario: Index setup failure degrades the whole stage

- **WHEN** ensuring the search index exists fails before any item is indexed
- **THEN** the stage logs the failure and indexes nothing, and the step still completes

### Requirement: Artifact upsert semantics

`upsertArtifact` and `upsertArtifacts` SHALL use a Postgres `INSERT ... ON
CONFLICT (analysis_id, path) DO UPDATE` that updates `hash`, `size`, `role`,
`source_step`, `source_run`, and `COALESCE`s `file_type` and `file_id`.
`upsertArtifacts` SHALL write every entry in a single round-trip via a multi-row
`INSERT ... VALUES (...), (...), ...`. Re-execution of a step SHALL update the
existing row rather than fail on the duplicate key.

#### Scenario: Re-execution updates the existing row

- **WHEN** a step is re-executed and produces the same output path
- **THEN** the existing `cortex_artifacts` row is updated with the new `hash`, `size`, and `source_run`, and no duplicate row is created

### Requirement: Optional external sync tracking

`cortex_artifacts` SHALL track external sync state via `artifact_id` (set after
external registration by `updateArtifactId`) and `file_id` (set when an adapter
reports an external file identity, applied in batch by `updateFileIds`). A
registry realization with no external system (the OSS noop) MAY leave both null
because the bytes already live in the local workspace tree. `queryUnsyncedStepArtifacts(pool, resourceId, runId,
stepId)` SHALL return step-output rows where `artifact_id IS NOT NULL AND file_id
IS NULL`, ordered by `created_at`.

#### Scenario: Query step artifacts awaiting byte sync

- **WHEN** `queryUnsyncedStepArtifacts(pool, resourceId, runId, stepId)` is called
- **THEN** it returns rows with `artifact_id IS NOT NULL AND file_id IS NULL AND role = 'step_output'`, ordered by `created_at`

#### Scenario: External sync lifecycle

- **WHEN** an artifact is first upserted
- **THEN** `artifact_id` and `file_id` are both NULL
- **WHEN** external registration succeeds
- **THEN** `artifact_id` is set via `updateArtifactId`
- **WHEN** an adapter reports an external file identity
- **THEN** `file_id` is set via `updateFileIds`

### Requirement: Manifest is scoped per analysis with cross-run visibility

`cortex_artifacts` SHALL hold all runs of an analysis in one table, queryable by
`source_run`; the flat read-only mount gives filesystem access to all runs.
Agents discover cross-run files via workspace vector search, not by reading the
artifact table directly.

#### Scenario: A new run finds prior-run artifacts via search

- **WHEN** a step in run-2 runs `workspace_search("normalized expression matrix")`
- **THEN** results MAY include files from run-1 (e.g. `runs/run-01/qc/output/normalized.csv`)
- **AND** the file is accessible via the flat read-only mount

