# tui-harness-chat — Delta

## ADDED Requirements

### Requirement: Opening an analysis chat boots the embedded runtime behind a gate

Opening an analysis chat in the TUI SHALL be a deliberate action that boots the embedded harness
runtime. Interactive prerequisites (the harness config validity gate and the sandbox-image
ensure/pull) SHALL run in the normal-stdio phase before the alternate screen; the runtime boot itself
SHALL run asynchronously after `render()`, driving a boot-state store
(`booting → ready | failed`). While not `ready`, the chat input SHALL be gated (submits refused, the
gate visible in the input affordance and status bar) and a boot animation SHALL render (spinner +
elapsed, design-gallery entered). A failed boot SHALL render the boot-error taxonomy's actionable
message as a terminal state — never a hang or a dead screen. Ctrl+C at any boot stage SHALL quit
through the graceful shutdown path (terminal restored, locks released, whatever booted drained). No
passive flow (bare `inflexa` resolving to no analysis, the welcome screen, `--status` views) boots
anything.

#### Scenario: Input is gated until the runtime is ready

- **WHEN** the TUI opens an analysis chat and the runtime is still booting
- **THEN** submitting a message does nothing, the UI shows the boot state, and the first submit after `ready` starts a turn

#### Scenario: Boot failure is actionable, not fatal to the terminal

- **WHEN** the runtime boot fails (e.g. Postgres down, model unresolved, runtime already active elsewhere)
- **THEN** the TUI shows that gate's actionable message and the user can quit cleanly with the terminal restored

#### Scenario: Quit during boot restores the terminal

- **WHEN** the user quits while the boot is still in flight
- **THEN** the process exits through the graceful shutdown path with the terminal restored and no runtime left running

### Requirement: The TUI chat drives the shared turn engine over harness contracts

A submitted message SHALL run one turn of the shared turn engine (`prepareChatTurn → runAgent` with
the streaming provider wrapper `→ appendTurn`, persisting `[userMessage, …loopOutput]`, or
`[userMessage]` alone on abort/throw) under a turn-scoped abort signal wired to the existing abort
chord (dialog-dismiss → abort-turn → quit ordering preserved). The TUI's emit adapter SHALL consume
the harness `contracts/` vocabulary directly (never the cli bus event shapes): text deltas accumulate
in the streaming signal and flush into the store on turn completion; `tool-started`/`tool-finished`
become a live tool part; `data-plan`/`data-run-card` become card parts; any other conversation part
renders a tagged mention (observed, not hidden); sub-agent events (call path deeper than the
top-level agent) are dropped. Every value crossing into the Solid store SHALL be extracted or cloned
at receipt — in-process emit shares mutable references with the agent loop. The agent session SHALL
carry the thread id in scope (chat-launched runs stamp `cortex_runs.thread_id`) with a length-1
`callPath` identifying the TUI surface.

#### Scenario: A plan is drafted, approved conversationally, and executed from the TUI

- **WHEN** the user asks for a plan, the agent presents it, and the user's next message approves it
- **THEN** the transcript shows the plan card, then the run card of a real launched run whose `thread_id` equals the chat's thread id

#### Scenario: Abort ends the turn, not the app

- **WHEN** the user hits the abort chord during a streaming turn
- **THEN** the turn's signal aborts, the user message is persisted, the UI returns to idle, and the app stays open

#### Scenario: Sub-agent traffic stays out of the transcript

- **WHEN** an inner agent (planner, literature reviewer) emits deltas or tool events during a turn
- **THEN** none of them render in the stream

### Requirement: The thread binds one-to-one to the session

The pg conversation thread id SHALL equal the active session id (`prepareChatTurn` creates the thread
row on first use), so session resolution, the session picker, and in-place swaps carry the thread with
zero additional selection UI. The transcript's source of truth SHALL be the pg thread (loaded via the
harness history read path with recognized tool-calls reconstructed as cards); legacy SQLite chat
transcripts are not rendered (frozen, readable via `inflexa sessions` until change 3 decides their
fate). Swapping sessions SHALL rebind the thread scope and reload the transcript; swapping to a
different analysis SHALL additionally abort any in-flight turn, exchange the per-analysis instance
lock (refusing the swap with a notice when the target analysis is held by another process), and re-run
the profile parity check.

#### Scenario: Resuming a session resumes its thread

- **WHEN** the user reopens an analysis whose session has prior harness turns
- **THEN** the transcript renders those turns from the pg thread and the next message appends to the same thread

#### Scenario: Analysis swap exchanges the lock

- **WHEN** the user switches to an analysis already open in another inflexa process
- **THEN** the swap is refused with a notice naming the conflict and the current chat stays bound

### Requirement: The data profile auto-triggers at parity

The TUI SHALL auto-trigger the data profile at managed parity: when the runtime reaches `ready` (and
after an analysis swap), if the analysis has resolvable inputs and no completed or running data
profile, it stages the inputs and triggers the data-profile workflow non-blocking (the same stage →
seed → trigger sequence as the profile command), surfacing the start and any trigger failure as a
notice. Chat SHALL NOT be gated on profile completion (managed
parity). An analysis with no resolvable inputs SHALL skip the trigger silently.

#### Scenario: First open of an analysis with inputs profiles it

- **WHEN** the TUI opens an analysis that has inputs but has never been profiled
- **THEN** the profile workflow is triggered without blocking the chat, and a notice reports it started

#### Scenario: Chat is usable while the profile runs

- **WHEN** the profile workflow is still running
- **THEN** a submitted message runs a normal turn (no gate, no refusal)
