## ADDED Requirements

### Requirement: BusEvent type lives in src/types.ts
The canonical `BusEvent` union type SHALL be defined in `src/types.ts`. The bus module (`src/lib/bus.ts`) SHALL import it from there. The bus module MUST NOT define its own `BusEvent` type.

#### Scenario: Bus imports BusEvent from types
- **WHEN** `src/lib/bus.ts` references the `BusEvent` type
- **THEN** it SHALL import it from `../types.ts`

#### Scenario: No circular imports when adding a new event domain
- **WHEN** a new module (e.g., `src/tools/executor.ts`) needs to both emit events via `Bus` and contribute a new variant to `BusEvent`
- **THEN** it can import `Bus` from `../lib/bus.ts` and add its event variant to `src/types.ts` without creating a circular dependency

### Requirement: Callers publish via Bus.emit
Callers SHALL publish events using `Bus.emit("inf", event)` where `event` conforms to `BusEvent`.

#### Scenario: Publishing a session status event
- **WHEN** a caller invokes `Bus.emit("inf", { type: "session.status", sessionId: "s1", status: "busy" })`
- **THEN** the event is delivered to all listeners registered on the `"inf"` channel
- **AND** the event is stamped with `__infId` by the emit override

### Requirement: Callers subscribe via Bus.on and unsubscribe via Bus.off
Callers SHALL subscribe using `Bus.on("inf", handler)` and unsubscribe using `Bus.off("inf", handler)`.

#### Scenario: Subscribing and receiving events
- **WHEN** a caller registers a handler with `Bus.on("inf", handler)`
- **THEN** the handler SHALL be invoked for every subsequent `Bus.emit("inf", event)` call

#### Scenario: Unsubscribing stops delivery
- **WHEN** a caller calls `Bus.off("inf", handler)` with the same function reference
- **THEN** that handler SHALL no longer receive events

### Requirement: Single bus instance exported as Bus
The bus module SHALL export a singleton instance named `Bus` (capital B). The class itself is not part of the public API.

#### Scenario: Import the singleton
- **WHEN** a module imports from `src/lib/bus.ts`
- **THEN** it SHALL receive the `Bus` instance as a named export
