## Why

The chat TUI is a dead end for everything except chatting: switching analysis, opening settings, changing theme, or running any `inf` verb all require quitting back to the shell. A command palette brings those actions in-app behind one keystroke, and a flat declarative registry makes adding the next command a one-entry edit rather than a UI-plumbing exercise.

## What Changes

- Add a **command palette** to the chat TUI (`src/tui/app.tsx`), opened with **Ctrl+K**, that fuzzy-filters a list of commands and runs the selected one.
- Add a **flat command registry** (`src/tui/commands.tsx`): a `Command[]` array plus the `Command`/`CommandContext`/`CommandCategory` types. Adding a command is a single array entry.
- Add an **overlay/dialog host** to `app.tsx` — an absolutely-positioned modal slot (a direct child of the root box, `zIndex` 100; not a `<Portal>`, whose size-less wrapper collapses the insets) with a dialog stack, since the chat screen has no modal system today. Background keyboard handlers gate on a `dialogOpen()` signal so a modal owns the keyboard while open.
- Add a **single dispatch verb** `runCommand(cmd, ctx)` reached by the palette today and by keybinds/slash entry later.
- Ship a **Phase-1 command set** that needs no chat swap: Settings, Change theme, Open output folder, Show status, List analyses, New project, Quit. These reuse existing library-pure module cores (`listRecentAnalyses`, `createProject`, `resolveContext`/`describeContext`, `openOutputDir`) — the palette renders results into dialogs or notifies via the status line, never to stdout (the alt-screen owns the terminal).
- **Phase 2:** make the chat screen's current session reactive and thread the active `Analysis` through `launchChat`/`App`, enabling in-place **Switch analysis / Switch session / New analysis** commands without relaunching the process.
- **Phase 3 (optional):** a "Suggested" group, per-command keybinds dispatching through the same `runCommand`, and a `/`-slash entry.
- **No new dependencies:** fuzzy ranking is a small inline subsequence scorer; `@opentui/keymap` is deliberately not adopted.

## Capabilities

### New Capabilities

- `command-palette`: The in-app command palette — its command registry and types, the `CommandContext` capability surface, the overlay/dialog host, the single `runCommand` dispatch verb, the Ctrl+K palette UI with inline fuzzy ranking, and the Phase-1/Phase-2 command sets (including in-place session switching).

### Modified Capabilities

- `theme-system`: The chat TUI gains an in-session theme switch surface — the palette's "Change theme" command and embedded settings. This relaxes the current requirement that `app.tsx` provides *no* in-session switch control.
- `chat-wiring`: `launchChat` and `App` thread the active `Analysis`, and the App's current session becomes reactive so the palette can swap the open chat in place (resume a different analysis/session) without a process restart.

## Impact

- **New files:** `src/tui/commands.tsx` (registry + types), `src/tui/command_palette.tsx` (palette UI + `runCommand` + the `PromptDialog`/`ResultsDialog` shells), `src/tui/select_list.tsx` (the reusable fuzzy select list + inline scorer, shared by the palette and the command pickers).
- **Modified files:** `src/tui/app.tsx` (dialog host, `CommandContext` builder, Ctrl+K binding, keyboard gating; Phase 2: reactive session + `Analysis` prop), `src/tui/launch.tsx` (pass `Analysis` to `App`), `src/tui/config.tsx` (parameterize `ConfigApp` with an `onClose` so the embedded Settings dialog does not tear down the renderer), `src/modules/analysis/open.ts` (extract the library-pure `openOutputDir` core; `runOpen` wraps it).
- **Reused unchanged:** `listRecentAnalyses`, `createAnalysis`, `createSession`, `createProject`, `resolveContext`/`describeContext`, `resolveAnchor`, `setTheme`/`writeConfig`.
- **Dependencies:** none added.
- **Keybinding:** Ctrl+K is newly reserved in the chat TUI (currently only Ctrl+C/abort and Enter/submit are bound).
