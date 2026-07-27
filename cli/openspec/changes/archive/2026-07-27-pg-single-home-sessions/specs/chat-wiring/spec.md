## MODIFIED Requirements

### Requirement: Analysis-aware chat launcher

The system SHALL provide analysis-aware launchers in `src/tui/app.launch.tsx` (the
presentation/app-shell layer, which may import module logic) — `launchNew`, `launchResume`, and
`launchDefault` — each resolving its `ChatTarget` through the headless resolvers in
`src/modules/analysis/launch.ts` and rendering the TUI through the one shared `renderChat` path,
with `workingDir` set to the analysis's resolved anchor path. A `ChatTarget` SHALL carry only the
analysis and working directory: the launcher performs no session resolution and reads or writes no
session state — the conversation thread is resolved after the harness boot reaches `ready` (see
`tui-harness-chat`). Resolution SHALL heal a moved anchor passively (recovery only, never
creation — no-litter policy). The launcher SHALL pass the active `analysis` to `App` so in-app
commands can read the current analysis through the workspace context.

#### Scenario: Launch resolves no session

- **WHEN** a launcher resolves a `ChatTarget` for an analysis
- **THEN** the target carries the analysis and working directory only, and no session or thread state is read or created before `render()`

#### Scenario: Working directory is the anchor path

- **WHEN** the TUI is rendered
- **THEN** `workingDir` is the analysis's resolved anchor path (not raw `process.cwd()`)

#### Scenario: Passive launch never litters

- **WHEN** a launcher runs in a folder whose anchor moved
- **THEN** the anchor is recovered (re-pointed) but no marker or anchors row is created by the launch

#### Scenario: App receives the active analysis

- **WHEN** the TUI is rendered
- **THEN** `App` is given the active `Analysis` and `workingDir`, so in-app commands can read `ctx.analysis`

### Requirement: Shared launch preamble

Every launcher that opens an analysis chat SHALL share one factored preamble: the proxy-ready check
(`ensureProxyReadyOrExit`), the harness pre-flight gates that need normal stdio — the harness config
validity gate and the interactive sandbox-image ensure — the theme seed, and the render options,
all running in the normal-stdio phase before `render()` takes over the terminal.
After `render()`, the launcher SHALL kick off the asynchronous harness runtime boot that drives the
boot-state store (see `tui-harness-chat`). The `App` component's props SHALL be
`workingDir` + `analysis`; the current thread id is workspace state resolved after boot reaches
`ready` (never a launcher prop), held reactively so the open chat can be swapped in place.

#### Scenario: Launchers use the same preamble

- **WHEN** any launcher opens an analysis chat
- **THEN** the same proxy-ready handling, harness gates, theme seeding, and render options run before the alternate screen, and the runtime boot starts after it

#### Scenario: Interactive gates never run inside the alternate screen

- **WHEN** the sandbox image is missing and needs a confirm/pull
- **THEN** that interaction happens on normal stdio before the TUI renders

#### Scenario: App carries no session prop

- **WHEN** `App` mounts
- **THEN** its props are `workingDir` + `analysis`, and the current thread id is resolved into the reactive workspace state after boot reaches `ready`

### Requirement: In-place chat switching

The `App` component SHALL expose an `openSession(threadId, workingDir, analysis)` capability that
swaps the open chat without a process restart: it SHALL update the reactive current thread, working
directory, and analysis, rebind the conversation thread scope (the id is the pg thread id — the one
session identity), reload that thread's transcript, reset streaming and error state, and abort any
in-flight turn. Swapping to a different analysis SHALL additionally exchange the per-analysis
instance lock — refusing the swap with a notice when the target analysis is held by another
process — and re-run the data-profile parity check. The event/turn plumbing SHALL follow the
current reactive thread id, so turn output applies to the chat that is now open.

#### Scenario: Swap without restart

- **WHEN** `openSession` is called with a different thread
- **THEN** the chat reloads that thread's transcript in the same process and prior streaming/error state is cleared

#### Scenario: In-flight turn aborted on switch

- **WHEN** a switch occurs while a turn is streaming
- **THEN** the in-flight turn is aborted before the new thread loads

#### Scenario: Analysis swap refused when locked elsewhere

- **WHEN** `openSession` targets an analysis held by another live inflexa process
- **THEN** the swap is refused with a notice and the current chat scope is unchanged

## REMOVED Requirements

### Requirement: Sessions are created with an analysis link

**Reason**: The SQLite `sessions` table is removed; session identity is single-homed in the harness Postgres thread store, where `cortex_analysis_threads.analysis_id` already carries the analysis link.
**Migration**: No caller creates a session row. The thread row is created lazily by the first turn (`prepareChatTurn`), and the TUI mints the thread id (`randomUUIDv7()`) at open when no existing thread is picked — an identity, not a row.
