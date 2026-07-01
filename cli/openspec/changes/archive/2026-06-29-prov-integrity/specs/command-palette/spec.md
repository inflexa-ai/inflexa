## ADDED Requirements

### Requirement: Verify provenance command in palette

The system SHALL add a "Verify provenance" entry to the command palette with `id: "prov.verify"`, `category: "Analysis"`, enabled when `ctx.analysis !== null`. The action SHALL lazy-import the verification module, run the check, and display the result via `notify`.

#### Scenario: Verify command appears when analysis is open

- **WHEN** the command palette is opened with an analysis active
- **THEN** "Verify provenance" is listed in the Analysis category

#### Scenario: Verify command is hidden without an analysis

- **WHEN** the command palette is opened with no analysis active
- **THEN** "Verify provenance" does not appear

#### Scenario: Verify result is shown as a notice

- **WHEN** the user selects "Verify provenance"
- **THEN** a notice is displayed: info for valid/unsigned/empty, warn for no-key, error for tampered
