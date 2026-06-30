## Context

`src/tui/app.tsx` (393 lines) inlines the whole conversation concern: the `messages` store + `UIMessage` type (`29-33`, `45`), the `streamText`/`streamPartId`/`errorMsg` signals (`46-48`), `loadMessages` (`60-75`), the ~75-line bus reducer (`117-191`), its subscription (`193-196`), and the scrollbox + error-banner JSX (`313-329`). Three tendrils keep it from being a clean snip: the `Sidebar` (a full-height sibling, not a child of the stream) reads `messages.length` (`343`); `errorMsg` is written by both the reducer and `handleSubmit`; and the `AbortController` (`58`) is shared by `handleSubmit` (`269`), the session swap (`104`), and the abort keybind (`208`). `workspace.ts:41` already documents the intended seam — the host resets "messages, stream, status" after a swap via the `onOpenSession` callback — and `tui/hooks/status.ts:4` is the established pattern for holding chat state outside its renderer.

## Goals / Non-Goals

**Goals:**
- Move the conversation state + the live-stream view out of `app.tsx` into a `conversation` store + a `Chat` component, so `app.tsx` moves toward a pure composer.
- Preserve all current behavior: streaming, persistence flush on idle, error banner, in-place session swap, abort.

**Non-Goals:**
- Not extracting the `InputBar`/`handleSubmit` UI itself (a later step) — only its send call is redirected to the store.
- No change to the `chat()` engine, the bus contract, the DB layer, or `MessageBlock`.
- No new dependencies.

## Decisions

- **State in `tui/hooks/conversation.ts`, view in `tui/components/chat.tsx` — hook + view, not one component.** The `Sidebar` sibling needs `messageCount`, so the store cannot be private to `Chat`; a shared singleton (like `status.ts`) is the codebase's own answer for "state decoupled from its renderer" (`status.ts:4`). *Alternative considered:* a single self-contained `Chat` that lifts `messageCount` up to `app.tsx` via a prop — rejected because it leaves a relay signal in `app.tsx`, defeating the thinning.
- **The view lives in `tui/components/chat.tsx`, not `tui/layout/` or `modules/intelligence/`.** `layout/` is the app-shell frame (status bar, input, sidebar); the conversation is content, so it sits with the other composed view-components (`command_palette`, the dialogs) under `components/`. `modules/` is out because a view imports `tui/theme.ts`+opentui and "modules must never import `tui/`." This keeps the `intelligence` module headless (it owns `chat()`; the UI stays in `tui/`).
- **Session swap is driven by a reactive `createEffect(on(() => ws.sessionId, …))` in `Chat`, replacing the `onOpenSession` callback.** `Chat` mounts after `app.tsx` builds the workspace, so it cannot receive the imperative callback cleanly; a reactive effect keyed on the reactive store field covers both initial load and swap, and lets us delete the `onOpenSession` seam from `WorkspaceInit` + `createWorkspace`. *Alternative considered:* keep `onOpenSession` and have it call a `Chat`-exposed reset — rejected as more wiring than the effect, and the effect removes a seam rather than re-routing it.
- **`chatStatus` stays in `status.ts`.** Already correctly decoupled; the reducer keeps calling `setChatStatus`. The abort keybind's `enabled: chatStatus() === "busy"` (`207`) is unchanged.
- **`errorMsg` moves into the store with a `setError` setter.** Both writers (the reducer and `handleSubmit`) call the store; the banner renders inside `Chat`.

## Risks / Trade-offs

- **[A module-level `createStore` plus a bus subscription needs lifecycle for cleanup]** → The store is a module singleton (one chat mounts at a time, per `status.ts:4`); the *subscription* lives in `Chat`'s `onMount`/`onCleanup`, dispatching to the store's pure `applyBusEvent`. No subscription at module scope.
- **[The reactive swap effect could double-fire or miss the initial load]** → Use `on(() => ws.sessionId, …, { defer: false })` so it runs once on mount (initial load) and again on each id change; guard `resetHotState` to be idempotent. Verify by swapping sessions mid-stream and confirming abort + reload.
- **[Removing `onOpenSession` touches `workspace.ts`, which an in-progress change also edits]** → The edit is localized (drop one optional field + its call); `openSession` itself is untouched. Reconcile by keeping `openSession` as the sole scope writer.
- **[Behavior regression in the stream/flush logic]** → The reducer moves verbatim (same `produce` mutations); `typecheck` + a manual stream/swap/abort smoke confirm parity.
