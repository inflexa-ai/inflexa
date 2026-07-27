## MODIFIED Requirements

### Requirement: Existing chat types preserved

The change SHALL retire the SQLite-store entity shapes from `src/types/session.ts` — `Session`, `Message`, and `StoredMessage` — while leaving unchanged the live UI part vocabulary in the same file (`Part`, `TextPart`, and the card/ask/openable part types the TUI conversation store and renderers consume) and the `BusEvent`/`StampedEvent` event contract (`src/types/events.ts`).

#### Scenario: Typecheck stays clean

- **WHEN** `bun run typecheck` runs after the change
- **THEN** it completes with no errors
- **AND** `Session`, `Message`, and `StoredMessage` are no longer exported

#### Scenario: Live part vocabulary is untouched

- **WHEN** the TUI conversation store and message renderers import their part types
- **THEN** `Part`, `TextPart`, and the card part types resolve from `src/types/session.ts` exactly as before, and the event contract is unmodified
