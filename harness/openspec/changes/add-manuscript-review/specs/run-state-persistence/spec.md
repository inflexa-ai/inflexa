## ADDED Requirements

### Requirement: Manuscript-review runs use the existing run ledger without a plan

`review_manuscript` SHALL idempotently reserve a `cortex_runs` row before workflow launch with the current analysis and thread ids, `workflow_name = "executeManuscriptReview"`, `status = "running"`, and `plan_id = NULL`. The reservation SHALL use an invocation-derived bare UUID and SHALL reload an existing row for duplicate delivery without authorizing or launching a second run. Authorization failure after a new reservation SHALL mark that row `failed` and SHALL launch no workflow. No new run columns, top-level table, or scope kind SHALL be introduced.

#### Scenario: New review row is planless

- **WHEN** a manuscript review is reserved for the first time
- **THEN** the run row is `running`, names `executeManuscriptReview`, and has a null plan id

#### Scenario: Duplicate launch delivery is idempotent

- **WHEN** the same invocation-derived review id is delivered again
- **THEN** the existing analysis-scoped run row is returned
- **AND** no second authorization or workflow launch occurs

#### Scenario: Authorization fails after reservation

- **WHEN** `RunAuthorizer.authorize` throws for a newly reserved manuscript-review run
- **THEN** that run row becomes `failed` with an authorization error and no workflow starts
