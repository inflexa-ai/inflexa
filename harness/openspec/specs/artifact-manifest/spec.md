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

**Content-attested lineage, fail-fast for integrity.** The sandbox provenance
frame is path-only — it reports
which files were read and written, never their bytes. So Cortex recomputes
SHA-256 hashes from disk at `reconcileManifestWithDisk` for **every surviving
output** and **every tracked input**, and registers those. Output hashes must be
re-read because outputs mutate during the step (a long-running script flushes
after the frame fires; an atomic-rename swaps content under a stable byte count);
input hashes can be read from disk now because inputs are immutable for the
step's lifetime (the analysis tree is mounted read-only; the only writable mount
is the step's own directory). This makes the registered hash equal `sha256sum` of
the bytes the sync target receives at upload time. The reconcile/register/sync
stages are pulled out of the best-effort net: an input that cannot be hashed
(missing, or resolving outside the analysis tree) and a registry rejection are
**terminal** — they fail the step loudly rather than orphaning real outputs
green. Genuine *file* drift fails fast; a read that resolves to a **directory**
(e.g. `ls` of a mount) is not a content-attestable artifact and is dropped from
lineage instead. The enrichment stages — file-metadata, step-summary,
vector-index — stay best-effort and keep degrading via `safeRun`, because they
are search/UX quality, not integrity.

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

Before registration, the draft manifest SHALL be reconciled against disk by
`reconcileManifestWithDisk`. For each manifest entry the helper SHALL stat the
absolute step path (`{sessionPath}/{resourceId}/runs/{runId}/{stepId}/{path}`),
bounded to the step root, and:

- If the file does not exist (`ENOENT`) → drop the entry from the returned manifest, call `collector.removeRecord(path)`, increment the `cortex.artifact.reconcile.dropped` counter (tagged `agent_id`, `step_id`), and emit a debug log line.
- If the path is not a regular file (a directory) → drop it the same way.
- Otherwise → recompute SHA-256 from disk via `computeSha256File` and replace the entry's `hash` and `size` with the on-disk values.

Every surviving entry SHALL be re-hashed from disk — there is no matched-size
fast path that skips hashing. The reconcile step SHALL also content-attest the
collector's tracked inputs via `fillInputHashesFromDisk`: for each tracked input
that is not an `artifacts`-source read and lacks a valid content hash, it maps
the container path onto the host session tree, bounds it to
`{sessionPath}/{resourceId}`, and hashes the file from disk. A directory input is
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

### Requirement: Registration through the ArtifactRegistry seam

`registerStepArtifacts(db, registry, input, session)` SHALL: (1) build the
`cortex_artifacts` rows from the reconciled manifest — `role = 'step_output'`,
`path` prefixed `runs/{runId}/{stepId}/`, `file_type` from the entry's inferred
type — and upsert them; (2) call the injected `ArtifactRegistry.register(input,
session)`; (3) write each returned external id back via `updateArtifactId` for
paths the local upsert owns. It SHALL return `{ localCount, externalRegistered,
externalFailed, failureDetails }`. When the artifacts array is empty it SHALL
return all-zero counts immediately and SHALL NOT call the registry.

#### Scenario: Successful registration

- **WHEN** `registerStepArtifacts` is called with 3 reconciled artifacts
- **THEN** 3 rows are upserted into `cortex_artifacts`, the registry's `register` is called, returned external ids are stored via `updateArtifactId`, and the result is `{ localCount: 3, externalRegistered: 3, externalFailed: 0, failureDetails: [] }`

#### Scenario: External registration partially fails

- **WHEN** the registry returns some entries in `failed`
- **THEN** accepted artifacts get their `artifact_id` stored, rejected ones retain `artifact_id = NULL`, and `externalFailed` reflects the rejection count

#### Scenario: Empty artifact list short-circuits

- **WHEN** `registerStepArtifacts` is called with an empty artifacts array
- **THEN** it returns `{ localCount: 0, externalRegistered: 0, externalFailed: 0, failureDetails: [] }` and the registry is NOT called

### Requirement: Integrity stages fail-fast; enrichment stages degrade

`reconcileAndRegisterStepArtifacts` SHALL reconcile, then register, then
`ArtifactRegistry.sync` the step's artifacts, and SHALL treat the whole sequence
as fail-fast: a non-zero `externalFailed` SHALL throw with the
per-file failure detail, and the sandbox-step body SHALL tear down the sandbox,
mark the step failed, and re-raise so the parent's fail-fast cascade fires. The
OSS `FilesystemArtifactRegistry` returns `externalFailed: 0` and never trips
this. The enrichment stages — file-metadata generation, step-summary generation,
and vector indexing — SHALL run under `safeRun`/`safeRunValue` so any single
failure degrades without failing the step.

#### Scenario: Registry rejection fails the step

- **WHEN** `reconcileAndRegisterStepArtifacts` gets `externalFailed > 0` from registration
- **THEN** it throws with the per-file detail and the step is marked failed

#### Scenario: A degraded enrichment stage does not fail the step

- **WHEN** vector indexing throws while indexing a step's outputs
- **THEN** the failure is logged and swallowed and the step still completes

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
reports an external file identity, applied in batch by `updateFileIds`). The
filesystem registry MAY leave both null because the bytes already live in the
local session tree. `queryUnsyncedStepArtifacts(pool, resourceId, runId,
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
