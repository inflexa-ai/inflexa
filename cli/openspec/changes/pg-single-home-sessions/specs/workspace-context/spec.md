## MODIFIED Requirements

### Requirement: Single openSession write path with project promotion

`openSession(threadId, workingDir, analysis)` SHALL be the only writer of the workspace data fields, where `threadId` is the pg thread id — the one session identity, possibly freshly minted with no row yet. On an in-place swap it SHALL set `sessionId` (the thread id), `workingDir`, `analysis`, and a freshly-resolved `project` together, and SHALL perform the existing local chat resets (abort any in-flight stream, clear `streamText`, `streamPartId`, `errorMsg`, reset the chat status to idle, then clear the message store and load the new thread's transcript from the harness history path). `project` SHALL be resolved from `analysis.projectId` via `findProjectByRef` — a pure read that writes no anchor marker — both at store construction and on every swap, so the store always holds a consistent `(analysis, project)` pair. The capability functions SHALL never be mutated through the store setter.

#### Scenario: Switching analysis updates scope and project together

- **WHEN** the user switches to a different analysis via the palette
- **THEN** `analysis`, the thread id, `workingDir`, and `project` all reflect the new analysis, and the linked project is re-resolved (or `null` when the new analysis has none)

#### Scenario: Project derivation writes nothing to disk

- **WHEN** `project` is resolved from `analysis.projectId`
- **THEN** the lookup uses `findProjectByRef` and creates no anchor marker (the no-litter rule for passive flows holds)

#### Scenario: Sidebar follows the swap from the context

- **WHEN** the analysis or thread changes via `openSession`
- **THEN** the `Sidebar` repaints its SESSION/ANALYSIS sections (including the project name) from the workspace store, with no analysis/thread props threaded to it
