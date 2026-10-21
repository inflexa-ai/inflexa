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

`inferArtifactType` SHALL read a folder segment `figures`, `scripts`, `logs`, or
`notebooks` at the start of the path or after a `/`. Thus a relative path and a
rooted path give the same type. A path with none of these folder segments gives
`output`. A segment that only starts with a folder name, for example
`figures_raw`, is not that folder.

#### Scenario: Step produces agent-written and command-produced files

- **GIVEN** a step wrote `scripts/analysis.py` via `write_file` and then ran it, producing `output/results.csv`, `figures/volcano.png`, and `logs/run.log`
- **WHEN** `walkStepArtifacts` walks the step's writable directory
- **THEN** all four files appear in the manifest, each with a SHA-256 hash computed from disk and the type inferred from its subdirectory
- **AND** no provenance-collector record is consulted to build the manifest

#### Scenario: A top-level folder of the step gives its type

- **WHEN** `inferArtifactType` reads `figures/volcano.png`, `scripts/a.py`, `logs/run.log`, and `notebooks/n.ipynb`
- **THEN** the types are `figure`, `script`, `log`, and `notebook`

#### Scenario: A nested folder gives its type

- **WHEN** `inferArtifactType` reads `output/figures/volcano.png` and `/a1/runs/r1/s1/figures/volcano.png`
- **THEN** each type is `figure`

#### Scenario: A file outside the typed folders is output

- **WHEN** `inferArtifactType` reads `output/results.csv`, `summary.md`, and `figures_raw/x.png`
- **THEN** each type is `output`

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
paths the local upsert owns. If `register` gives `ok`, `registerStepArtifacts` MUST return
`{ localCount, externalRegistered, externalFailed, failureDetails }` as an `ok` value. When the artifacts array is
empty it SHALL return all-zero counts immediately and SHALL NOT call the registry.

`ArtifactRegistry.register` MUST be a gate, as the host-hooks capability describes. It MUST return
`ResultAsync<ExternalRegistrationResult, GateFailure>`, and it MUST give a failure as an `err`, never as a throw. A
partial outcome MUST be an `ok` value, not an `err`. If `register` gives an `err`, `registerStepArtifacts` MUST write
no external id, and it MUST return that refusal as an `err` of the variant `refused`. The upserted rows stay in the
ledger with `artifact_id = NULL`. The step then records the failure with the reason of the host.

If a write of the local ledger fails, `registerStepArtifacts` MUST stop at that write. It MUST return the `DbError` as
an `err` of the variant `ledger_failed`, and it MUST NOT throw. The step then fails the same as for a refusal that does
not suspend.

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

#### Scenario: A register err fails the registration

- **GIVEN** a registry whose `register` gives `errAsync({ reason: "r", suspend: false })`
- **WHEN** the harness calls `registerStepArtifacts` with 3 reconciled artifacts
- **THEN** `cortex_artifacts` holds 3 rows with `artifact_id = NULL`
- **AND** `registerStepArtifacts` returns an `err` of the variant `refused` that carries the reason `r`, and it does not throw

#### Scenario: A failed ledger write fails the registration

- **GIVEN** a ledger connection whose write fails
- **WHEN** the harness calls `registerStepArtifacts` with 3 reconciled artifacts
- **THEN** `registerStepArtifacts` returns an `err` of the variant `ledger_failed` that carries the `DbError` of the upsert, and it does not throw

### Requirement: Integrity stages fail-fast; enrichment stages degrade

`reconcileAndRegisterStepArtifacts` SHALL reconcile, then register, and the
sandbox-step body SHALL then `ArtifactRegistry.sync` the step's artifacts. Registration is fail-fast. A gate `err`
from `register` or a non-zero `externalFailed` MUST fail the registration, with the reason of the host or the per-file
failure detail. Then the sandbox-step body MUST remove the sandbox, mark the step failed, and throw, so that the
fail-fast cascade of the parent starts. If the gate `err` has `suspend: true`, the step MUST suspend in place of the
failure, as the `workflow-suspension` capability describes. The OSS `createNoopArtifactRegistry` returns `externalFailed: 0` and never
trips this.

