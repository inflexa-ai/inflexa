## ADDED Requirements

### Requirement: A manuscript review has a planless run-card variant

`data-run-card` SHALL support a discriminated manuscript-review variant carrying run id, workflow kind, title, and the six fixed phase ids without requiring plan id, generated steps, or analysis-plan content. Existing plan-backed analysis-run cards SHALL retain their current schema and rendering. Card reconstruction SHALL derive the manuscript variant from stored tool/run identity rather than inventing a plan.

#### Scenario: Review launch emits fixed-phase card

- **WHEN** `review_manuscript` launches a run
- **THEN** it emits a manuscript-review run card with the run id and six fixed phases and no plan id

#### Scenario: Existing analysis card is unchanged

- **WHEN** `execute_analysis` launches a stored plan
- **THEN** its existing plan-backed `data-run-card` shape and reconstruction remain valid
