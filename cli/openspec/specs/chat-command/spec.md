# chat-command Specification

## Purpose
The `inflexa chat <analysis>` command — a dev/E2E surface (a clack/stdout REPL, not a TUI) that converses with the harness conversation agent scoped to a resolved analysis, exercising the whole embedded conversational loop headlessly. The product conversation surface is the TUI chat (capability `tui-harness-chat`); this REPL is registered only in the dev channel (see `dev-commands`) and is absent from release builds. Both surfaces drive the same shared turn engine (`src/modules/harness/turn.ts`). Lives in `src/modules/harness/chat.ts` (+ `chat_printer.ts`).
## Requirements
### Requirement: Chat is a dev-channel harness REPL

The system SHALL provide a dedicated `inflexa chat <analysis>` command — a clack/stdout REPL, not a
TUI surface — that converses with the harness conversation agent scoped to a resolved analysis,
registered ONLY in the dev channel (see `dev-commands`): release builds do not carry it. The
command module SHALL carry a `TODO(extend)` comment block stating its standing role: the product
conversation surface is the TUI chat (capability `tui-harness-chat`); this REPL exists to exercise
the harness loop headlessly (dev/E2E) and is excluded from production builds by the channel gate.
No passive flow SHALL boot the runtime or start a chat — deliberate boot actions are this command,
the profile/run commands (dev channel), and opening an analysis chat in the TUI. The command SHALL
run the same pre-flight prerequisite gates as the run/profile launches before booting, and SHALL
acquire the per-analysis instance lock after resolution and before boot.

#### Scenario: The dev surface is marked in code

- **WHEN** the chat command module is inspected
- **THEN** it carries a `TODO(extend)` block naming the TUI chat as the product surface and the dev-channel gate as this command's standing disposition

#### Scenario: Absent from release builds

- **WHEN** a release-channel build runs `inflexa chat`
- **THEN** the invocation fails non-zero as an unrecognized argument (the command is not registered), per `dev-commands`

#### Scenario: Failed prerequisite is reported before side effects

- **WHEN** a pre-flight gate (sandbox image, embedding endpoint, skills dir, templates dir, proxy key, model, Postgres) fails
- **THEN** the command exits with that gate's actionable message and the runtime was never booted

#### Scenario: Locked analysis is refused before boot

- **WHEN** the analysis is already held by another live inflexa process
- **THEN** the command prints the conflict to stderr and exits non-zero without booting the runtime

### Requirement: The turn loop runs through the harness app-fn seam

Each turn SHALL be exactly the harness's transport-free sequence: `prepareChatTurn` (ownership
check, title seed, analysis-status load, message assembly) → `runAgent` with the assembled
conversation agent, the booted runtime's provider, a turn-scoped abort signal, the surface's emit
sink, and the pass-through run step → `appendTurn` persisting `[userMessage, ...loopOutput]` to the
pg thread store. This sequence SHALL live in ONE shared turn-engine module consumed by both this
REPL and the TUI chat — the REPL SHALL NOT carry its own copy of the turn body. The agent session
SHALL carry the thread id in scope, so a plan executed from chat stamps `cortex_runs.thread_id`. The
cli SHALL NOT import the DBOS SDK or issue raw SQL against harness-owned tables anywhere in the chat
path.

#### Scenario: A turn round-trips the thread machinery

- **WHEN** a user sends a second message in the same chat
- **THEN** the assembled context contains the persisted prior turn (token-budgeted window), the working-memory render, and the analysis context, and the new turn is appended to the same thread

#### Scenario: Chat-launched runs carry thread lineage

- **WHEN** the agent executes an approved plan during a chat
- **THEN** the resulting run row's `thread_id` equals the chat's thread id

#### Scenario: One turn engine serves both surfaces

- **WHEN** the REPL and the TUI each run a turn
- **THEN** both drive the same exported turn-engine function; neither carries a private prepare→run→append sequence

### Requirement: Thread selection is new-by-default with explicit resume

A chat invocation SHALL create a fresh thread for the analysis by default, and SHALL
accept an explicit thread reference to resume an existing one. A thread that does not
exist or belongs to a different analysis SHALL be refused with an actionable message
(the harness reports both as not-found; the command must not distinguish them).

#### Scenario: Default invocation starts a fresh thread

- **WHEN** the command runs without a thread reference
- **THEN** a new thread row scoped to the analysis exists and the first turn appends to it

#### Scenario: Resume continues an owned thread

- **WHEN** the command runs with the id of a thread belonging to the analysis
- **THEN** the conversation continues that thread with its history in the context window

