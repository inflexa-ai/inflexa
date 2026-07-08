# event-bus — Delta

## MODIFIED Requirements

### Requirement: BusEvent type lives in src/types/events.ts

The canonical `BusEvent` union type SHALL be defined in the shared domain-model directory
`src/types/`, in its event-contract module `src/types/events.ts`. The bus module (`src/lib/bus.ts`)
SHALL import it from there and MUST NOT define its own `BusEvent` type. The union SHALL contain
only members with at least one live emitter and consumer — today the analysis-scoped provenance
members (`prov.*`); the session-scoped chat members retired with the proxy chat engine (the
harness conversation path writes the Solid store directly and never used the bus).

#### Scenario: Bus imports BusEvent from types

- **WHEN** `src/lib/bus.ts` references the `BusEvent` type
- **THEN** it SHALL import it from `../types/events.ts`

#### Scenario: No circular imports when adding a new event domain

- **WHEN** a new module (e.g., `src/modules/tools/executor.ts`) needs to both emit events via `Bus` and contribute a new variant to `BusEvent`
- **THEN** it can import `Bus` from `../../lib/bus.ts` and add its event variant to `src/types/events.ts` without creating a circular dependency

#### Scenario: No orphan members

- **WHEN** the `BusEvent` union is inspected
- **THEN** every member has an emitter and a consumer in `src/` — no vocabulary kept for a deleted engine

### Requirement: Callers publish via Bus.emit

Callers SHALL publish events using `Bus.emit("inflexa", event)` where `event` conforms to
`BusEvent`.

#### Scenario: Publishing a provenance event

- **WHEN** a caller invokes `Bus.emit("inflexa", { type: "prov.input_added", analysisId: "a1", ... })`
- **THEN** the event is delivered to all listeners registered on the `"inflexa"` channel
- **AND** the event is stamped with `__infId` by the emit override
