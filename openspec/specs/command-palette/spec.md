# command-palette Specification

## Purpose
TBD - created by archiving change add-command-palette. Update Purpose after archive.
## Requirements
### Requirement: Declarative command registry

The system SHALL define commands in a flat array `commands: Command[]` in `src/tui/commands.tsx`, where adding a command is a single array entry. The `Command` type SHALL carry: a stable dotted `id` (`CommandId`), a `title`, an optional `description`, a `category` (`CommandCategory`, a string-literal union — never raw `string`), an optional display-only `keybind` hint, an optional `enabled(ctx: CommandContext): boolean` predicate, and a `run(ctx: CommandContext): void | Promise<void>` action. The `id` SHALL be decoupled from the `title` so a rename does not break dispatch. The registry types SHALL co-locate in `commands.tsx` (not `src/types/`), since they are neither persisted entities nor the event contract.

#### Scenario: Adding a command is one entry

- **WHEN** a developer appends one `Command` entry to `commands`
- **THEN** it appears in the palette with no other code changes

#### Scenario: Contextual availability

- **WHEN** a command's `enabled(ctx)` returns false for the current context
- **THEN** that command is hidden from the palette

#### Scenario: Category is a domain type

- **WHEN** code assigns a `category` value outside the `CommandCategory` union
- **THEN** TypeScript rejects it at compile time (not a raw `string`)

### Requirement: In-app command context

The system SHALL build a `CommandContext` in `app.tsx` and pass it to every command's `run`. It SHALL expose the live chat state (`sessionId`, `workingDir`, current `analysis` or `null`) and the in-app capabilities: `openDialog(render)` / `closeDialog()` (the dialog stack), `openSession(sessionId, workingDir, analysis)` (in-place chat swap — the `analysis` keeps `ctx.analysis` correct when switching analyses), `notify({ kind, text })` (status-line feedback), and `quit()` (clean `renderer.destroy()` then `shutdown`). Commands SHALL act only through this surface and SHALL NOT write to stdout, since the alt-screen owns the terminal.

#### Scenario: Command reads live state

- **WHEN** a command runs
- **THEN** `ctx.analysis` / `ctx.sessionId` / `ctx.workingDir` reflect the currently-open chat

#### Scenario: Feedback without stdout

- **WHEN** a command reports success or failure
- **THEN** it calls `ctx.notify(...)` (rendered in the TUI), never `console.log`

### Requirement: Single dispatch verb

The system SHALL route every command invocation through one verb `runCommand(cmd: Command, ctx: CommandContext): Promise<void>` that awaits the command's `run`. The palette SHALL dispatch the selected command through `runCommand`; future keybind or slash entry points SHALL reuse the same verb rather than calling `run` directly.

#### Scenario: Palette dispatches via the verb

- **WHEN** a command is selected in the palette
- **THEN** the palette calls `runCommand(cmd, ctx)`

#### Scenario: Async commands are awaited

- **WHEN** a command's `run` returns a promise
- **THEN** `runCommand` awaits it before resolving

### Requirement: Overlay dialog host with keyboard gating

