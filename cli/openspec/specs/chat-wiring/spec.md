# chat-wiring Specification

## Purpose
Association of chat sessions with an analysis (the `sessions.analysis_id` link) and the analysis-aware chat launcher that resolves/creates a session and opens the TUI rooted at the analysis's resolved anchor path.
## Requirements
### Requirement: Sessions are created with an analysis link

The system SHALL provide `createSession(opts: { title?: string; analysisId: string })` returning `Result<Session, DbError>` that mints `id = randomUUIDv7()` inline and persists `analysisId` into the `sessions.analysis_id` column (not the JSON `data`), leaving the `Session` type unchanged. The `title` SHALL default when omitted.

#### Scenario: New session carries its analysis id

- **WHEN** `createSession({ title, analysisId })` succeeds
- **THEN** the `sessions` row's `analysis_id` column equals `analysisId`
- **AND** `listSessionsByAnalysis(analysisId)` returns that session

#### Scenario: Session JSON is unchanged

- **WHEN** a session is created with an analysis link
- **THEN** the `Session` JSON contains only the existing fields (id, title, createdAt, updatedAt) and the analysis link lives in the column

### Requirement: Analysis-aware chat launcher

The system SHALL provide analysis-aware launchers in `src/tui/app.launch.tsx` (the
presentation/app-shell layer, which may import module logic) — `launchNew`, `launchResume`, and
`launchDefault` — each resolving its `ChatTarget` through the headless resolvers in
`src/modules/analysis/launch.ts` and rendering the TUI through the one shared `renderChat` path,
with `workingDir` set to the analysis's resolved anchor path. Session resolution order SHALL be: an
explicit resume target; else the analysis's most-recent session; else a newly created session
linked to the analysis. Resolution SHALL heal a moved anchor passively (recovery only, never
creation — no-litter policy). The launcher SHALL pass the active `analysis` to `App` so in-app
commands can read the current analysis through the workspace context.

#### Scenario: Resume an explicit session

- **WHEN** a launcher resolves a target carrying an explicit resume session id
- **THEN** that session is loaded and rendered

#### Scenario: Resume the most-recent session

- **WHEN** a launcher opens an analysis with prior sessions and no explicit resume target
- **THEN** the most-recently-updated session is reused

#### Scenario: Create a session when none exist

- **WHEN** a launcher opens an analysis that has no sessions
- **THEN** a new session is created linked to the analysis, titled from the analysis name

#### Scenario: Working directory is the anchor path

- **WHEN** the TUI is rendered
- **THEN** `workingDir` is the analysis's resolved anchor path (not raw `process.cwd()`)

#### Scenario: Passive launch never litters

- **WHEN** a launcher runs in a folder whose anchor moved
- **THEN** the anchor is recovered (re-pointed) but no marker or anchors row is created by the launch

#### Scenario: App receives the active analysis

- **WHEN** the TUI is rendered
- **THEN** `App` is given the active `Analysis` (not just `sessionId` / `workingDir`), so in-app commands can read `ctx.analysis`

### Requirement: Shared launch preamble

Every launcher that opens an analysis chat SHALL share one factored preamble: the proxy-ready check
(`ensureProxyReadyOrExit`), the harness pre-flight gates that need normal stdio — the harness config
validity gate and the interactive sandbox-image ensure — the theme seed, and the render options,
all running in the normal-stdio phase before `render()` takes over the terminal.
After `render()`, the launcher SHALL kick off the asynchronous harness runtime boot that drives the
boot-state store (see `tui-harness-chat`). The `App` component's props SHALL remain
`sessionId` + `workingDir` + `analysis`, with the current session held reactively so the open chat
can be swapped in place.

#### Scenario: Launchers use the same preamble

- **WHEN** any launcher opens an analysis chat
- **THEN** the same proxy-ready handling, harness gates, theme seeding, and render options run before the alternate screen, and the runtime boot starts after it

#### Scenario: Interactive gates never run inside the alternate screen

- **WHEN** the sandbox image is missing and needs a confirm/pull
- **THEN** that interaction happens on normal stdio before the TUI renders

#### Scenario: App seeds a reactive current session

- **WHEN** `App` mounts with its `sessionId` prop
- **THEN** it holds the current session in a reactive signal seeded from that prop, so a later in-place switch can replace it

### Requirement: In-place chat switching

The `App` component SHALL expose an `openSession(sessionId, workingDir, analysis)` capability that
swaps the open chat without a process restart: it SHALL update the reactive current session, working
directory, and analysis, rebind the conversation thread scope (the thread id equals the session id),
reload that thread's transcript, reset streaming and error state, and abort any in-flight turn.
Swapping to a different analysis SHALL additionally exchange the per-analysis instance lock —
refusing the swap with a notice when the target analysis is held by another process — and re-run the
data-profile parity check. The event/turn plumbing SHALL follow the current reactive session id, so
turn output applies to the chat that is now open.

#### Scenario: Swap without restart

- **WHEN** `openSession` is called with a different session
- **THEN** the chat reloads that session's thread transcript in the same process and prior streaming/error state is cleared

#### Scenario: In-flight turn aborted on switch

- **WHEN** a switch occurs while a turn is streaming
- **THEN** the in-flight turn is aborted before the new thread loads

#### Scenario: Analysis swap refused when locked elsewhere

- **WHEN** `openSession` targets an analysis held by another live inflexa process
- **THEN** the swap is refused with a notice and the current chat scope is unchanged