#### Scenario: Foreign thread is refused

- **WHEN** the command runs with a thread id owned by a different analysis
- **THEN** the command reports the thread as not found and exits without starting a turn

### Requirement: The printer renders the emit stream coarsely and safely

The command's emit sink SHALL render, to stdout: accumulated `text-delta` content as it
arrives (no paced/typewriter reveal), one-line tool chips on `tool-started` completed on
`tool-finished` (tool name and outcome), and text renderings of the `data-plan` (plan
id, title, step list) and `data-run-card` (run id, title, step count — the fields the
harness `RunCardData` contract carries; it has no run-status field) parts. Text-shaped
`data-presentation` parts (`markdown`, `code`, `table`) SHALL print inline as text
(markdown source; code fenced; tables as aligned text). Pixel-shaped parts —
`echart`/`svg` presentations (materialized through the shared cache),
`data-file-reference` entries, and `data-report-preview` — SHALL print one line per
entry carrying a kind tag, title, and the resolved path wrapped in an OSC 8 `file://`
hyperlink with the plain path visible for terminals without hyperlink support;
`data-report-preview-failed` prints its reason. Events originating from sub-agents
(call path deeper than the top-level agent) SHALL be dropped. Any other
conversation-emitted part SHALL print a one-line tagged fallback rather than being
silently swallowed. The sink SHALL extract what it renders at receipt and SHALL NOT
retain received event or part objects (in-process emit shares mutable references with
the agent loop). Diagnostics go to stderr; stdout carries only the conversation.

#### Scenario: Streaming text renders as it arrives

- **WHEN** the agent streams a text answer
- **THEN** stdout shows the accumulated text growing per received chunk, with no per-character pacing

#### Scenario: Tool activity is visible as chips

- **WHEN** the agent calls a tool during a turn
- **THEN** stdout shows a chip line when the call starts and its outcome when it finishes

#### Scenario: A plan part renders readably

- **WHEN** the agent presents a plan via `show_plan`
- **THEN** stdout renders the plan id, title, and per-step lines from the embedded plan content

#### Scenario: An openable renders as a linked path

- **WHEN** the agent shows a file via `show_file`
- **THEN** stdout prints a line per file with its caption and resolved absolute path, hyperlinked via OSC 8 and readable as plain text

#### Scenario: Sub-agent traffic stays out of the transcript

- **WHEN** an inner agent (planner, literature reviewer) emits events during a turn
- **THEN** none of its deltas or tool chips appear on stdout

#### Scenario: Unknown parts are observed, not hidden

- **WHEN** the agent emits a conversation part the printer has no renderer for
- **THEN** stdout shows a one-line tagged mention of the part type

### Requirement: Plan approval is conversational

The command SHALL NOT add any approval mechanism beyond the conversation itself: the
prompt-enforced product gate (present plan → ask → the user's message licenses
`execute_plan`) is the whole mechanism, and the command SHALL NOT auto-approve,
auto-execute, or inject synthetic approval messages. (The structural fallback, if
unprompted launches are ever observed, is a refusing `RunAuthorizer` realization — an
embedder seam, recorded in the design, not built here.)

#### Scenario: Declining a plan launches nothing

- **WHEN** the agent presents a plan and the user's next message declines or requests changes
- **THEN** no run row is created and no workflow is launched

### Requirement: Interrupt aborts the turn, not the process

During a streaming turn, an interrupt (Ctrl+C) SHALL abort the in-flight turn via its
abort signal and return to the prompt. The user's message for the aborted turn SHALL be
persisted by `appendTurn`; the loop's partial assistant output is NOT retrievable
(`runAgent` throws on abort before returning its message array), so it is not persisted —
tokens already streamed remain visible on the terminal but do not enter the thread. At
the idle prompt, an interrupt (or EOF) SHALL exit the REPL cleanly: release held locks
and shut the runtime down through the existing graceful-shutdown path. A second interrupt
while an abort is already in flight MAY force-exit the process.

#### Scenario: Mid-turn interrupt returns to the prompt

- **WHEN** the user presses Ctrl+C while the agent is mid-turn
- **THEN** the turn's signal aborts, the user's message is persisted to the thread (the partial assistant output is not), and the REPL shows the next prompt in the same process

#### Scenario: At-prompt interrupt exits cleanly

- **WHEN** the user presses Ctrl+C (or Ctrl+D) at the idle prompt
- **THEN** the process releases the analysis lock, shuts the runtime down gracefully, and exits zero