The sandbox-step body MUST try the byte sync after each registration, also after a failed registration. Sync selects
only the rows that registration accepted (`artifact_id IS NOT NULL AND file_id IS NULL`). Thus a sync after a failed
registration uploads exactly those rows and reaches no rejected row. If the body does not do the sync, each accepted
artifact stays registered but not uploaded. A registration failure MUST stay the cause that the step fails on.

`ArtifactRegistry.sync` MUST be a notice, as the host-hooks capability describes. It MUST return
`ResultAsync<void, NoticeFailure>`. If `sync` gives an `err`, the body MUST log the reason at the error level, and the
outcome of the step MUST NOT change. A sync `err` MUST NOT replace a registration failure as the cause of the step
failure. The rows stay unsynced, thus `queryUnsyncedStepArtifacts` selects them again at a later sync of the step.

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
- **THEN** the registration fails with the per-file detail, and the body marks the step failed

#### Scenario: A rejection that orphans nothing does not fail the step

- **GIVEN** a step whose outputs all registered and whose only rejection is a file no activity references
- **WHEN** `reconcileAndRegisterStepArtifacts` runs
- **THEN** `externalFailed` is `0`, the rejection is logged with its path and reason, and the step completes with its artifacts synced

#### Scenario: Registered bytes sync even when registration fails

- **GIVEN** registration that accepted most of the step's artifacts and failed on a rejected output
- **WHEN** the sandbox-step body gets the failure
- **THEN** the body still tries `ArtifactRegistry.sync`, the sync uploads the accepted rows, and the step fails with the registration failure as its cause

#### Scenario: A register err fails the step

- **GIVEN** a registry whose `register` gives `errAsync({ reason: "r", suspend: false })`
- **WHEN** the sandbox-step body registers the artifacts of the step
- **THEN** the body still tries `ArtifactRegistry.sync`
- **AND** the step fails with the reason `r` as its cause

#### Scenario: A register err with suspend suspends the step

- **GIVEN** a registry whose `register` gives `errAsync({ reason: "r", suspend: true })`
- **WHEN** the sandbox-step body registers the artifacts of the step
- **THEN** the step suspends with the reason `r`, and it does not fail

#### Scenario: A sync err does not fail the step

- **GIVEN** registration that accepted each output, and a `sync` that gives `errAsync({ reason: "s" })`
- **WHEN** the sandbox-step body syncs the artifacts of the step
- **THEN** the body logs the reason `s` at the error level, and the step completes
- **AND** `queryUnsyncedStepArtifacts` still selects the accepted rows

#### Scenario: A sync err keeps the registration failure as the cause

- **GIVEN** registration that failed, and a `sync` that gives an `err`
- **WHEN** the sandbox-step body gets the two failures
- **THEN** the step fails with the registration failure as its cause
- **AND** the body logs the reason of the sync `err` at the error level

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

### Requirement: The artifact ledger helpers give a Result

`src/state/artifacts.ts` MUST export these helpers. Each helper takes a `Querier` first and returns
`ResultAsync<…, DbError>`:

- `upsertArtifact(pool, entry)` and `upsertArtifacts(pool, entries)`: the upserts of the artifact upsert semantics requirement.
- `queryInputArtifacts(pool, analysisId, paths)`: the `input` rows at the paths.
- `queryUnsyncedStepArtifacts(pool, resourceId, runId, stepId)`: the rows of the optional external sync tracking requirement.
- `queryStepArtifactPaths(pool, resourceId, runId, stepId, limit)`: the step outputs of a step, most consequential first.
- `queryAnalysisArtifacts(pool, analysisId)`: each artifact of an analysis, ordered by path.
- `queryArtifactPage(pool, analysisId, query)`: one page of the ledger of an analysis, and the count of the rows that its filters select.
- `countArtifactsByRuns(pool, analysisId, runIds)`: the count of the step outputs of each run of a list.
- `updateArtifactId(pool, resourceId, path, artifactId, fileType?)` and `updateFileIds(pool, pairs)`: the sync writes.

