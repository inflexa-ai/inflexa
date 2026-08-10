# analysis-purge Specification

## Purpose

Define what constitutes an analysis's persisted footprint in Postgres, and the
harness-owned operation that reclaims all of it. `purgeAnalysis(analysisId)` is
the single place that knows the footprint's extent, so no embedder enumerates
tables to delete an analysis.

The footprint is larger than the `cortex_*` ledgers. Measured on a live database,
an analysis's runs and their child step workflows hold roughly sixteen megabytes
of durability-engine step outputs against under two megabytes across every
analysis-keyed application table and the per-analysis vector index combined — the
sandbox agent transcripts and run-event streams live in the engine's ledger, not
in the harness's own tables. A purge that skipped them would reclaim a small
fraction of what it claims while destroying the only mapping that could ever
reach the rest, since `cortex_runs.run_id` *is* the parent workflow id. The
engine is reached through the `WorkflowPurger` seam, which keeps the durability
engine out of the state layer.

This spec covers the operation's coverage and ordering, the refusal it raises
before destroying anything, its idempotence and reporting, the precondition a
host owes it, and — stated as normative, so absent coverage is never mistaken
for delivered coverage — what it deliberately does not reach.

## Requirements

### Requirement: The harness owns a complete analysis purge

The harness SHALL expose `purgeAnalysis(analysisId)` as a host-agnostic operation that removes an analysis's entire persisted Postgres footprint, built via a dependency-injected factory closure over its construction deps (`Pool`, the workflow-purge seam, and an optional `Logger`) per the harness composition pattern. It SHALL be the single place that knows what an analysis's footprint is, so no embedder has to enumerate tables to delete an analysis. It SHALL take the `analysisId` alone — every keyed store and the analysis's dynamic vector-index name are derivable from it, so no caller supplies a slug, a run list, or a workflow id.

#### Scenario: A purged analysis leaves no analysis-keyed row

- **GIVEN** an analysis with threads, messages, artifacts, runs, step executions, plans, working memory, asks, ask grants, and analysis state
- **WHEN** `purgeAnalysis` completes successfully for it
- **THEN** no row keyed to that `analysis_id` remains in any of those tables

#### Scenario: The caller supplies only the analysis id

- **WHEN** a host purges an analysis
- **THEN** it passes the `analysisId` and nothing else, and the operation resolves every store and index name itself

### Requirement: Purge covers the analysis-keyed tables, the vector index, and the workflow footprint

`purgeAnalysis` MUST remove this footprint:

- the analysis rows of `cortex_analysis_state`, `cortex_artifacts`, `cortex_runs`, `cortex_step_executions`, `cortex_plans`, `cortex_report_versions`, `cortex_analysis_threads`, `cortex_working_memory`, `cortex_asks`, and `cortex_ask_grants`
- the `messages` rows of each thread of the analysis
- the dynamic pgvector table with the shared `searchIndexName(analysisId)` name
- the DBOS workflow footprint of the analysis

Coverage of the workflow footprint is normative, and it is not optional. The DBOS rows carry the sandbox agent transcripts and the run-event stream, and they are the dominant share of the stored bytes. Thus a purge that omits them reclaims a small fraction, but it still presents itself as final.

#### Scenario: The dynamic vector table is dropped

- **GIVEN** an analysis whose workspace index table exists under the `searchIndexName(analysisId)` name
- **WHEN** `purgeAnalysis` completes successfully
- **THEN** that table no longer exists

#### Scenario: An absent vector table is not an error

- **GIVEN** an analysis that never had a workspace index table created
- **WHEN** `purgeAnalysis` runs
- **THEN** it succeeds and reports no vector index dropped

#### Scenario: Messages are reached through the analysis's threads

- **GIVEN** an analysis with some threads, each with messages
- **WHEN** `purgeAnalysis` completes successfully
- **THEN** no `messages` row remains for any of those threads

#### Scenario: The workflow footprint is removed

- **GIVEN** an analysis with a completed run whose parent and child step workflows are recorded in the DBOS ledger
- **WHEN** `purgeAnalysis` completes successfully
- **THEN** those workflows' status rows are gone and the step-output, stream, input, event, and queue rows that depend on them are gone with them

#### Scenario: The report versions are removed

- **GIVEN** an analysis with a report thread that recorded two versions
- **WHEN** `purgeAnalysis` completes successfully
- **THEN** no `cortex_report_versions` row remains for the analysis

### Requirement: Purge collects workflow identity before deleting the rows that carry it

`purgeAnalysis` SHALL read the analysis's workflow identifiers before deleting the ledger rows that record them, because those rows are the only mapping from an analysis to its workflows. It SHALL resolve the run workflows from `cortex_runs.run_id` (which is the parent workflow id directly) together with their descendants, and the data-profile workflows from the `dataprofile:{analysisId}:` id namespace. Deleting `cortex_runs` before capturing its `run_id` values SHALL be treated as a defect, since it strands the largest part of the footprint permanently out of reach.

#### Scenario: Run identity is captured before the ledger is deleted

