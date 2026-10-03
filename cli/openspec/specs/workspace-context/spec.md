# workspace-context Specification

## Purpose
TBD - created by archiving change add-workspace-context. Update Purpose after archive.

## Requirements

### Requirement: Workspace context for the open-chat scope

The system SHALL provide a single Solid context `WorkspaceContext` (no JSX) whose value is a `createStore` holding the open chat's rarely-changed, read-mostly scope and the in-app capabilities, in flat fields ordered data-then-capabilities: data `analysis` (`Analysis | null`), `sessionId` (`string | null`, `null` until the thread is bound), `workingDir` (`string`), and the scope that the local server gives for the analysis — `project` (`ProjectView | null`), `anchor` (`AnchorView | null`), and `inputCount` (`number | null`); capabilities `openDialog`, `closeDialog`, `openSession`, `refreshScope`, `quit`. `app.tsx` SHALL build the store exactly once (seeded from its mount props), wrap the chat render tree in `<WorkspaceContext.Provider>`, and expose a `useWorkspace()` hook that returns the store and SHALL throw when called outside a Provider. The store SHALL replace the per-call `buildCtx()` snapshot, which SHALL be deleted.

#### Scenario: Components read live scope reactively

- **WHEN** a component under the Provider reads `useWorkspace().analysis` (or `.sessionId` / `.workingDir` / `.project` / `.anchor` / `.inputCount`) inside its render
- **THEN** it receives the current value and repaints when that value changes, with no accessor call

#### Scenario: Hook outside a Provider throws

- **WHEN** `useWorkspace()` is called outside a `WorkspaceContext.Provider`
- **THEN** it throws an error rather than returning `undefined`

#### Scenario: buildCtx is removed

- **WHEN** the change is implemented
- **THEN** `buildCtx()` no longer exists and the per-keystroke/per-open snapshot rebuild is gone

### Requirement: Workspace scope excludes hot per-frame state

The workspace store SHALL hold only the open-chat scope and the capabilities. Hot, per-frame, or component-local state SHALL NOT be placed in the context: `messages`, `streamText`, `streamPartId`, the chat status (which keeps its own `hooks/status.ts` store), `errorMsg`, `sidebarOpen`, and the `dialogs` stack SHALL remain local to `app.tsx`. The sidebar's `messageCount` SHALL remain an App-local prop, not a workspace field, because it is message-store length rather than workspace scope.

#### Scenario: Hot state stays out of the context

- **WHEN** a developer adds or reviews workspace fields
- **THEN** only rarely-changed scope and capabilities are present; streaming/message/status/dialog state is not

### Requirement: Single openSession write path with the scope read from the local server

`openSession(threadId, workingDir, analysis)` MUST be the only writer of the `sessionId` and `workingDir` fields, and the first writer of the `analysis` field. `threadId` is the pg thread id: the one session identity, possibly new with no row yet. On an in-place swap, it MUST set the three fields together. A swap to a different analysis MUST abort each chat turn of this client in flight before the scope moves. It MUST also set `project`, `anchor`, and `inputCount` to `null`.

The chat resets its own hot state when `sessionId` changes.

The fields `analysis`, `project`, `anchor`, and `inputCount` MUST come from one read of the analysis through the local server (`GET {A}`). The store MUST start that read at these moments:

- at its construction, with no sighting, because the launch opened the analysis before the screen
- after each swap, also a swap within the same analysis, because a rename or a set-project swaps in place. This read is an open, thus it records a sighting of the anchor folder.
- at each `refreshScope` call, with no sighting (`touch=false`)

`refreshScope` runs after an input change of this client and at the end of each turn. It also runs at each tick of the poll that finds the server. Thus a rename or an input change of a different client shows at the next tick. The read creates no anchor marker. The write MUST use `reconcile`, which writes only the fields that changed and keeps each object. Thus an effect keyed on `workspace.analysis` does not run again at each tick.

A read that lands after a later swap to a different analysis MUST be dropped. A read that fails MUST keep the last answer. The capability functions MUST never change through the store setter.

#### Scenario: Switching analysis updates scope and project together

- **WHEN** the user switches to a different analysis through the palette
- **THEN** `analysis`, the thread id, and `workingDir` reflect the new analysis at once
- **AND** `project`, `anchor`, and `inputCount` read `null` until the read of the new analysis lands, then show its values (`project` stays `null` when the new analysis has none)

#### Scenario: A late read of the previous analysis is dropped

- **GIVEN** a read of analysis A is in flight
- **WHEN** the user swaps to analysis B before it lands
- **THEN** the answer for A does not reach the store, and the scope of B shows when its own read lands

#### Scenario: Sidebar follows the swap from the context

- **WHEN** the analysis or thread changes through `openSession`
- **THEN** the `Sidebar` repaints its SESSION/ANALYSIS sections (including the project name) from the workspace store, with no analysis/thread props threaded to it

#### Scenario: A rename of a different client shows at the next tick

- **GIVEN** a TUI that shows analysis A
- **WHEN** a different client renames A
- **THEN** the TUI shows the new name at the next tick of its poll, and the read records no sighting

#### Scenario: An unchanged answer runs no effect again

- **WHEN** a tick reads the analysis and nothing changed
- **THEN** the `analysis` object of the store stays the same object, and no transcript load or profile drive runs again