A driver failure MUST be an `err`, never a throw. Absence rides the `ok` channel as `[]` or `0`. A workflow body or a
step body changes an `err` into a throw with `unwrapOrThrow`. Each other caller keeps the Result.

#### Scenario: A driver failure is an err

- **GIVEN** a `Querier` whose query rejects
- **WHEN** the harness calls `upsertArtifacts`
- **THEN** it gives an `err` with the `op` `artifacts.upsertArtifacts`, and it does not throw

#### Scenario: No matching row is an empty ok

- **WHEN** the harness calls `queryInputArtifacts` with paths that no `input` row holds
- **THEN** it gives `ok([])`

### Requirement: One read gives a page of the artifact ledger of an analysis

The state module MUST give a paged read of the artifact ledger. The read takes a `Querier`, an analysis id, the filters, a sort, a limit, and an offset. It MUST give the entries of one page, `total`, and `extensionCounts`. `total` is the exact count of the rows that the filters select.

The read MUST give each ledger row of the analysis that the filters select. This includes an `input` row, a `step_output` row, and a row that carries `unrecoverable_at`. Each entry MUST carry these fields:

- `path`, the workspace-relative path of the row
- `size`, in bytes, as a number
- `fileType`, the `file_type` of the row, or `null`
- `role`, `input` or `step_output`
- `runId` and `stepId`, the `source_run` and the `source_step` of the row, or `null`
- `createdAt`, as the ledger stores it

The extension of a path is the text after the last dot of the file name, in lower case. The file name is the part of the path after the last `/`. A file name has no extension in each of these cases:

- It has no dot.
- Its only dot is its first character.
- It ends with a dot.

Thus `runs/r1/s1/figures/Volcano.PNG` has the extension `png`, and `a.tar.gz` has `gz`. `.bashrc` and `notes.` have no extension.

The filters MUST combine with AND. A filter that is absent MUST select each row:

- `runId` selects the rows whose `source_run` is equal to the value.
- `stepId` selects the rows whose `source_step` is equal to the value.
- `fileType` selects the rows whose `file_type` is equal to the value.
- `q` selects the rows whose path holds the value, with no regard to case. Each character of `q` MUST match only itself, thus `%` and `_` are not wildcards.
- `path` selects the row whose path is equal to the value. Case is significant.
- `extensions` is a list of extensions in lower case. It selects the rows whose path has an extension that is in the list. A row with no extension never matches. An empty list MUST select each row.

`extensionCounts` MUST give one entry `{ extension, count }` for each extension that a selected row has. It MUST give one entry with `extension` `null` for the selected rows that have no extension. It MUST give no entry with a count of 0. The entries MUST be in the order of the extension, and the `null` entry MUST come last. The sum of the counts MUST be equal to `total`. The entries do not depend on the sort, the limit, or the offset.

The sort `path` MUST order the entries by path. The sort `recent` MUST order the entries by `created_at`, newest first, and the path MUST break a tie. The read MUST give at most `limit` entries, from the position `offset` of the sort.

The read MUST send at most two statements, whatever the filters, the limit, and the size of the ledger. Each statement MUST select the rows of the one analysis through the leading column of the primary key. Thus the read never visits a row of a different analysis. A failed query MUST ride the error channel as a `DbError`.

#### Scenario: The figures that match a text

- **GIVEN** analysis `a1` with `runs/r1/s1/figures/Volcano.png` and `runs/r2/s3/figures/volcano_up.png` of the type `figure`, and `runs/r1/s1/output/volcano.csv` of the type `output`
- **WHEN** the read runs for `a1` with `fileType` `figure` and `q` `VOLCANO`
- **THEN** it gives the two figures in path order, each with its run and its step, and `total` is 2

#### Scenario: A wildcard character matches only itself

- **GIVEN** analysis `a1` with `runs/r1/s1/output/a_b.csv` and `runs/r1/s1/output/axb.csv`
- **WHEN** the read runs with `q` `a_b`
- **THEN** it gives only `runs/r1/s1/output/a_b.csv`

#### Scenario: The newest artifacts come first

- **GIVEN** three rows of analysis `a1` that were registered at different times
- **WHEN** the read runs with the sort `recent`
- **THEN** the newest row comes first

