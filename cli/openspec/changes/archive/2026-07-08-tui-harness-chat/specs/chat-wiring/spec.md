# chat-wiring — Delta

## MODIFIED Requirements

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
