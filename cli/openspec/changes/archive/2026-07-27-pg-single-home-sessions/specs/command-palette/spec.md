## MODIFIED Requirements

### Requirement: In-place session-switching commands

Building on the reactive chat screen (see the `chat-wiring` capability), the palette SHALL provide Switch analysis, Switch session, and New analysis commands that swap the open chat in place via `ctx.openSession(threadId, workingDir, analysis)` without relaunching the process. Switch analysis SHALL present a picker over `listRecentAnalyses`; Switch session SHALL present a picker over the harness thread store's `listThreads({analysisId})` (live threads, most-recently-active first) read over the booted runtime's pool, and SHALL be offered only when an analysis is open and the boot state is `ready` (thread metadata has no pre-`ready` source). New analysis SHALL prompt for a name and create then open it (a deliberate action, so minting its anchor marker is allowed); opening it resolves no existing thread, so a fresh thread id is minted and the row is created by the first turn. Any picker over an empty set SHALL show an empty-state message rather than a blank list.

#### Scenario: Switch analysis in place

- **WHEN** the user picks a different analysis from the palette
- **THEN** the chat swaps to that analysis's most-recent live thread (or an empty chat when it has none) without a process restart

#### Scenario: Switch session lists pg threads

- **WHEN** the user opens "Switch session" with the runtime `ready`
- **THEN** the picker lists the analysis's live threads from the thread store, most-recently-active first

#### Scenario: New analysis from the palette

- **WHEN** "New analysis" is submitted with a name
- **THEN** a new analysis is created and opened in place, with no thread row until the first message

#### Scenario: Switch session requires an analysis and a ready runtime

- **WHEN** no analysis is open in the chat, or the boot state is not `ready`
- **THEN** "Switch session" is not offered (its `enabled` returns false)

#### Scenario: Empty picker shows an empty state

- **WHEN** "Switch analysis" runs and there are no other analyses
- **THEN** the picker shows an empty-state message rather than a blank list
