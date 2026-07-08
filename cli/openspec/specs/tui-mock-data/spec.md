# tui-mock-data Specification

## Purpose
TBD - created by archiving change inflexa-design-system. Update Purpose after archive.
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

The system SHALL keep mock model types only where the design gallery still showcases them: a mock
model that has lost its last consumer is deleted, not kept "just in case". Remaining mock models
(e.g. the run/step model backing gallery exhibits) SHALL stay in-memory only — NOT persisted, NOT
queried from SQLite or the harness ledger, and NOT emitted by any live path. The token-cost model
is removed together with the sidebar's CONTEXT section unless a gallery exhibit consumes it.

#### Scenario: Models are in-memory, not persisted

- **WHEN** a remaining mock model is used
- **THEN** it is read from fixtures by a gallery exhibit, with no table, migration, query, or live emission backing it

#### Scenario: Orphaned fixtures are deleted

- **WHEN** a mock model's last consumer is removed
- **THEN** the model and its fixtures are deleted in the same change

### Requirement: Mock fixtures are identifiable as mock

The system SHALL confine sample fixtures to the clearly-named mock module, each commented as
sample data, consumed ONLY by design-gallery exhibits (and tests) — never by a product surface.
The sidebar SHALL NOT import the mock module. No consumer SHALL present mock fixture values as
live telemetry, and the live conversation/ledger paths SHALL NOT be wired to the mock fixtures.

#### Scenario: Fixtures are gallery-only

- **WHEN** the mock module's importers are listed
- **THEN** they are design-gallery exhibits or tests — no product surface (sidebar, chat stream, status bar) imports it

#### Scenario: Swapping showcase data touches only the exhibit

- **WHEN** a gallery exhibit's sample data changes
- **THEN** the change is confined to the fixture/exhibit; the block component that renders it is unchanged

