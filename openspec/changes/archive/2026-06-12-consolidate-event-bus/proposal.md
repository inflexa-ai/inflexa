## Why

Two bus implementations exist side by side: a Set-based `EventBus` in `src/bus.ts` (active, used by callers) and an EventEmitter-based `BusEmitter` in `src/lib/bus.ts` (unused, but the intended design). The `BusEvent` type is duplicated — a 5-variant union in `src/types.ts` and a 3-variant subset inline in `src/lib/bus.ts`. This needs to converge: one bus, one event type definition, no circular import risk.

## What Changes

- **BREAKING** Remove `src/bus.ts` and its `bus.publish()`/`bus.subscribe()` API
- Migrate all callers to `src/lib/bus.ts` using `Bus.emit("inf", event)` / `Bus.on("inf", fn)` / `Bus.off("inf", fn)`
- Remove the inline `BusEvent` type from `src/lib/bus.ts` — import the canonical union from `src/types.ts` instead
- The `src/lib/bus.ts` implementation (emit override, `__infId` stamping, class structure, `Bus` export) stays unchanged

## Capabilities

### New Capabilities
- `event-bus`: Defines the event bus contract — where event types live, how the bus consumes them, and how callers publish/subscribe

### Modified Capabilities

_(none)_

## Impact

- `src/bus.ts` — deleted
- `src/lib/bus.ts` — inline `BusEvent` removed, imported from `../types.ts`; implementation unchanged
- `src/types.ts` — no changes (already has the canonical `BusEvent`)
- `src/chat/echo.ts` — import path and API usage change
- `src/tui/app.tsx` — import path and API usage change
