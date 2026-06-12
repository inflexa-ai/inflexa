## 1. Decouple event type from bus

- [x] 1.1 In `src/lib/bus.ts`, remove the inline `BusEvent` type and `import type { BusEvent } from "../types.ts"` instead. Update the `EventEmitter` generic accordingly. No other changes to the file.

## 2. Migrate callers

- [x] 2.1 Update `src/chat/echo.ts` — change import from `../bus.ts` to `../lib/bus.ts`, replace `bus.publish(...)` calls with `Bus.emit("inf", ...)`
- [x] 2.2 Update `src/tui/app.tsx` — change import from `../bus.ts` to `../lib/bus.ts`, replace `bus.subscribe(fn)` / `unsub()` with `Bus.on("inf", handler)` / `Bus.off("inf", handler)`

## 3. Cleanup

- [x] 3.1 Delete `src/bus.ts`
