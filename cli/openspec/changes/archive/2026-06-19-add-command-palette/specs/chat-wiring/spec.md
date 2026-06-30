## MODIFIED Requirements

### Requirement: Analysis-aware chat launcher

The system SHALL provide `launchChat({ analysis, resumeSessionId? })` in `src/tui/launch.tsx` (the presentation/app-shell layer, which may import module logic) that ensures the proxy is ready, resolves the session, seeds the theme, and renders the TUI with `workingDir` set to the analysis's resolved anchor path. Session resolution order SHALL be: the given `resumeSessionId`; else the analysis's most-recent session; else a newly created session linked to the analysis. Before rendering, it SHALL run passive `recoverAnchors([workingDir])` to heal a moved anchor — recovery only, never creation (no-litter policy). The launcher SHALL pass the active `analysis` to `App` so in-app commands can read the current analysis through `CommandContext`.

#### Scenario: Resume an explicit session

- **WHEN** `launchChat({ analysis, resumeSessionId })` is given a session id
- **THEN** that session is loaded and rendered

#### Scenario: Resume the most-recent session

- **WHEN** `launchChat({ analysis })` is called and the analysis has prior sessions
- **THEN** the most-recently-updated session is reused

#### Scenario: Create a session when none exist

- **WHEN** `launchChat({ analysis })` is called and the analysis has no sessions
- **THEN** a new session is created linked to the analysis, titled from the analysis name

#### Scenario: Working directory is the anchor path

- **WHEN** the TUI is rendered
- **THEN** `workingDir` is the analysis's resolved anchor path (not raw `process.cwd()`)

#### Scenario: Passive launch never litters

- **WHEN** `launchChat` runs in a folder whose anchor moved
- **THEN** the anchor is recovered (re-pointed) but no marker or anchors row is created by the launch

#### Scenario: App receives the active analysis

- **WHEN** the TUI is rendered
- **THEN** `App` is given the active `Analysis` (not just `sessionId` / `workingDir`), so in-app commands can read `ctx.analysis`

### Requirement: Shared launch preamble

The proxy-ready check (`ensureProxyReadyOrExit`), theme seed, and render options (`renderApp`) SHALL be factored so every launcher (`launchChat`, `launchDefault`, `launchNew`, `launchResume`) shares them and stays in sync. The `App` component's props SHALL be `sessionId` + `workingDir` + `analysis`, and the App's current session SHALL be held in a reactive signal (seeded from the prop) rather than read as a static prop value, so the open chat can be swapped in place. The interactive prompts (clack, via `lib/cli`) run in the normal-stdio phase before `render()` takes over the terminal.

#### Scenario: Launchers use the same preamble

- **WHEN** any launcher opens the TUI
- **THEN** the same proxy-ready handling, theme seeding, and render options are used

#### Scenario: App seeds a reactive current session

- **WHEN** `App` mounts with its `sessionId` prop
- **THEN** it holds the current session in a reactive signal seeded from that prop, so a later in-place switch can replace it

## ADDED Requirements

### Requirement: In-place chat switching

The `App` component SHALL expose an `openSession(sessionId, workingDir, analysis)` capability that swaps the open chat without a process restart: it SHALL update the reactive current session, working directory, and analysis, reload that session's messages, reset streaming and error state, and abort any in-flight chat request. The bus event handler SHALL filter incoming events by the current reactive session id (not a fixed prop value), so events apply to the chat that is now open.

#### Scenario: Swap without restart

- **WHEN** `openSession` is called with a different session
- **THEN** the chat reloads that session's messages in the same process and prior streaming/error state is cleared

#### Scenario: In-flight chat aborted on switch

- **WHEN** a switch occurs while a response is streaming
- **THEN** the in-flight request is aborted before the new session loads

#### Scenario: Bus filtering follows the active session

- **WHEN** bus events arrive after a switch
- **THEN** only events for the now-current session are applied
