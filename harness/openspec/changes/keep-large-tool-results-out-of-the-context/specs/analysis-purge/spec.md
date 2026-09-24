## MODIFIED Requirements

### Requirement: Purge covers the analysis-keyed tables, the vector index, and the workflow footprint

`purgeAnalysis` MUST remove this footprint:

- the analysis rows of `cortex_analysis_state`, `cortex_artifacts`, `cortex_runs`, `cortex_step_executions`, `cortex_plans`, `cortex_report_versions`, `cortex_analysis_threads`, `cortex_working_memory`, `cortex_asks`, `cortex_ask_grants`, and `cortex_tool_outputs`
- the `messages` rows of each thread of the analysis
- the `cortex_thread_turns` rows of each thread of the analysis
- the dynamic pgvector table with the shared `searchIndexName(analysisId)` name
- the DBOS workflow footprint of the analysis

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

#### Scenario: Messages are reached through the threads of the analysis

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
