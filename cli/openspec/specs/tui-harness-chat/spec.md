# tui-harness-chat Specification

## Purpose
The TUI's embedded harness chat lifecycle — the product conversation surface (plain `inflexa`) driving the harness conversation agent at managed parity. Covers boot-on-open gating (state machine, animation, failure surface, quit semantics), the emit adapter contract (harness `contracts/` vocabulary, clone-on-receive, sub-agent depth filter), the session↔thread binding, turn abort semantics, turn-failure observability (readable banner, logged structured cause, details view), and the data-profile lifecycle at managed parity (the drift-aware auto-trigger that follows the input set, clear-on-empty, and the manual re-profile surfaces). Lives across `src/tui/hooks/{boot,conversation,profile_parity}.ts`, `src/tui/app.launch.tsx`, `src/tui/app.tsx`, and the shared engines `src/modules/harness/{turn,profile_trigger}.ts`.

## Requirements

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

### Requirement: Turn failures are observable

A failed turn SHALL never be a dead end. The failure banner's summary SHALL be derived from the
structured cause — an `Error` renders its name and message (with one level of `.cause`), a
discriminated `{type, …}` error renders its discriminant and message — never a default object
coercion (`[object Object]`). The FULL structured cause SHALL be logged at error level from the
shared turn engine (so both the TUI and the dev REPL record it in the file log — the one place the
whole value survives), and an `appendTurn` fault SHALL be logged at warn. The TUI SHALL retain the
last turn failure's raw cause and offer a leader-keybound details view (documented in which-key,
hinted in the banner with a label derived from the live binding) rendering the full cause — stack,
nested causes, or the pretty-printed structured object — through the standard results dialog. The
retained failure SHALL clear when a new turn starts. `thread_gone`, which carries no raw cause,
retains a structured stand-in so the details view explains the reason rather than showing empty.

#### Scenario: A structured cause renders readably everywhere

- **WHEN** a turn fails with a discriminated error object (e.g. a harness `ProviderError`)
- **THEN** the banner shows the discriminant and message (never `[object Object]`), and the file log carries the complete structured cause

#### Scenario: The details view shows the whole failure

- **WHEN** the user presses the error-details leader key after a failed turn
- **THEN** a dialog renders the full cause (stack and nested causes for an `Error`, pretty-printed JSON for a structured object)

#### Scenario: A new turn clears the retained failure

- **WHEN** the user sends a new message after a failure
- **THEN** the banner and the retained cause reset, and the details view reports no recent turn error

### Requirement: One generation token orders every write to the message store

Both asynchronous producers that write the conversation store SHALL claim the same monotonic
generation token at entry, and SHALL re-check it after every `await` before writing the message store,
the streaming signals, the error banner, or the chat status. Those producers are a transcript load
(`loadMessages`) and a turn (`send`, through its emit adapter and `finishTurn`). The newest
store-writing operation to have *started* wins; any older one SHALL drop silently.

A turn therefore supersedes a transcript load already in flight: the load is a replay of durable state
the turn is about to append to, while the turn carries the user's live input. `resetHotState` SHALL
also claim the token, so a load started for a session the user has swapped away from can never
repopulate the cleared store.

#### Scenario: A load resolving mid-turn does not wipe the turn

- **WHEN** `loadMessages` is awaiting its page read and the user submits a turn, and the page read then resolves
- **THEN** the load SHALL drop without writing
- **AND** the user message and the in-flight assistant message SHALL remain mounted
- **AND** subsequent streamed parts SHALL continue to append to that assistant message

#### Scenario: A turn submitted the instant boot completes survives

- **WHEN** the runtime reaches `ready`, the transcript load starts, and the user submits a message typed during the boot animation
- **THEN** the turn SHALL render normally and the transcript load SHALL drop

#### Scenario: A load started for a swapped-away session never lands

- **WHEN** `loadMessages` is in flight for session A and `resetHotState` runs for a swap to session B
- **THEN** the session-A load SHALL drop without writing