- **GIVEN** an analysis with recorded runs
- **WHEN** `purgeAnalysis` executes
- **THEN** the workflow ids are read from `cortex_runs` before those rows are removed, and the workflow footprint is reclaimed

#### Scenario: Data-profile workflows are reclaimed

- **GIVEN** an analysis that was profiled, producing workflows in the `dataprofile:{analysisId}:` id namespace
- **WHEN** `purgeAnalysis` completes successfully
- **THEN** those workflows and their dependent rows are gone

### Requirement: The workflow footprint is reached through an injected seam

`purgeAnalysis` SHALL reach the workflow ledger through an injected capability interface rather than importing the durability engine, preserving the quarantine that keeps engine imports out of the harness's state modules, tools, and loop. The seam SHALL expose cancellation and deletion of workflows by id (including descendants), and a lookup of the workflow ids within a given id namespace — the lookup belongs on the seam because resolving an analysis's data-profile workflows means querying the ledger, and a caller doing that itself would put the engine's schema back in the state layer the seam exists to keep clean. The harness SHALL ship a realization of it, and that realization SHALL NOT require a launched engine — a host may purge from a headless process that never launched the durable runtime, so the realization SHALL work over a supplied connection pool or system-database URL. An absent ledger SHALL read as nothing to purge rather than as a failure, since the engine creates its schema at first launch.

#### Scenario: State modules do not import the engine

- **WHEN** the purge module is inspected
- **THEN** it references only the seam interface, and no durability-engine import appears in it

#### Scenario: Purge works without a launched engine

- **GIVEN** a headless process holding a Postgres pool that never launched the durable runtime
- **WHEN** it purges an analysis
- **THEN** the workflow footprint is reclaimed and no "engine not launched" failure occurs

#### Scenario: An absent ledger is nothing to purge

- **GIVEN** a database in which the engine has never created its schema
- **WHEN** the seam is asked for a namespace lookup, a cancellation, or a deletion
- **THEN** each succeeds, reporting no ids found, nothing cancelled, and nothing deleted

#### Scenario: A broken ledger is a failure, not an empty one

- **GIVEN** a database where the engine's schema exists but its workflow table does not
- **WHEN** the seam is asked for a namespace lookup, a cancellation, or a deletion
- **THEN** each fails on the error channel, so a purge over a half-migrated ledger is never reported as one that reclaimed nothing

### Requirement: Purge cancels in-flight workflows before deleting them

`purgeAnalysis` SHALL cancel an analysis's workflows before deleting their ledger rows. Deleting the status row of a running workflow does not stop the executor running it, which would then continue writing and re-materialize rows behind the purge — reproducing the orphans the operation exists to remove. Cancellation failure for a workflow SHALL NOT be swallowed: the operation SHALL surface it rather than proceed to a delete whose completeness it can no longer claim.

#### Scenario: A running workflow is cancelled first

- **GIVEN** an analysis with a workflow still in flight
- **WHEN** `purgeAnalysis` runs
- **THEN** the workflow is cancelled before its ledger rows are deleted, and no rows for it reappear afterwards

#### Scenario: Cancellation failure stops the purge

- **GIVEN** a workflow that cannot be cancelled
- **WHEN** `purgeAnalysis` runs
- **THEN** it reports the failure and does not claim a completed purge

### Requirement: Purge is idempotent and reports what it reclaimed

`purgeAnalysis` SHALL succeed when invoked for an analysis that does not exist or has already been purged, treating absence as a normal outcome rather than an error. It SHALL return a `Result` carrying an outcome that reports what was reclaimed — at minimum the threads, messages, and workflows removed, and whether a vector index was dropped — so a host can tell a user what happened rather than asserting a fixed narrative. A failure SHALL be returned on the error channel and SHALL NOT be reported as a successful purge, since the whole purpose of the operation is a claim about what no longer exists.

#### Scenario: Purging an unknown analysis succeeds

- **GIVEN** an `analysisId` with no rows in any store
- **WHEN** `purgeAnalysis` is called
- **THEN** it succeeds and reports nothing reclaimed

#### Scenario: Purging twice succeeds

- **GIVEN** an analysis already purged
- **WHEN** `purgeAnalysis` is called again
- **THEN** it succeeds and reports nothing reclaimed

#### Scenario: A failure is not reported as success

- **GIVEN** a store that cannot be written during a purge
- **WHEN** `purgeAnalysis` runs
- **THEN** it returns an error naming the failure and does not report a completed purge

### Requirement: A refusal the purge can raise itself is raised before anything is destroyed

`purgeAnalysis` SHALL validate the `analysisId` before it cancels a workflow or deletes any row, and SHALL refuse the whole operation on the error channel when it does not conform. Raising that refusal from a later stage would answer with an error only after the workflows were cancelled, their ledger rows deleted, and every `cortex_*` row removed — and would answer the same way on every retry, because the id never changes, so an analysis whose footprint was in fact entirely reclaimed could never be reported purged.

