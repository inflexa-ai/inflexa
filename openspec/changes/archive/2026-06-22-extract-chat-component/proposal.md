## Why

`src/tui/app.tsx` is the root chat screen, but it also inlines the entire conversation concern: the `messages` store, the streaming signals, the ~75-line bus reducer, `loadMessages`, the scrollbox render, and the error banner (~110 lines). That makes `app.tsx` both the app composer *and* the chat engine's UI owner, so it cannot become the thin composition shell the rest of the TUI is built around (`StatusBar`, `Sidebar`, `InputBar` are already extracted; the conversation is the last big inline block). Extracting it is the next step toward `app.tsx` as a pure composer.

## What Changes

- Introduce a `conversation` store (`src/tui/hooks/conversation.ts`) — a module singleton mirroring `tui/hooks/status.ts` — that owns the chat hot state: the `messages` store, `streamText`/`streamPartId`, `errorMsg`, a `messageCount()` accessor, the `applyBusEvent` reducer (today's `app.tsx` handler), `loadMessages`, `resetHotState`, and the request lifecycle (`send`/`abort` owning the `AbortController` and the `chat()` call).
- Introduce a `Chat` component (`src/tui/components/chat.tsx` — content, not the layout shell) that subscribes to the bus, renders the message scrollbox + error banner, and reacts to `workspace.sessionId` to load on mount and reset+reload on an in-place swap.
- Thin `src/tui/app.tsx`: remove the conversation store, signals, reducer, subscription, `loadMessages`, and the stream/banner JSX; compose `<Chat />`; feed `<Sidebar messageCount={…} />` from the store; reduce `handleSubmit` to delegate to `conversation.send`; point the abort keybind at `conversation.abort`.
- **BREAKING (internal):** remove the `onOpenSession` reset callback from `WorkspaceInit` and its invocation in `src/tui/contexts/workspace.ts` — the `Chat` component's reactive effect on `workspace.sessionId` supersedes the imperative reset seam.
- `chatStatus` stays in `tui/hooks/status.ts` unchanged; the reducer keeps calling `setChatStatus`.

## Capabilities

### New Capabilities
- `chat-view`: The conversation presentation slice — the `conversation` hot-state store and the `Chat` component that renders the live message stream, drives streaming from the bus, and follows in-place session swaps. Owns what `app.tsx` inlines today, decoupled so `app.tsx` only composes it and the `Sidebar` reads its message count.

### Modified Capabilities
<!-- None at the spec level. `chat-wiring`'s "In-place chat switching" behavior (swap without restart, abort in-flight, bus filtering by the current session) is preserved — it moves from app.tsx's onOpenSession callback into Chat's reactive effect, an implementation relocation, not a behavior change. -->

## Impact

- **New files:** `src/tui/hooks/conversation.ts`, `src/tui/components/chat.tsx`.
- **Edited:** `src/tui/app.tsx` (thinned ~110 lines), `src/tui/contexts/workspace.ts` (drop `onOpenSession` seam), `src/tui/layout/sidebar.tsx` (no change to its API; `messageCount` now sourced from the store).
- **Unchanged:** `modules/intelligence/chat.ts` (the engine; the UI stays in `tui/` per "modules must never import `tui/`"), `tui/hooks/status.ts`, `tui/layout/message_block.tsx`, the bus contract (`types/events.ts`), and the DB layer.
- **No new dependencies. No DB/wire change.** Pure presentation refactor.