#### Scenario: A page past the end

- **GIVEN** analysis `a1` with 3 ledger rows
- **WHEN** the read runs with a limit of 2 and an offset of 4
- **THEN** it gives no entry, `total` is 3, and the counts of `extensionCounts` sum to 3

#### Scenario: The rows of a different analysis stay out

- **GIVEN** analysis `a1` with `runs/r1/s1/output/x.csv` and analysis `a2` with `runs/r9/s1/output/x.csv`
- **WHEN** the read runs for `a1` with `q` `x.csv`
- **THEN** it gives only the row of `a1`

#### Scenario: An exact path selects one row

- **GIVEN** analysis `a1` with `runs/r1/s1/output/de.csv` and `runs/r2/s1/output/de.csv.bak`
- **WHEN** the read runs with `path` `runs/r1/s1/output/de.csv`
- **THEN** it gives only that row, with the run `r1` and the step `s1`, and `total` is 1

#### Scenario: An exact path is case-sensitive

- **GIVEN** analysis `a1` with `runs/r1/s1/output/de.csv`
- **WHEN** the read runs with `path` `runs/r1/s1/output/DE.csv`
- **THEN** it gives no entry, and `total` is 0

#### Scenario: The figures by their extensions

- **GIVEN** analysis `a1` with `runs/r1/s1/figures/a.PNG`, `runs/r1/s1/output/b.svg`, `runs/r1/s1/output/c.csv`, and `runs/r1/s1/output/README`
- **WHEN** the read runs with `extensions` `png` and `svg`
- **THEN** it gives the two images in path order, and `total` is 2

#### Scenario: The count of each extension of a run

- **GIVEN** run `r1` of analysis `a1` with `runs/r1/s1/figures/a.png`, `runs/r1/s1/figures/b.PNG`, `runs/r1/s1/output/c.csv`, and `runs/r1/s1/output/README`
- **AND** run `r2` with `runs/r2/s1/output/d.csv`
- **WHEN** the read runs with `runId` `r1` and a limit of 1
- **THEN** it gives one entry, and `total` is 4
- **AND** `extensionCounts` is `csv` with 1, `png` with 2, and `null` with 1, in this order

#### Scenario: The counts follow the filters

- **GIVEN** analysis `a1` with `runs/r1/s1/figures/a.png` and `runs/r1/s1/output/c.csv`
- **WHEN** the read runs with `extensions` `png`
- **THEN** `extensionCounts` is `png` with 1 only

#### Scenario: The statement count does not grow with the page

- **WHEN** the read runs with a limit of 1, and again with a limit of 200 and each filter
- **THEN** each read sends the same count of statements, and the count is at most 2

### Requirement: One read gives the artifact count of each run of a list

The state module MUST give a grouped read that takes a `Querier`, an analysis id, and a list of run ids. It MUST give one entry `{ runId, count }` for each run of the list that has a `step_output` row of the analysis. A run with no such row MUST have no entry, and a caller reads it as 0. The count MUST cover the `step_output` rows only, thus an `input` row never counts.

The read MUST run as one SQL statement for the whole list. An empty list MUST give an empty result and send no query. A failed query MUST ride the error channel as a `DbError`.

The run-completed card MUST get its artifact count from this read, with the one run of the card.

#### Scenario: The counts of a page of runs

- **GIVEN** run `r1` with 3 step outputs, run `r2` with no step output, and an input row of the analysis
- **WHEN** the read runs for `[r1, r2]`
- **THEN** it gives one entry, `r1` with the count 3

#### Scenario: One statement serves the list

- **WHEN** the read runs for a list of 20 run ids
- **THEN** it sends one query

### Requirement: The package root exports the artifact list reads

The root barrel of the package MUST export the paged ledger read, the grouped run count, and the types of their query and their entries. The type of an entry of `extensionCounts` is one of these types. An embedder MUST reach them with no deep import.

#### Scenario: An embedder imports the reads from the root

- **WHEN** an embedder imports the two reads and their types from `@inflexa-ai/harness`
- **THEN** the imports resolve
