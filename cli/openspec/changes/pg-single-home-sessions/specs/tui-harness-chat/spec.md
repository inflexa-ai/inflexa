## MODIFIED Requirements

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
open analysis: the most-recent live thread from `ThreadStore.listThreads({analysisId})`, else a
freshly minted thread id (`randomUUIDv7()`) whose row is created by the first turn. A failed boot
SHALL render the boot-error taxonomy's actionable message as a terminal state — never a hang or a
dead screen. Ctrl+C at any boot stage SHALL quit through the graceful shutdown path (terminal
restored, locks released, whatever booted drained). No passive flow (bare `inflexa` resolving to no
analysis, the welcome screen, `--status` views) boots anything.

#### Scenario: Input is gated until the runtime is ready

- **WHEN** the TUI opens an analysis chat and the runtime is still booting
- **THEN** submitting a message does nothing, the UI shows the boot state, and the first submit after `ready` starts a turn

#### Scenario: Thread resolves at the ready edge

- **WHEN** boot reaches `ready` for an analysis with prior live threads
- **THEN** the most-recently-active thread is resolved into the workspace scope and its transcript loads

#### Scenario: No threads yet means an empty chat, no row

- **WHEN** boot reaches `ready` for an analysis with no live threads
- **THEN** a fresh thread id is minted, the chat renders empty, and no thread row exists until the first message's turn creates it

#### Scenario: Boot failure is actionable, not fatal to the terminal

- **WHEN** the runtime boot fails (e.g. Postgres down, model unresolved, runtime already active elsewhere)
- **THEN** the TUI shows that gate's actionable message and the user can quit cleanly with the terminal restored

#### Scenario: Quit during boot restores the terminal

- **WHEN** the user quits while the boot is still in flight
- **THEN** the process exits through the graceful shutdown path with the terminal restored and no runtime left running

### Requirement: The thread binds one-to-one to the session

The pg conversation thread SHALL be the session identity — one id, one store. The TUI SHALL carry
the thread id in the workspace scope (minted at open when no existing thread is picked;
`prepareChatTurn` creates the row on first use), so thread resolution, the session picker, and
in-place swaps need no additional selection UI and no second identity store. The transcript's source
of truth SHALL be the pg thread (loaded via the harness history read path with recognized tool-calls
reconstructed as cards). Thread titles SHALL be pg-owned: seeded from the first user message and
renamed via `ThreadStore.updateTitle`. Swapping sessions SHALL rebind the thread scope and reload
the transcript; swapping to a different analysis SHALL additionally abort any in-flight turn,
exchange the per-analysis instance lock (refusing the swap with a notice when the target analysis is
held by another process), and re-run the profile parity check.

#### Scenario: Resuming a session resumes its thread

- **WHEN** the user reopens an analysis whose thread has prior harness turns
- **THEN** the transcript renders those turns from the pg thread and the next message appends to the same thread

#### Scenario: Rename writes the pg title

- **WHEN** the user renames the open session
- **THEN** `ThreadStore.updateTitle` persists it and every session surface (sidebar, picker) reflects the pg title

#### Scenario: Analysis swap exchanges the lock

- **WHEN** the user switches to an analysis already open in another inflexa process
- **THEN** the swap is refused with a notice naming the conflict and the current chat stays bound
