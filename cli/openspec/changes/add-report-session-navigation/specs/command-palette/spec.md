## MODIFIED Requirements

<!-- The body below is the requirement as it stands, and the one change is the
     narrowing of the Switch session listing to the conversation type, with the
     sentence that gives its reason and the scenario that covers it. The rest is
     copied text, thus it keeps its original wording. -->

### Requirement: In-place session-switching commands

Building on the reactive chat screen (see the `chat-wiring` capability), the palette SHALL provide Switch analysis, Switch session, New analysis, and New session commands that swap the open chat in place via `ctx.openSession(threadId, workingDir, analysis)` without relaunching the process. Switch analysis SHALL present a picker over `listRecentAnalyses`; Switch session SHALL present a picker over the harness thread store's `listThreads({analysisId, type: "conversation"})` (live conversation threads, most-recently-active first) read over the booted runtime's pool, and SHALL be offered only when an analysis is open and the boot state is `ready` (thread metadata has no pre-`ready` source). The narrowing to the `conversation` type keeps one population in this picker; a report child reaches the user through the report-session navigation instead. New analysis SHALL prompt for a name and create then open it (a deliberate action, so minting its anchor marker is allowed); opening it resolves no existing thread, so a fresh thread id is minted and the row is created by the first turn. New session SHALL mint a fresh thread id inline and swap the open chat onto it in place — no row is written until the first turn creates it, typed `conversation` by the harness default with its title seeded from the message — and SHALL be offered under the same gate as Switch session; a dispatch by id while the boot state is not `ready` SHALL raise a notice (warn on `failed`, an in-progress notice otherwise) and leave the scope unchanged. The Switch session picker SHALL carry a pinned "Start a new session" row that stays present under any filter query and when the analysis has no listed threads; selecting it SHALL act exactly as New session. A New session invoked during a streaming turn SHALL behave as any same-analysis session swap: the reactive chat reset on the `sessionId` change aborts the in-flight turn. Any picker over an empty set SHALL show an empty-state message rather than a blank list.

#### Scenario: Switch analysis in place

- **WHEN** the user picks a different analysis from the palette
- **THEN** the chat swaps to that analysis's most-recent live thread (or an empty chat when it has none) without a process restart

#### Scenario: Switch session lists pg threads

- **WHEN** the user opens "Switch session" with the runtime `ready`
- **THEN** the picker lists the analysis's live conversation threads from the thread store, most-recently-active first

#### Scenario: The switch picker holds no report session

- **WHEN** the analysis holds a report child and the user opens "Switch session"
- **THEN** the picker lists no report session, because the listing narrows to the conversation type

#### Scenario: New analysis from the palette

- **WHEN** "New analysis" is submitted with a name
- **THEN** a new analysis is created and opened in place, with no thread row until the first message

#### Scenario: New session from the palette

- **WHEN** "New session" runs with an analysis open and the runtime `ready`
- **THEN** the chat swaps in place onto a freshly minted thread id under the same analysis, no row exists until the first message, and the sidebar shows the fresh-conversation placeholder

#### Scenario: New session cannot produce a non-conversation thread

- **WHEN** the first message is sent on a thread id minted by "New session"
- **THEN** the harness creates the row with its default `conversation` type, because no call on this path accepts a thread type — a construction property the `openSession` signature enforces at compile time, carrying no runtime check for a test to cover

#### Scenario: The switch picker offers creation

- **WHEN** the user opens "Switch session", including when the analysis has no listed threads or the filter query matches nothing
- **THEN** a pinned "Start a new session" row is present, and selecting it swaps the chat onto a fresh mint

#### Scenario: Switch session requires an analysis and a ready runtime

- **WHEN** no analysis is open in the chat, or the boot state is not `ready`
- **THEN** the command is not offered, and a dispatch by id raises a notice and leaves the scope unchanged
