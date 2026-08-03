## ADDED Requirements

### Requirement: Targeted inspection advertises a registered manuscript review

Targeted `inspect_run` SHALL add nullable `reviewPath`. It SHALL return a non-null value only when the run is terminal, `workflow_name` is `executeManuscriptReview`, and the expected `review.json` is present in the analysis-scoped artifact ledger with the same run identity. It SHALL return null while the run is in progress or suspended, when a failed run produced no valid dossier, when the ledger entry is absent, and for every unrelated workflow. The existing bounded wait and inspection-state rules SHALL remain unchanged.

#### Scenario: Completed review exposes dossier path

- **WHEN** a terminal manuscript-review run has a registered valid `review.json`
- **THEN** targeted inspection returns that artifact's confined path as `reviewPath`

#### Scenario: Disk file without ledger entry is hidden

- **WHEN** `runs/{runId}/review.json` exists on disk but is absent from `cortex_artifacts`
- **THEN** `reviewPath` is null

#### Scenario: Running review exposes no premature path

- **WHEN** a manuscript-review run is still running
- **THEN** inspection reports `in_progress` and `reviewPath` is null
