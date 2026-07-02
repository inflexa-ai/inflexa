## ADDED Requirements

### Requirement: Workflow transcripts remain internal execution cache state

Workflow and sandbox agent loop transcripts SHALL remain internal DBOS execution/cache state and SHALL NOT be migrated by the conversation thread-history startup backfill. Deployments of this change SHALL drain or cancel active DBOS workflows before enabling the AI SDK loop/runtime.

#### Scenario: Completed workflow cache is not migrated

- **WHEN** startup runs the thread-history AI SDK backfill
- **THEN** it migrates conversation `messages` rows only and does not rewrite DBOS operation outputs

#### Scenario: Active workflows are not replayed across the migration

- **WHEN** this change is deployed
- **THEN** operators drain or cancel active DBOS workflows before starting the AI SDK runtime

### Requirement: Analysis outputs remain Cortex-native results

Completed analysis outputs SHALL remain represented by Cortex-native ledgers, typed run streams, artifact records, files, vector entries, and working memory rows. Step summaries, synthesis JSON, reports, and artifact metadata SHALL NOT be converted to AI SDK model-message storage.

#### Scenario: Existing synthesis remains readable

- **GIVEN** a completed analysis run with `runs/{runId}/synthesis.json`
- **WHEN** the AI SDK message migration has run
- **THEN** the synthesis remains readable through the existing run/artifact output paths without a model-message migration

#### Scenario: Step summary remains a file-backed output

- **GIVEN** a completed step with `output/summary.md`
- **WHEN** the AI SDK message migration has run
- **THEN** the step summary remains available as a Cortex-native file/artifact result
