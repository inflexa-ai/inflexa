## MODIFIED Requirements

### Requirement: Existing chat types preserved

`src/types/session.ts` MUST NOT hold the SQLite-store entity shapes `Session`, `Message`, and `StoredMessage`. It holds the part vocabulary of the TUI: the `Part` union, the screen state of three harness parts, and the view types of the cards. The data fields of a message and of a part come from the harness types. The `BusEvent` and `StampedEvent` event contract (`src/types/events.ts`) does not change.

#### Scenario: Typecheck stays clean

- **WHEN** `bun run typecheck` runs
- **THEN** it completes with no errors
- **AND** `src/types/session.ts` does not export `Session`, `Message`, or `StoredMessage`

#### Scenario: Live part vocabulary is untouched

- **WHEN** the TUI conversation store and the message renderer import their part types
- **THEN** `Part` and the three live part types resolve from `src/types/session.ts`
- **AND** each data field of a part comes from the harness part type
- **AND** the event contract does not change
