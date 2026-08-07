## MODIFIED Requirements

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
