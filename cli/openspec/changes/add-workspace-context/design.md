## Context

The chat TUI (`src/tui/app.tsx`) mounts once with `{ sessionId, workingDir, analysis }` props, seeds three signals, and mutates them via `openSession` on an in-place analysis/session swap. Two consumers read that state through two different mechanisms:

- **Command actions** read a snapshot `CommandContext` that `buildCtx()` rebuilds on every call (palette open, keybinding) — `app.tsx:286`. Commands are module-level functions in `commands.tsx`, not Solid components.
- **`Sidebar`** reads raw `Accessor<Analysis>` / `Accessor<string>` props (`app.tsx:355`) so it repaints on a swap. The linked `project` is not shared; the sidebar re-derives it via `findProjectByRef` (`sidebar.tsx:76-83`).

The repo's existing idiom for *hot* ambient state is a module-singleton store (`hooks/status.ts`, `theme.ts`). The user has chosen a Solid **context** here instead, scoped to the chat subtree, as a forward seam for future read-only panels.

## Goals / Non-Goals

**Goals:**
- One `WorkspaceContext` holding the open-chat scope (`analysis`, `sessionId`, `workingDir`, `project`) + capabilities (`openDialog`, `closeDialog`, `openSession`, `quit`).
- Reactive plain-property reads in components; plain snapshot reads in the non-component command actions — with no accessor functions and flat read sites, so command bodies are unchanged.
- Delete `buildCtx()`; promote `project` into the single `openSession` write path; drop the sidebar's local derivation.

**Non-Goals:**
- No change to hot per-frame state: `messages`, `streamText`, `streamPartId`, `chatStatus` (already its own store), `errorMsg`, `sidebarOpen`, the `dialogs` stack stay local to `app.tsx`.
- No new dependency, no keymap-engine change, no Session-entity promotion (`sessionId` stays a string).
- `messageCount` stays an App-local prop on the sidebar — it is message-store length, not workspace scope.

## Decisions

### Backing store, not accessors
The context value is a Solid `createStore`. A store proxy is read as a plain property (`ws.analysis` — no call). Inside a tracking scope (JSX, `createMemo`) the read is reactive; outside one (a command's `run`/`enabled` body) it returns the current value as a snapshot. This satisfies both consumers from one object and keeps read sites flat, so existing command code that does `ctx.analysis` / `ctx.workingDir` is untouched. Alternative considered: accessors in the context (`Accessor<Analysis>`) — rejected by the user (adds `()` churn and a second shape). Alternative considered: a second module-singleton like `status.ts` — rejected because the user wants a subtree-scoped context as the growth seam; also, capabilities like `quit` close over `renderer` (only available after mount), which a Provider value built in `App` holds naturally.

**Load-bearing assumption to validate:** that a Solid store property read *outside* any reactive scope returns the current plain value (a snapshot), so command actions see live state at fire time. The implementer SHALL confirm this against the installed `solid-js` before relying on it; if false, fall back to passing a getter on the value object for the command-facing reads only.

### Capabilities live flat in the same object
`openDialog`, `closeDialog`, `openSession`, `quit` are static functions placed as flat fields beside the data, so reads stay `ws.quit()` (matching today's `ctx.quit()`). They are never `setStore`'d. `openSession` is declared as a hoisted `function` so the store initializer can reference it while it closes over `setWorkspace` only at call time.

### `project` promoted to the single write path
`project` is computed from `analysis.projectId` via `findProjectByRef` (a pure read — no marker write, the no-litter rule holds) at store construction and again inside `openSession` whenever `analysis` changes. No `createMemo`, no accessor — the store always holds a consistent `(analysis, project)` pair. The sidebar's local `project` memo is deleted.

### `analysis` stays `Analysis | null`
The unified store field keeps the `CommandContext.analysis` type (`Analysis | null`) so the command guards (`enabled: (ctx) => ctx.analysis !== null` for `session.switch`, `analysis.open-output`) stay meaningful. The `Sidebar`'s analysis sections — which today take a non-null `Accessor<Analysis>` and read `.name`/`.anchorId` without guards — gain a `<Show when={ws.analysis}>` wrapper for the (currently unreachable) null case. Alternative considered: make the field non-null `Analysis` (the App always launches with one — verified in `app.launch.tsx`, every `ChatTarget` has an analysis) — rejected because it silently turns those `enabled` guards into always-true, a behavior change outside this change's scope.

### Commands keep receiving the object as a parameter
`run`/`enabled` are module-level, so they cannot call `useWorkspace()`. `App` passes the same store proxy into `runCommand(cmd, ws)` and the keybinding-triggered actions (`app.tsx:184` `runCommandById`, the `leaderSeq("q")` quit). Component consumers (`Sidebar`, `CommandPalette`, the command dialogs) drop their `ctx`/accessor props and read `useWorkspace()` — they all render inside `App`'s tree (`app.tsx:393-400`), i.e. inside the Provider.

## Risks / Trade-offs

- [Store-snapshot-outside-tracking assumption is wrong] → Validate against installed `solid-js` first (above); narrow fallback is a command-facing getter, components still read the store reactively.
- [`ConfigApp` standalone mount has no Provider — `app_config.tsx:274-283`] → It must not call `useWorkspace()`; only its embedded-dialog mount (pushed via `openDialog`, inside the Provider) is covered. `useWorkspace()` throws outside a Provider, surfacing any violation immediately rather than returning `undefined`.
- [Capabilities mixed into a reactive store read oddly] → They are never `setStore`'d; a `setWorkspace` that passes only the four data keys leaves the function fields untouched (store merge is per-key). Accepted for flat read sites.
- [Sidebar null-guard for an unreachable case] → Minor extra `<Show>`; accepted to preserve the `enabled` guards without a behavior change.

## Migration Plan

Internal-only refactor, no runtime data migration. `CommandContext` → `Workspace` is a type rename with all importers updated and no shim (per CLAUDE.md). Verifiable by `bun run typecheck` and `bun run lint` passing, and the chat behaving identically (open palette, switch analysis/session, toggle sidebar, quit). Rollback is reverting the change set.

## Open Questions

- None blocking. The store-snapshot semantics check (above) is the one thing to confirm at the start of implementation.
