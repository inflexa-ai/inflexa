## MODIFIED Requirements

<!-- The body below is the requirement as it stands, and the one change is the
     narrowing of the ready-edge thread resolution to the conversation type, with
     the sentence that gives its reason and the scenario that covers it. The rest
     is copied text, thus it keeps its original wording. -->

### Requirement: Opening an analysis chat boots the embedded runtime behind a gate

Opening an analysis chat in the TUI SHALL be a deliberate action that boots the embedded harness
runtime. Interactive prerequisites (the harness config validity gate and the sandbox-image
ensure/pull) SHALL run in the normal-stdio phase before the alternate screen; the runtime boot itself
SHALL run asynchronously after `render()`, driving a boot-state store
(`booting → ready | failed`). While not `ready`, the chat input SHALL be gated (submits refused, the
gate visible in the input affordance and status bar) and a boot animation SHALL render (spinner +
elapsed, design-gallery entered); session-scoped surfaces (the sidebar session line, the
session-switch command) SHALL show a placeholder / stay disabled, since thread metadata has no
pre-`ready` source. When boot reaches `ready`, the TUI SHALL resolve the conversation thread for the
open analysis: the most-recent live thread from
`ThreadStore.listThreads({analysisId, type: "conversation"})`, else a
freshly minted thread id (`randomUUIDv7()`) whose row is created by the first turn. The narrowing to
the `conversation` type keeps a report child out of the launch: the listing orders by last activity,
so a fresh report child would otherwise be the thread the next launch opens. A failed boot
SHALL render the boot-error taxonomy's actionable message as a terminal state — never a hang or a
dead screen. Ctrl+C at any boot stage SHALL quit through the graceful shutdown path (terminal
restored, locks released, whatever booted drained). No passive flow (bare `inflexa` resolving to no
analysis, the welcome screen, `--status` views) boots anything.

#### Scenario: The launch never opens a report child

- **WHEN** boot reaches `ready` and the most-recently-active thread of the analysis is a report child
- **THEN** the launch resolves the most-recent conversation instead, and the report child opens through the report surfaces alone