The validated shape SHALL serve two purposes, and the requirement SHALL state both, because satisfying one of them incidentally is what makes the other fragile. First, the id derives the per-analysis vector-table name, which is interpolated into DDL, so the shape SHALL be one that is safe as a SQL identifier and SHALL bound its length against silent identifier truncation. Second, the id is embedded in the `dataprofile:{analysisId}:` namespace that the workflow lookup matches by prefix, so the shape SHALL exclude the namespace delimiter — without which a purge of one analysis would match another whose id extends it, and sweep that analysis's workflows into the cancel and the cascading delete.

#### Scenario: A refused identifier destroys nothing

- **GIVEN** an analysis id outside the permitted shape
- **WHEN** `purgeAnalysis` is called for it
- **THEN** it returns an error, and every one of the analysis's rows, its messages, and its workflow ledger rows remain

#### Scenario: An id carrying the namespace delimiter is refused

- **GIVEN** an analysis id containing the delimiter that separates the workflow id namespace from its payload
- **WHEN** `purgeAnalysis` is called for it
- **THEN** it refuses before any stage runs, so no other analysis whose id extends it can be reached

#### Scenario: An id whose derived table name exceeds the identifier limit is refused

- **GIVEN** an analysis id long enough that its derived vector-table name would be truncated by the database
- **WHEN** `purgeAnalysis` is called for it
- **THEN** it returns an error rather than dropping the table that the truncated name resolves to

### Requirement: A purge is not serialized against work still starting on the analysis

`purgeAnalysis` SHALL NOT be specified as serialized against concurrent work on the analysis, and its contract SHALL state the precondition that follows. The mapping from an analysis to its workflows is read once, before any deletion; a run inserted after that read is outside the captured set, and the same purge later deletes the `cortex_runs` row that is the only record naming it. That workflow and everything cascading off it are then attributable to no analysis, and no retry reaches them. A host SHALL therefore quiesce the analysis — no new runs, no new data-profile triggers — before purging it. The operation SHALL NOT claim that a re-run recovers such a workflow, and SHALL NOT enforce the precondition, since it cannot observe a host's in-flight work.

#### Scenario: A run starting mid-purge is not recovered by a retry

- **GIVEN** a run whose workflow starts after the purge has captured its workflow ids
- **WHEN** the purge completes and is then re-run
- **THEN** the re-run reports nothing further reclaimed, and the contract does not claim that workflow was recovered

### Requirement: Purge names what it does not reach

`purgeAnalysis` SHALL NOT remove state that is not attributable to an analysis, and its contract SHALL state those exclusions so absent coverage is never mistaken for delivered coverage. Specifically it SHALL NOT touch: scheduled operational workflows (liveness watchdog, reaper, notification sweep), which belong to no analysis and accumulate independently of any purge; target assessments and their annotations, which are a separate top-level entity; `messages` rows whose thread row is already gone, which carry no analysis attribution and are unreachable by construction; the shared regulatory corpus; and workspace files on disk, whose disposal the embedder owns.

#### Scenario: Scheduled workflows survive a purge

- **GIVEN** scheduled operational workflows in the ledger alongside an analysis's workflows
- **WHEN** `purgeAnalysis` completes for that analysis
- **THEN** the scheduled workflows' rows remain

#### Scenario: Another entity's state survives a purge

- **GIVEN** a target assessment and a second analysis
- **WHEN** one analysis is purged
- **THEN** the target assessment and the second analysis retain every row

#### Scenario: Workspace files are untouched

- **GIVEN** an analysis with files in its workspace tree
- **WHEN** `purgeAnalysis` completes
- **THEN** the files on disk are unchanged and the host remains responsible for their disposal

### Requirement: The message delete runs ahead of the thread delete that can cascade

`purgeAnalysis` SHALL delete an analysis's `messages` rows before it deletes its `cortex_analysis_threads` rows, and SHALL reach the messages by joining through the thread rows. `cortex_analysis_threads` carries a self-reference (`parent_thread_id`) with `ON DELETE CASCADE`, so removing any thread row also removes its whole subtree — including rows the delete's own predicate never named, at any depth. A thread delete that ran first would therefore let the cascade drop a descendant whose transcript is still on disk.

Such messages are unrecoverable, not merely late. `messages` carries no foreign key to `cortex_analysis_threads`, and the join through that table is the only route from an analysis to its messages, so a row whose thread is gone belongs to no analysis and no later reclamation of any scope reaches it.

The single-statement form of the thread delete is not what prevents this. A parent-only delete under `ON DELETE CASCADE` succeeds and takes the subtree with it rather than raising a referential error, so no statement shape makes the wrong order safe. Only the ordering does.

#### Scenario: A three-generation thread structure is fully reclaimed

- **GIVEN** an analysis holding a conversation thread, a child of it, and a child of that child, each carrying messages
- **WHEN** `purgeAnalysis` completes successfully
- **THEN** no `cortex_analysis_threads` row and no `messages` row remains for any of the three

#### Scenario: A cascade cannot outrun the message delete

- **GIVEN** an analysis whose child threads would be removed by the cascade when their parent row is deleted
- **WHEN** `purgeAnalysis` runs
- **THEN** every one of those threads' messages is already deleted before any thread row is removed
