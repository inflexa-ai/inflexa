## MODIFIED Requirements

### Requirement: Purge covers the analysis-keyed tables, the vector index, and the workflow footprint

`purgeAnalysis` MUST remove this footprint:

- the analysis rows of `cortex_analysis_state`, `cortex_artifacts`, `cortex_runs`, `cortex_step_executions`, `cortex_plans`, `cortex_report_versions`, `cortex_analysis_threads`, `cortex_working_memory`, `cortex_asks`, `cortex_ask_grants`, `cortex_tool_outputs`, and `cortex_sandbox_leases`
- the `messages` rows of each thread of the analysis
- the `cortex_thread_turns` rows of each thread of the analysis
- the dynamic pgvector table with the shared `searchIndexName(analysisId)` name
- the DBOS workflow footprint of the analysis, which includes the lease workflows of its sandboxes

The purge reaches the turn records through the thread rows, the same as the messages. Thus it MUST delete them before it deletes the thread rows, for the reason that the delete order of the messages gives.

The purge reaches the kept tool outputs by their own `analysis_id`, with no join through the thread rows. Thus it removes the kept texts of each thread and of each run of the analysis.

Coverage of the workflow footprint is normative, and it is not optional. The DBOS rows carry the sandbox agent transcripts and the run-event stream, and they are the largest share of the stored bytes. Thus a purge that omits them reclaims a small fraction, but it still shows itself as final.

#### Scenario: The dynamic vector table is dropped

- **GIVEN** an analysis whose workspace index table exists under the `searchIndexName(analysisId)` name
- **WHEN** `purgeAnalysis` completes successfully
- **THEN** that table no longer exists

#### Scenario: An absent vector table is not an error

- **GIVEN** an analysis that never had a workspace index table
- **WHEN** `purgeAnalysis` runs
- **THEN** it succeeds, and it reports no vector index dropped

#### Scenario: Messages are reached through the analysis's threads

- **GIVEN** an analysis with some threads, each with messages
- **WHEN** `purgeAnalysis` completes successfully
- **THEN** no `messages` row remains for any of those threads

#### Scenario: Turn records are reached through the threads of the analysis

- **GIVEN** an analysis with a conversation thread and a child thread, each with a closed chat turn
- **WHEN** `purgeAnalysis` completes successfully
- **THEN** no `cortex_thread_turns` row remains for either thread

#### Scenario: The kept tool outputs are removed

- **GIVEN** an analysis with a kept text of a chat turn and a kept text of a run
- **AND** a second analysis with a kept text
- **WHEN** `purgeAnalysis` completes successfully for the first analysis
- **THEN** no `cortex_tool_outputs` row remains for the first analysis, and the row of the second analysis stays

#### Scenario: The workflow footprint is removed

- **GIVEN** an analysis with a completed run whose parent and child step workflows are in the DBOS ledger
- **WHEN** `purgeAnalysis` completes successfully
- **THEN** the status rows of those workflows are gone, and the step-output, stream, input, event, and queue rows that depend on them are gone too

#### Scenario: The report versions are removed

- **GIVEN** an analysis with a report thread that recorded two versions
- **WHEN** `purgeAnalysis` completes successfully
- **THEN** no `cortex_report_versions` row remains for the analysis

#### Scenario: The leases are removed

- **GIVEN** an analysis whose run step holds a lease, and whose data profile released a lease
- **WHEN** `purgeAnalysis` completes successfully
- **THEN** no `cortex_sandbox_leases` row remains for the analysis, and the two lease workflows are gone from the DBOS ledger

### Requirement: Purge collects workflow identity before deleting the rows that carry it

`purgeAnalysis` MUST read the workflow ids of the analysis before it deletes the ledger rows that record them. Those rows are the only map from an analysis to its workflows. The purge MUST resolve these workflows:

- the run workflows from `cortex_runs.run_id`, which is the id of the parent workflow, with their descendants
- the data-profile workflows from the `dataprofile:{analysisId}:` id namespace
- the lease workflows from the `sandboxlease:{analysisId}:` id namespace

A lease workflow is not a descendant of its consumer, thus only its namespace reaches it. A delete of `cortex_runs` before the purge reads its `run_id` values is a defect. It puts the largest part of the footprint out of reach for all time.

#### Scenario: Run identity is captured before the ledger is deleted

- **GIVEN** an analysis with recorded runs
- **WHEN** `purgeAnalysis` executes
- **THEN** the workflow ids are read from `cortex_runs` before those rows are removed, and the workflow footprint is reclaimed

#### Scenario: Data-profile workflows are reclaimed

- **GIVEN** an analysis that was profiled, producing workflows in the `dataprofile:{analysisId}:` id namespace
- **WHEN** `purgeAnalysis` completes successfully
- **THEN** those workflows and their dependent rows are gone

#### Scenario: Lease workflows are reclaimed by their namespace

- **GIVEN** an analysis whose step holds a lease, with its lease workflow in the `sandboxlease:{analysisId}:` id namespace
- **WHEN** `purgeAnalysis` completes successfully
- **THEN** the purge canceled the lease workflow before it deleted the rows, and the workflow and its dependent rows are gone

### Requirement: Purge names what it does not reach

`purgeAnalysis` MUST NOT remove state that it cannot attribute to an analysis.
Its contract MUST state those exclusions, thus nobody mistakes an absent
coverage for a delivered coverage. It MUST NOT touch these items:

- the scheduled operational workflows (the sandbox reconciler and the
  notification sweep). They belong to no analysis, and they accumulate
  independently of each purge.
- the `messages` rows whose thread row is gone already. They carry no analysis
  attribution, and by construction nothing can reach them.
- the shared regulatory corpus.
- the workspace files on disk, with the exec records of the sandboxes. The
  embedder owns their disposal.
- the sandbox machines. A canceled lease workflow cannot remove its machine, thus
  the sandbox reconciler removes each machine whose lease workflow is terminal.

#### Scenario: Scheduled workflows survive a purge

- **GIVEN** scheduled operational workflows in the ledger alongside an analysis's workflows
- **WHEN** `purgeAnalysis` completes for that analysis
- **THEN** the scheduled workflows' rows remain

#### Scenario: Another entity's state survives a purge

- **GIVEN** a second analysis
- **WHEN** one analysis is purged
- **THEN** the second analysis retains every row

#### Scenario: Workspace files are untouched

- **GIVEN** an analysis with files in its workspace tree
- **WHEN** `purgeAnalysis` completes
- **THEN** the files on disk are unchanged and the host remains responsible for their disposal

#### Scenario: The reconciler removes the machine of a purged lease

- **GIVEN** an analysis whose step holds a lease with a live machine
- **WHEN** `purgeAnalysis` cancels the lease workflow, and the sandbox reconciler then runs
- **THEN** the reconciler removes the machine, because its lease workflow is terminal
