## ADDED Requirements

### Requirement: Running step rows render a compact elapsed age

The run block SHALL render a compact relative age (the `Date.relativeAge`
vocabulary) beside a step row's label when and only when the row's state is
`running` and a start time is provided, in the muted information tier
(≥ 4.5:1). Queued, done, and failed rows SHALL NOT render an age, and a running
row without a start time SHALL render unchanged. The age applies in every run
block mount — the sidebar progress embed (age ticks at the sidebar's poll
cadence), the run-detail dialog (age elapsed at the moment the dialog was
opened), and the design-gallery exhibit.

#### Scenario: A running row shows its age

- **WHEN** the run block renders a `running` step view carrying a start time
- **THEN** the row shows the step label followed by a muted compact relative age
  (e.g. `4m12s`)

#### Scenario: Non-running rows never show an age

- **WHEN** the run block renders done, failed, or queued step views
- **THEN** no age is rendered on those rows, whether or not a start time is
  present
