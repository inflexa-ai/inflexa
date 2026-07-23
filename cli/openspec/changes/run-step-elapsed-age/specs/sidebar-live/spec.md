## ADDED Requirements

### Requirement: Active-run step views carry the running step's start time

The active-run progress snapshot's per-step views SHALL carry the step's ledger
`started_at` timestamp, sourced from the same step read that supplies the view
state — no additional query. The progress embed derives a compact relative age
from it for running rows at render time, so each poll tick's freshly-minted
snapshot refreshes the age with no timer of its own. A row whose ledger
timestamp is absent carries none and renders as before.

#### Scenario: A running step's age refreshes at poll cadence

- **GIVEN** the newest run is non-terminal and a step row is `running` with a
  `started_at`
- **WHEN** the bounded poll refreshes the snapshot
- **THEN** the step's view carries the start time and the embed's rendered age
  reflects it, updating on each subsequent tick while the step stays running

#### Scenario: A missing start time degrades to today's rendering

- **GIVEN** a `running` step row whose `started_at` is null
- **WHEN** the snapshot is published
- **THEN** the step's view carries no start time and the row renders without an
  age
