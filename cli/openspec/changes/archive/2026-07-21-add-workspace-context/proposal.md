## Why

The open-chat scope (current `analysis`, `sessionId`, `workingDir`) is threaded two incompatible ways: a snapshot `CommandContext` that `buildCtx()` re-allocates on every palette open and keypress (`app.tsx:286`), and raw accessor props handed separately to the `Sidebar` (`app.tsx:355`). The linked `project` isn't shared at all — the sidebar re-derives it locally (`sidebar.tsx:76-83`). As the app grows more read-only panels, this duplicated, hand-threaded plumbing won't scale. A single Solid context for this rarely-changed, read-mostly state collapses both paths into one source of truth.

## What Changes

- Introduce one Solid context, `WorkspaceContext`, with a `useWorkspace()` hook, holding the open-chat scope (`analysis`, `sessionId`, `workingDir`, `project`) plus the in-app capabilities (`openDialog`, `closeDialog`, `openSession`, `quit`).
- Back the context with a Solid **store** (not accessors): components read plain reactive properties (`ws.analysis`), and the non-component command actions read the same properties as a plain snapshot outside any tracking scope. Read sites stay flat (`ws.analysis`, `ws.quit()`), so existing command bodies are unchanged.
- Promote `project`: compute it once at store construction and recompute it on each in-place `openSession` swap (single write path) — deleting the sidebar's local derivation.
- **BREAKING (internal):** delete `buildCtx()` and rename the `CommandContext` type to `Workspace`; update all importers, no shim. Commands' `run`/`enabled` keep receiving the object as a parameter (they are module-level, not components, so they cannot call `useWorkspace()`).
- `Sidebar`, `CommandPalette`, and the command dialogs drop their threaded `ctx`/accessor props and read `useWorkspace()`.

## Capabilities

### New Capabilities
- `workspace-context`: the Solid context + backing store that holds the open-chat scope and in-app capabilities, the `useWorkspace()` hook (throws outside the Provider), and the single `openSession` write path. The boundary that keeps it from becoming a god-object: only rarely-changed scope + capabilities live here; hot per-frame state stays out.

### Modified Capabilities
- `command-palette`: the "In-app command context" requirement changes — commands receive a `Workspace` sourced from the context store instead of a hand-built `CommandContext` from `buildCtx()`. The dispatch verb's type reference updates accordingly. Command availability/behavior is otherwise unchanged.

## Impact

- New file: `src/tui/workspace.ts` (`createContext`, `WorkspaceContext`, `useWorkspace`, the `Workspace` type).
- Modified: `src/tui/app.tsx` (build store once, Provider, delete `buildCtx`, project lookup, `openSession` setter), `src/tui/commands.tsx` (`CommandContext` → `Workspace`; dialogs use the hook), `src/tui/components/command_palette.tsx` (palette uses the hook), `src/tui/layout/sidebar.tsx` (read context; drop local project memo).
- No new dependencies. No change to the keymap engine, the chat-status store, or any persisted entity. `messageCount` stays an App-local prop on the sidebar (it is message-store length, not workspace scope).
- Hazard: `ConfigApp` has a standalone `inf config` mount with no Provider (`app_config.tsx:274-283`); it must not call `useWorkspace()`.
