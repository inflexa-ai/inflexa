# tui-mock-data Specification

## Purpose
TBD - created by archiving change inflexa-design-system. Update Purpose after archive.

## Requirements

### Requirement: Extended message part union

The `Part` union in `src/types/session.ts` MUST be a discriminated union on `type`. It holds the message parts of the harness (`MessagePart`) and two mock part kinds that drive the stream blocks of the design gallery: a thinking part (a reasoning body and an optional duration) and a file-edit part (a file path, the hunk lines, and the counts of added and removed lines).

Each mock kind MUST have a distinct `type` literal, and it MUST carry only the fields that its block renders. Each mock kind MUST carry JSDoc on the type and on its properties. The mock kinds exist in memory only: the live chat engine does not make them, and no path stores them.

A harness part can carry screen state of the live turn, and no other field that the harness type does not declare. Three parts carry it:

- a text part: the key that `streamPartId` names while the part streams
- a tool-call part: the activity line of the sub-agent that works inside the running call
- an ask part: the reject feedback that the user typed

#### Scenario: Part union is a discriminated union

- **WHEN** code narrows a `Part` by `part.type`
- **THEN** each kind exposes only its own fields, and a switch over the harness part types and the two mock kinds is exhaustive

#### Scenario: New kinds are not persisted

- **WHEN** the live chat engine adds a part to a turn
- **THEN** the part is a harness part, and the mock kinds exist only as in-memory fixtures

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
