## ADDED Requirements

### Requirement: Workspace context for the open-chat scope

The system SHALL provide a single Solid context `WorkspaceContext` (defined in a new `src/tui/workspace.ts`, no JSX) whose value is a `createStore` holding the open chat's rarely-changed, read-mostly scope and the in-app capabilities, in flat fields ordered data-then-capabilities: data `analysis` (`Analysis | null`), `sessionId` (`string`), `workingDir` (`string`), `project` (`Project | null`); capabilities `openDialog`, `closeDialog`, `openSession`, `quit`. `app.tsx` SHALL build the store exactly once (seeded from its mount props), wrap the chat render tree in `<WorkspaceContext.Provider>`, and expose a `useWorkspace()` hook that returns the store and SHALL throw when called outside a Provider. The store SHALL replace the per-call `buildCtx()` snapshot, which SHALL be deleted.

#### Scenario: Components read live scope reactively

- **WHEN** a component under the Provider reads `useWorkspace().analysis` (or `.sessionId` / `.workingDir` / `.project`) inside its render
- **THEN** it receives the current value and repaints when that value changes, with no accessor call

#### Scenario: Hook outside a Provider throws

- **WHEN** `useWorkspace()` is called outside a `WorkspaceContext.Provider`
- **THEN** it throws an error rather than returning `undefined`

#### Scenario: buildCtx is removed

- **WHEN** the change is implemented
- **THEN** `buildCtx()` no longer exists and the per-keystroke/per-open snapshot rebuild is gone

### Requirement: Single openSession write path with project promotion

`openSession(sessionId, workingDir, analysis)` SHALL be the only writer of the workspace data fields. On an in-place swap it SHALL set `sessionId`, `workingDir`, `analysis`, and a freshly-resolved `project` together, and SHALL perform the existing local chat resets (abort any in-flight stream, clear `streamText`, `streamPartId`, `errorMsg`, reset the chat status to idle, then clear the message store and load the new session's messages). `project` SHALL be resolved from `analysis.projectId` via `findProjectByRef` — a pure read that writes no anchor marker — both at store construction and on every swap, so the store always holds a consistent `(analysis, project)` pair. The capability functions SHALL never be mutated through the store setter.

#### Scenario: Switching analysis updates scope and project together

- **WHEN** the user switches to a different analysis via the palette
- **THEN** `analysis`, `sessionId`, `workingDir`, and `project` all reflect the new analysis, and the linked project is re-resolved (or `null` when the new analysis has none)

#### Scenario: Project derivation writes nothing to disk

- **WHEN** `project` is resolved from `analysis.projectId`
- **THEN** the lookup uses `findProjectByRef` and creates no anchor marker (the no-litter rule for passive flows holds)

#### Scenario: Sidebar follows the swap from the context

- **WHEN** the analysis or session changes via `openSession`
- **THEN** the `Sidebar` repaints its SESSION/ANALYSIS sections (including the project name) from the workspace store, with no analysis/session props threaded to it

### Requirement: Workspace scope excludes hot per-frame state

The workspace store SHALL hold only the open-chat scope and the four capabilities. Hot, per-frame, or component-local state SHALL NOT be placed in the context: `messages`, `streamText`, `streamPartId`, the chat status (which keeps its own `hooks/status.ts` store), `errorMsg`, `sidebarOpen`, and the `dialogs` stack SHALL remain local to `app.tsx`. The sidebar's `messageCount` SHALL remain an App-local prop, not a workspace field, because it is message-store length rather than workspace scope.

#### Scenario: Hot state stays out of the context

- **WHEN** a developer adds or reviews workspace fields
- **THEN** only rarely-changed scope and capabilities are present; streaming/message/status/dialog state is not