### Requirement: A delta-less final segment renders after a mid-turn part

The chat SHALL render the engine's `fallbackText` as a message part whenever a turn's streamed text
buffer is empty at completion and that fallback is non-empty. This SHALL hold even when a non-text
part (a tool chip, a plan card, a run card) arrived mid-turn and sealed the prior streaming segment:
the chat SHALL open a fresh streaming segment for the fallback so it lands **after** the part that
interrupted the prose, matching the order a transcript reload produces.

An empty streamed buffer at turn end means no delta arrived since the last seal, and therefore that the
final assistant message's text never streamed — so the fallback is never a duplicate of text already on
screen.

#### Scenario: Prose, then a tool, then a delta-less answer

- **WHEN** a turn streams prose, runs a tool, emits no further text deltas, and the engine returns a non-empty `fallbackText`
- **THEN** the assistant message SHALL render the prose, then the tool chip, then the fallback text as a trailing part

#### Scenario: A streamed answer is not duplicated

- **WHEN** a turn's final assistant text arrived as deltas and is still in the streamed buffer at completion
- **THEN** the fallback text SHALL NOT be rendered a second time

#### Scenario: A turn ending on a card leaves no empty part

- **WHEN** a turn's last event is a plan card and the engine's `fallbackText` is empty
- **THEN** no trailing empty text part SHALL be appended

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

The TUI SHALL keep the data profile at managed parity with the analysis's **current input set**, not
merely trigger it once. The parity check SHALL run when the runtime reaches `ready`, after an
analysis swap, on input mutations (the `prov.input_added` / `prov.input_removed` bus events every
input-edit surface emits — debounced and coalesced per analysis, since batch edits emit bursts), and
once when a profile it observed `running` completes.

Parity SHALL be judged on the input files' **drift signatures** — `(fileId, size, mtimeMs)`, enumerated
read-only per `input-staging` (no content hashing, no tree writes) — not on their identities alone, so
that editing an input file's bytes in place at the same path re-profiles. The check SHALL compare that
set against the signatures the completed profile recorded (`result.inputFiles`), and act:

- no profile, or a `pending` row, with a non-empty input set → stage → seed → trigger (the same
  sequence as the profile command), surfacing the start as a notice;
- a completed profile whose recorded signature set equals the current set → silent skip;
- a completed profile whose recorded signature set differs → re-stage → seed → trigger (the trigger's
  completed-row CAS restarts it), surfacing a re-profiling notice;
- a completed profile that records **no** signatures (a null result, or one written before the
  signature field existed) → treated as drifted and re-profiled, never trusted;
- an empty input set while a profile exists → clear the profile through the harness ledger op so
  the sidebar honestly returns to "not profiled", surfacing an informational notice;
- an empty input set with no profile → silent skip;
- a `running` profile → skip (the completion edge re-runs the check, so edits made mid-profile are
  not lost until the next open);
- a `failed` profile → no auto-retry (managed parity: retrying a failure is deliberate) — the
  manual re-trigger and the dev profile command cover it.

Every entry into the profile lifecycle — the parity edges above and the deliberate manual re-profile —
SHALL be **serialized**: at most one may run its stage → seed → trigger sequence at a time, and one
arriving while another runs SHALL queue behind it rather than be dropped, because the edges fire
precisely because state changed. Serialization is required for two reasons the ledger CAS cannot
supply, since it runs only after staging: concurrent `stageInputs` calls on one workspace tree race the
tree-reconciliation delete, and a concurrent clear can null `seed_input_file_ids` between another
drive's seed write and its trigger.

Chat SHALL NOT be gated on profile state. Triggers and clears SHALL be non-blocking and SHALL poke
the sidebar's live store (these are the ledger edges outside its own refresh triggers). A check
whose analysis was swapped away while it was in flight SHALL drop both its side effects and its
notice.

#### Scenario: First open of an analysis with inputs profiles it

