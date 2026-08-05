## ADDED Requirements

### Requirement: manage_inputs describes its call by action and target

`manage_inputs` SHALL declare a `describeCall` hook naming the action the call performs and what it acts on. An `add` or `remove` call SHALL name the paths it carries, and SHALL report a count rather than an enumeration when it carries enough of them that naming each would exceed what one line can usefully hold. A `list` call carries no paths and SHALL be described by its action alone.

The `paths` field is optional in the schema and required only for `add` and `remove`, so the hook SHALL tolerate its absence rather than assuming it.

#### Scenario: A single-path add names the file

- **GIVEN** an `add` call carrying one path
- **WHEN** the tool call is rendered
- **THEN** the detail names the action and that path

#### Scenario: A multi-path remove reports what it acts on

- **GIVEN** a `remove` call carrying several paths
- **WHEN** the tool call is rendered
- **THEN** the detail names the action and identifies the paths, without emitting an unbounded enumeration

#### Scenario: A list call is described by its action

- **GIVEN** a `list` call, which carries no paths
- **WHEN** the tool call is rendered
- **THEN** the detail names the action and does not imply a target

#### Scenario: An add missing its paths still produces a detail

- **GIVEN** an `add` call whose `paths` field is absent, which the schema permits and `execute` rejects
- **WHEN** the tool call is rendered
- **THEN** the detail names the action rather than producing an empty string
