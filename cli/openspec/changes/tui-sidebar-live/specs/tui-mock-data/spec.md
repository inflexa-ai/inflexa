# tui-mock-data — Delta

## MODIFIED Requirements

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