- **WHEN** the TUI opens an analysis that has inputs but has never been profiled
- **THEN** the profile workflow is triggered without blocking the chat, and a notice reports it started

#### Scenario: Chat is never blocked on the profile

- **WHEN** the parity check triggers a profile workflow on chat open
- **THEN** the chat accepts turns immediately and the check returns as soon as the trigger is dispatched

#### Scenario: Chat is usable while the profile runs

- **WHEN** the profile workflow is still running
- **THEN** a submitted message runs a normal turn (no gate, no refusal)

#### Scenario: Adding an input to a profiled analysis re-profiles it

- **WHEN** the user adds an input (file picker or remove/add commands) to an analysis whose profile completed, while the runtime is ready
- **THEN** the drift check re-triggers the profile without further user action, a re-profiling notice appears, and the sidebar shows the profile running

#### Scenario: A file added inside a directory input is drift

- **WHEN** a new data file appears inside a directory that is enrolled as a single directory input, and any parity edge fires
- **THEN** the enumerated signature set differs from the profiled set and the profile re-triggers

#### Scenario: An in-place content edit re-profiles

- **WHEN** an input file's bytes change at the same path (altering its size or mtime) and a parity edge fires
- **THEN** the check SHALL observe drift and re-trigger the profile, rather than reporting the analysis already profiled

#### Scenario: A completed row without signatures re-profiles once

- **WHEN** the ledger's completed result predates the drift-signature field
- **THEN** the check SHALL treat it as drifted and re-profile

#### Scenario: Removing every input clears the profile

- **WHEN** the user removes the last input of an analysis with a completed profile
- **THEN** the profile is cleared, the DATA PROFILE section returns to "not profiled", and an informational notice explains why

#### Scenario: Edits during a running profile are caught at completion

- **WHEN** inputs change while a profile is running
- **THEN** the live check skips (already running), and when that profile completes the check re-runs and re-triggers on the drift

#### Scenario: Two edges firing together do not race the workspace tree

- **WHEN** an input-mutation edge and a profile-completion edge fire while a parity check is already staging
- **THEN** the later drives SHALL run strictly after the first completes
- **AND** `stageInputs` SHALL never execute concurrently for one analysis

#### Scenario: A clear cannot wipe a concurrent drive's seed

- **WHEN** one drive observes an emptied input set and clears the ledger while another drive is seeding a non-empty set
- **THEN** the two SHALL NOT interleave, and no drive SHALL report a start failure caused by the other's clear

### Requirement: The user can re-trigger profiling manually

The TUI SHALL offer a deliberate re-profile action — a command-palette entry and a keybound action
inside the DATA PROFILE details dialog (per `sidebar-live`) — that forces the stage → seed → trigger
sequence regardless of drift: a completed row restarts through the trigger's CAS; a `failed` row is
retry-claimed and started (the retry-claim + run path the profile command proves); a `running`
profile SHALL refuse with a notice and start nothing. Outcomes surface as notices and poke the
sidebar's live store. When a re-profile cannot start, each surface degrades in its own idiom: the
palette entry refuses with an explanatory notice (before the runtime is `ready`, or on an analysis
with no resolvable inputs), while the dialog action is simply not offered — no footer hint, no
binding (per `sidebar-live`).

#### Scenario: Re-profile restarts a completed profile

- **WHEN** the user invokes "Re-profile data" on an analysis whose profile completed — drifted or not
- **THEN** the profile workflow restarts, a notice reports it, and the sidebar shows it running

#### Scenario: Re-profile recovers a failed profile

- **WHEN** the user invokes the re-profile action on an analysis whose profile status is `failed`
- **THEN** the failed row is retry-claimed, the workflow starts, and the failure state clears from the sidebar

#### Scenario: Re-profile while running refuses

- **WHEN** the user invokes the re-profile action while a profile is running
- **THEN** a notice says a run is already in progress and no duplicate workflow starts
