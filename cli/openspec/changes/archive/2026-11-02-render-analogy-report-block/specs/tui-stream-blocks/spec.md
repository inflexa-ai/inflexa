## ADDED Requirements

### Requirement: The analogy report renders as a block that a click expands

The TUI MUST render a `data-analogy-report` part as an analogy report block. The block MUST start collapsed, and a click on its header line MUST toggle it between the collapsed and the expanded state. The toggle changes only the view of the block. It sends no request.

The header MUST give the count of distinct target domains and the count of analogies with solutions. The collapsed block MUST show the problem summary, each analogy by its domain and title, and the title of each solution. The expanded block MUST also show the object mappings of each analogy, and the relevance and the sources of each solution.

An analogy with `coverage` other than `available` MUST show its coverage state on its line. `search_failed` MUST use the `error` role. `queried_no_data` and `not_loaded` MUST use the `fgMuted` role. An `extraction-failed` envelope MUST render as the error block of the design system, with the message of the error as its detail.

The design gallery MUST show the full report, a report with partial coverage, the failure state, and the collapsed and the expanded state.

#### Scenario: The block starts collapsed

- **WHEN** an assistant turn contains a `data-analogy-report` part with a report
- **THEN** the block shows the header, the problem summary, the analogy titles, and the solution titles
- **AND** it does not show the object mappings, the relevance, or the sources

#### Scenario: A click toggles the block

- **GIVEN** a collapsed analogy report block
- **WHEN** the user clicks its header line
- **THEN** the block shows the object mappings, the relevance, and the sources
- **AND** a second click collapses the block again

#### Scenario: Partial coverage shows on each analogy

- **WHEN** a report holds an analogy with `coverage: "search_failed"` and an analogy with `coverage: "not_loaded"`
- **THEN** the first analogy shows its state in the `error` role, and the second analogy shows its state in the `fgMuted` role

#### Scenario: An extraction failure shows its message

- **WHEN** the part carries an `extraction-failed` envelope
- **THEN** the block shows the failure state with the message of the error, and no header click toggles it
