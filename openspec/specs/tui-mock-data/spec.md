# tui-mock-data Specification

## Purpose
TBD - created by archiving change inf-design-system. Update Purpose after archive.
## Requirements
### Requirement: Extended message part union

The `Part` union in `src/types/session.ts` SHALL be a discriminated union on `type` that, in addition to the existing `TextPart`, includes mock part kinds sufficient to drive the stream blocks: a thinking part (reasoning body + optional duration), a tool-call part (tool/verb name, target, result payload, status), and a file-edit part (file path, hunk lines, +/− counts). Each new kind SHALL carry only the fields its block renders, SHALL have a distinct `type` literal, and SHALL carry JSDoc on the type and its properties. The persisted/stored shape SHALL remain text-only — the new kinds are mock and SHALL NOT be written through the DB mutation path.

#### Scenario: Part union is a discriminated union

- **WHEN** code narrows a `Part` by `part.type`
- **THEN** each kind exposes only its own fields, and the four discriminants (`text`, thinking, tool-call, file-edit) are exhaustive

#### Scenario: New kinds are not persisted

- **WHEN** the live chat engine creates a part through the DB mutation path
- **THEN** only the text kind is created; the mock kinds exist only as in-memory fixtures

### Requirement: Mock run and token-cost models

The system SHALL define mock model types for a run and its steps (run id/name, status, step list with per-step state of done/running/queued, and progress) and for context accounting (token count, percent-of-window, cost), with JSDoc. These models SHALL be in-memory only — NOT persisted, NOT queried from SQLite, and NOT emitted by the live event bus or chat engine.

#### Scenario: Models are in-memory, not persisted

- **WHEN** the run or token-cost models are used
- **THEN** they are read from fixtures, with no SQLite table, migration, or query backing them

### Requirement: Mock fixtures are identifiable as mock

The system SHALL provide sample fixtures for the extended part kinds, the run/step model, and the token-cost model in a clearly-named mock module (e.g. a `mock`-prefixed file or namespace), each commented as sample data. No consumer SHALL present mock fixture values as live telemetry, and the live `conversation` store / event-bus path SHALL NOT be wired to the mock fixtures. Removing or replacing the fixtures with real engine output SHALL be possible without changing the block components (the data source is the only seam).

#### Scenario: Fixtures are clearly mock

- **WHEN** a developer reads a fixture used by a block or the sidebar
- **THEN** it resides in the named mock module and is commented as sample data, not produced by the live engine

#### Scenario: Swapping to live data touches only the data source

- **WHEN** real engine emission later replaces a fixture
- **THEN** the change is confined to the data source; the block component that renders it is unchanged

