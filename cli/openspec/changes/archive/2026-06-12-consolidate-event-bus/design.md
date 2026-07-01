## Context

`src/lib/bus.ts` is the intended bus — an EventEmitter subclass that overrides `emit` to auto-stamp `__infId` (UUIDv7) on every `"inf"` event. It's currently unused; callers use a simpler Set-based `EventBus` in `src/bus.ts` with `publish()`/`subscribe()` methods. The `BusEvent` type is duplicated: a 5-variant canonical union in `src/types.ts` and a 3-variant subset inline in `src/lib/bus.ts`.

## Goals / Non-Goals

**Goals:**
- Single bus: `src/lib/bus.ts`, implementation untouched
- Single event type location: `BusEvent` in `src/types.ts`, imported by the bus
- Callers use standard EventEmitter API (`Bus.emit`, `Bus.on`, `Bus.off`)

**Non-Goals:**
- Changing the bus implementation (emit override, `__infId`, class structure)
- Adding wrapper methods like `publish()`/`subscribe()` to the EventEmitter bus
- Renaming the `Bus` export
- Changing `__infId` to `id` or any other field name

## Decisions

### Event types live in src/types.ts, not in the bus

The bus imports `BusEvent` from `../types.ts`. This avoids circular imports: a new domain module can import the bus to emit events AND contribute new event variants to the `BusEvent` union in `types.ts` without creating a cycle.

```
src/types.ts          src/lib/bus.ts         src/chat/echo.ts
┌──────────┐          ┌──────────┐           ┌──────────┐
│ BusEvent │◄─import──│ Bus      │◄─import───│ caller   │
│ (union)  │          │ (emitter)│           │          │
└──────────┘          └──────────┘           └──────────┘
     ▲                                            │
     └────────────import BusEvent─────────────────┘
```

No module needs to import both the bus AND the type from the same file. The bus is a runtime concern; the type is a compile-time concern.

Alternative considered: dedicated `src/events.ts`. Not needed yet — `src/types.ts` already houses the canonical union alongside the domain models the events reference (`Message`, `Part`). Split when a second domain emerges.

### Callers use raw EventEmitter API

Callers switch from `bus.publish(event)` / `bus.subscribe(fn)` to `Bus.emit("inf", event)` / `Bus.on("inf", fn)` / `Bus.off("inf", fn)`. This is the standard EventEmitter contract — no wrappers needed.

For unsubscribe in Solid components: store the handler reference and call `Bus.off("inf", handler)` in `onCleanup`.

### __infId stays as infrastructure-level stamp

`__infId` is an internal ordering/tracing stamp. Events may define their own `id` fields for domain purposes (e.g., `message.id`, `session.id`). The double-underscore prefix signals "infrastructure, not domain." The `??=` assignment means an event re-emitted keeps its original stamp.

## Risks / Trade-offs

- [API verbosity] `Bus.emit("inf", event)` is more verbose than `bus.publish(event)`. → Acceptable: it's explicit about the channel name and follows stdlib conventions.
- [No unsubscribe sugar] Callers must hold a handler reference for cleanup. → Standard EventEmitter pattern; Solid's `onCleanup` handles this naturally.
