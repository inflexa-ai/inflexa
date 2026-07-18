## ADDED Requirements

### Requirement: report_blocker is scoped to empty or incoherent inputs

The run synthesizer SHALL offer `report_blocker` with a description that scopes
the terminal to runs whose step summaries are genuinely empty or incoherent
(all summaries empty, or contradictory to the point of incoherence). The
description SHALL NOT present "no findings worth surfacing" — or any equivalent
"nothing to report" phrasing — as a condition that warrants a blocker, because a
run with non-empty summaries but no individually notable findings is a valid
`submit_synthesis`, not a blocker. The blocker remains a genuine terminal for
empty/incoherent inputs; this requirement narrows only the advertised warranting
conditions, and does not weaken the invariant that a genuine synthesis failure
re-throws and fails the run.

#### Scenario: Blocker description does not invite an empty-findings exit

- **WHEN** the run synthesizer constructs its `report_blocker` tool
- **THEN** the tool description scopes warranting conditions to empty or incoherent step summaries
- **AND** it does not list "no findings worth surfacing" (or equivalent) as a warranting condition

#### Scenario: Blocker remains available for genuinely empty inputs

- **WHEN** the run synthesizer's step summaries are empty or incoherent and the synthesizer calls `report_blocker`
- **THEN** the terminal still resolves as a blocker with the carried reason

### Requirement: An empty findings list is a valid submission

The synthesizer prompt SHALL state that `findings[]` is selective and MAY be
empty, and that a run whose summaries yield no individually notable findings is
still completed through `submit_synthesis` — an overview and conclusions grounded
in the step summaries — rather than through `report_blocker`. The prompt SHALL
NOT direct the synthesizer to call `report_blocker` when it merely judges that no
finding is worth surfacing.

#### Scenario: Prompt directs no-findings runs to submit

- **WHEN** the synthesizer prompt is composed
- **THEN** it states that an empty `findings[]` is a valid `submit_synthesis` payload
- **AND** it states that "no findings worth surfacing" is not a reason to call `report_blocker`
