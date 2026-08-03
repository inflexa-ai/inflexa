## ADDED Requirements

### Requirement: Manuscript-review phases use the existing step ledger

At manuscript-review start, the workflow SHALL seed exactly one pending `cortex_step_executions` row for each of `review-parse`, `review-structure`, `review-language`, `review-coherence`, `review-references`, and `review-conformance`, using stable waves and agent identities and `ON CONFLICT DO NOTHING`. Each phase SHALL transition its row monotonically through the existing pending, running, completed, failed, canceled, or skipped vocabulary and SHALL stamp terminal timing before the run row becomes terminal. No plan-step foreign key or new phase table SHALL be required.

#### Scenario: Six rows are visible from run start

- **WHEN** the manuscript-review ledger seed completes
- **THEN** `queryStepsByRun` returns all six pending fixed phase rows even before later phases start

#### Scenario: Recovery does not regress a phase

- **WHEN** workflow recovery replays the seed after `review-parse` completed
- **THEN** the completed parse row remains unchanged and only absent rows are added

#### Scenario: Terminal run has no running phase

- **WHEN** the manuscript-review run reaches a terminal status
- **THEN** every seeded phase row is completed, failed, canceled, or skipped with terminal timing
