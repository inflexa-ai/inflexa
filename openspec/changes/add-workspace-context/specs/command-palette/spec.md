## MODIFIED Requirements

### Requirement: Declarative command registry

The system SHALL define commands in a flat array `commands: Command[]` in `src/tui/commands.tsx`, where adding a command is a single array entry. The `Command` type SHALL carry: a stable dotted `id` (`CommandId`), a `title`, an optional `description`, a `category` (`CommandCategory`, a string-literal union — never raw `string`), an optional display-only `keybind` hint, an optional `enabled(ws: Workspace): boolean` predicate, and a `run(ws: Workspace): void | Promise<void>` action. The `id` SHALL be decoupled from the `title` so a rename does not break dispatch. The `Command`/`CommandId`/`CommandCategory` registry types SHALL co-locate in `commands.tsx` (not `src/types/`), since they are neither persisted entities nor the event contract; the `Workspace` type they reference SHALL be imported from `src/tui/workspace.ts`.

#### Scenario: Adding a command is one entry

- **WHEN** a developer appends one `Command` entry to `commands`
- **THEN** it appears in the palette with no other code changes

#### Scenario: Contextual availability

- **WHEN** a command's `enabled(ws)` returns false for the current workspace
- **THEN** that command is hidden from the palette

#### Scenario: Category is a domain type

- **WHEN** code assigns a `category` value outside the `CommandCategory` union
- **THEN** TypeScript rejects it at compile time (not a raw `string`)

### Requirement: In-app command context

The system SHALL source every command's argument from the `WorkspaceContext` store (see the `workspace-context` capability) rather than rebuilding a per-call snapshot. The `Workspace` SHALL expose the live chat scope (`sessionId`, `workingDir`, current `analysis` or `null`, linked `project` or `null`) and the in-app capabilities: `openDialog(render)` / `closeDialog()` (the dialog stack), `openSession(sessionId, workingDir, analysis)` (in-place chat swap — keeping the scope correct when switching analyses), and `quit()` (clean `renderer.destroy()` then `shutdown`). `app.tsx` SHALL pass the same store proxy both to `runCommand` and to keybinding-triggered command actions, so a command always reads the currently-open chat. Commands SHALL act only through this surface and SHALL NOT write to stdout, since the alt-screen owns the terminal; status-line feedback SHALL go through the module-level `notify` (`src/tui/hooks/notice.ts`).

#### Scenario: Command reads live scope

- **WHEN** a command runs
- **THEN** `ws.analysis` / `ws.sessionId` / `ws.workingDir` / `ws.project` reflect the currently-open chat

#### Scenario: Feedback without stdout

- **WHEN** a command reports success or failure
- **THEN** it calls `notify(...)` (rendered in the TUI), never `console.log`

### Requirement: Single dispatch verb

The system SHALL route every command invocation through one verb `runCommand(cmd: Command, ws: Workspace): Promise<void>` that awaits the command's `run`. The palette SHALL dispatch the selected command through `runCommand`; future keybind or slash entry points SHALL reuse the same verb rather than calling `run` directly.

#### Scenario: Palette dispatches via the verb

- **WHEN** a command is selected in the palette
- **THEN** the palette calls `runCommand(cmd, ws)` with the workspace from `useWorkspace()`

#### Scenario: Async commands are awaited

- **WHEN** a command's `run` returns a promise
- **THEN** `runCommand` awaits it before resolving