`app.tsx` SHALL host a dialog stack rendered as a full-screen, absolutely-positioned overlay above the chat with `zIndex` 100 — a direct child of the root box, NOT a `<Portal>` (a Portal's wrapper box has no intrinsic size, so the `top/left/right/bottom=0` insets collapse it to the bottom of the layout). While the stack is non-empty (`dialogOpen()` is true), the chat screen's background `useKeyboard` handlers SHALL early-return so the top dialog owns the keyboard, and only the top dialog SHALL render. The in-flight chat abort (Ctrl+C while busy) SHALL remain active even with a dialog open, so a streaming response can still be cancelled. Pressing Esc SHALL pop the top dialog. Because `useKeyboard` is a global, focus-agnostic bus, gating SHALL be by the `dialogOpen()` signal — not by relying on `stopPropagation()` ordering between subscriptions.

#### Scenario: Modal owns the keyboard

- **WHEN** a dialog is open and the user types
- **THEN** the chat textarea and background shortcuts (other than the in-flight Ctrl+C abort) do not act on those keys

#### Scenario: Esc closes the top dialog

- **WHEN** Esc is pressed with a dialog open
- **THEN** the top dialog is popped and focus returns to the chat input

#### Scenario: Overlay floats above the chat

- **WHEN** a dialog is open
- **THEN** it renders over the chat via an absolutely-positioned overlay box (a direct child of the root box, `zIndex` 100), not inline in the chat layout

#### Scenario: Streaming abort still works with a dialog open

- **WHEN** a response is streaming and the user presses Ctrl+C while a dialog is open
- **THEN** the in-flight request is aborted

### Requirement: Command palette invocation and navigation

The chat TUI SHALL open the command palette on **Ctrl+K**, calling `key.preventDefault()` so the textarea does not also consume the key. The palette SHALL render a focused single-line search `<input>`, a grouped, scrollable result list (`<scrollbox>`) with the highlighted row scrolled into view, and a per-row keybind hint when a command declares one. Navigation SHALL be Up/Down (and Ctrl+P / Ctrl+N); Enter SHALL dispatch the highlighted command through `runCommand` and close the palette; Esc SHALL close it without acting.

#### Scenario: Open with Ctrl+K

- **WHEN** Ctrl+K is pressed in the chat
- **THEN** the palette opens with the search input focused and the textarea does not receive a `k` character

#### Scenario: Filter and run

- **WHEN** the user types a query and presses Enter
- **THEN** the highlighted matching command runs via `runCommand` and the palette closes

#### Scenario: Cancel

- **WHEN** Esc is pressed in the palette
- **THEN** the palette closes and no command runs

### Requirement: Inline fuzzy ranking without new dependencies

Palette filtering SHALL use a small subsequence scorer — the shared `subsequenceScore` in `src/lib/fuzzy.ts` — that ranks `title` matches above `category` matches; an empty query SHALL list all enabled commands grouped by category. The feature SHALL add no new dependencies — neither a fuzzy-search library nor `@opentui/keymap`.

#### Scenario: Subsequence match ranks by title

- **WHEN** the query is a subsequence of a command's title
- **THEN** that command appears, ranked above commands matched only on category

#### Scenario: Empty query lists all grouped

- **WHEN** the query is empty
- **THEN** every enabled command is shown, grouped by category

### Requirement: Phase-1 commands run in-app over shared cores

The palette SHALL ship the command set that needs no chat swap: Settings (embed the existing config screen as a dialog), Change theme (apply `setTheme` and persist via `writeConfig`), Open output folder (the library-pure `openOutputDir` core for the current analysis, which the `inf open` CLI's `runOpen` wraps), Show status (render `resolveContext` / `describeContext` output in a results dialog), List analyses (render `listRecentAnalyses` in a results dialog), New project (a prompt dialog calling `createProject`, with `Str256` validation at the boundary), and Quit (`ctx.quit()`). These commands SHALL reuse the existing library-pure module cores and SHALL surface results via dialogs or `ctx.notify`, never stdout.

#### Scenario: Open output folder reuses the core

- **WHEN** "Open output folder" runs with an analysis open
- **THEN** it calls the same `openOutputDir` core that the `inf open` command's `runOpen` wraps

#### Scenario: Read-only result renders in a dialog

- **WHEN** "List analyses" runs
- **THEN** `listRecentAnalyses` results render in a dialog, not to stdout

#### Scenario: New project over the shared core

- **WHEN** "New project" is submitted with a valid name
- **THEN** `createProject` is called and the outcome is shown via `ctx.notify`

#### Scenario: Open output folder disabled without an analysis

- **WHEN** no analysis is open in the chat
- **THEN** "Open output folder" is not offered (its `enabled` returns false)

#### Scenario: Empty results render an empty state

- **WHEN** "List analyses" runs and there are no analyses
- **THEN** the results dialog shows an empty-state message, not a blank list

### Requirement: In-place session-switching commands

Building on the reactive chat screen (see the `chat-wiring` capability), the palette SHALL provide Switch analysis, Switch session, and New analysis commands that swap the open chat in place via `ctx.openSession(sessionId, workingDir, analysis)` without relaunching the process. Switch analysis / Switch session SHALL present a picker dialog over `listRecentAnalyses` / `listSessionsByAnalysis`; New analysis SHALL prompt for a name and create then open it (a deliberate action, so minting its anchor marker is allowed). Switch session SHALL be offered only when an analysis is open (its `enabled` is false when `ctx.analysis` is null), and any picker over an empty set SHALL show an empty-state message rather than a blank list.

#### Scenario: Switch analysis in place

- **WHEN** the user picks a different analysis from the palette
- **THEN** the chat swaps to that analysis's session without a process restart

#### Scenario: New analysis from the palette

- **WHEN** "New analysis" is submitted with a name
- **THEN** a new analysis and session are created and opened in place

#### Scenario: Switch session requires an analysis

- **WHEN** no analysis is open in the chat
- **THEN** "Switch session" is not offered (its `enabled` returns false)

#### Scenario: Empty picker shows an empty state

- **WHEN** "Switch analysis" runs and there are no other analyses
- **THEN** the picker shows an empty-state message rather than a blank list

