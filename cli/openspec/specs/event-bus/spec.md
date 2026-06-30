# event-bus Specification

## Purpose
The in-process event bus (`Bus`) and its `BusEvent` contract — a single typed channel modules publish to and subscribe from without circular imports.

## Requirements

### Requirement: BusEvent type lives in src/types/events.ts
The canonical `BusEvent` union type SHALL be defined in the shared domain-model directory `src/types/`, in its event-contract module `src/types/events.ts`. The bus module (`src/lib/bus.ts`) SHALL import it from there. The bus module MUST NOT define its own `BusEvent` type.

#### Scenario: Bus imports BusEvent from types
- **WHEN** `src/lib/bus.ts` references the `BusEvent` type
- **THEN** it SHALL import it from `../types/events.ts`

#### Scenario: No circular imports when adding a new event domain
- **WHEN** a new module (e.g., `src/modules/tools/executor.ts`) needs to both emit events via `Bus` and contribute a new variant to `BusEvent`
- **THEN** it can import `Bus` from `../../lib/bus.ts` and add its event variant to `src/types/events.ts` without creating a circular dependency

### Requirement: Callers publish via Bus.emit
Callers SHALL publish events using `Bus.emit("inflexa", event)` where `event` conforms to `BusEvent`.

#### Scenario: Publishing a session status event
- **WHEN** a caller invokes `Bus.emit("inflexa", { type: "session.status", sessionId: "s1", status: "busy" })`
- **THEN** the event is delivered to all listeners registered on the `"inflexa"` channel
- **AND** the event is stamped with `__infId` by the emit override

### Requirement: Callers subscribe via Bus.on and unsubscribe via Bus.off
Callers SHALL subscribe using `Bus.on("inflexa", handler)` and unsubscribe using `Bus.off("inflexa", handler)`.

#### Scenario: Subscribing and receiving events
- **WHEN** a caller registers a handler with `Bus.on("inflexa", handler)`
- **THEN** the handler SHALL be invoked for every subsequent `Bus.emit("inflexa", event)` call

#### Scenario: Unsubscribing stops delivery
- **WHEN** a caller calls `Bus.off("inflexa", handler)` with the same function reference
- **THEN** that handler SHALL no longer receive events

### Requirement: Single bus instance exported as Bus
The bus module SHALL export a singleton instance named `Bus` (capital B). The class itself is not part of the public API.

#### Scenario: Import the singleton
- **WHEN** a module imports from `src/lib/bus.ts`
- **THEN** it SHALL receive the `Bus` instance as a named export
