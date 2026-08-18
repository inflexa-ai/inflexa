# chat-command Specification

## Purpose

The `inflexa chat <analysis>` command — a dev/E2E surface that converses with the harness conversation agent, scoped to a resolved analysis. It is a clack/stdout REPL, not a TUI, and it exercises the whole embedded conversational loop headlessly.

The product conversation surface is the TUI chat (capability `tui-harness-chat`). This REPL is registered only in the dev channel (refer to `dev-commands`), and a release build does not carry it.

Both surfaces drive the same shared turn engine (`src/modules/harness/turn.ts`). Both narrate one event stream through the shared readers in `src/modules/harness/chat_printer.ts`.

Lives in `src/modules/harness/dev/chat.ts`, which holds the REPL and the stdout printer that it builds.

## Requirements

### Requirement: Chat is a dev-channel harness REPL

The system MUST give a dedicated `inflexa chat <analysis>` command that converses with the harness conversation agent, scoped to a resolved analysis. It is a clack/stdout REPL, not a TUI surface. The dev channel registers it alone, and a release build does not carry it. Refer to `dev-commands`.

The command module MUST carry a `TODO(extend)` comment block that states its standing role. That block names the TUI chat (capability `tui-harness-chat`) as the product conversation surface. It also states that this REPL exists to exercise the harness loop headlessly, and that the channel gate keeps it out of a production build.

A passive flow MUST NOT boot the runtime or start a chat. There are three deliberate boot actions: this command, the `profile` and `run` commands of the dev channel, and an analysis chat that the TUI opens.

Before it boots, the command MUST run the same pre-flight prerequisite gates as the run and profile launches. It MUST acquire the per-analysis instance lock after the resolution and before the boot.

#### Scenario: The dev surface is marked in code

- **WHEN** the chat command module is inspected
- **THEN** it carries a `TODO(extend)` block naming the TUI chat as the product surface and the dev-channel gate as this command's standing disposition

#### Scenario: Absent from release builds

- **WHEN** a release-channel build runs `inflexa chat`
- **THEN** the invocation fails non-zero as an unrecognized argument (the command is not registered), per `dev-commands`

#### Scenario: Failed prerequisite is reported before side effects

- **WHEN** a pre-flight gate fails (the sandbox image, the embedding endpoint, the skills directory, the templates directory, the proxy key, the model, or Postgres)
- **THEN** the command exits with that gate's actionable message and the runtime was never booted

#### Scenario: Locked analysis is refused before boot

- **WHEN** the analysis is already held by another live inflexa process
- **THEN** the command prints the conflict to stderr and exits non-zero without booting the runtime

### Requirement: The turn loop runs through the harness app-fn seam

Each turn MUST be exactly the transport-free sequence of the harness:

1. `prepareChatTurn` — the ownership gate, the title seed, the analysis-status load, and the message assembly.
2. `runAgent` — with the agent that the harness resolves for the thread's type. It also takes the
   provider of the booted runtime, a turn-scoped abort signal, the emit sink of the surface, and
   the pass-through run step.
3. `appendTurn` — which persists `[userMessage, ...loopOutput]` to the pg thread store.

The engine MUST resolve the agent between the prepare step and the run step. It resolves `agents.forThread(threadType)` over the type that the prepare ok result reports. It MUST NOT take a pre-selected agent from a caller.

A type that the harness refuses (`unregistered_thread_type`) MUST end the turn as its own terminal outcome, distinct from a prepare failure. The engine never calls `runAgent` and it persists nothing. This obeys the persistence contract, which appends only on a path that reaches `runAgent`.

This sequence MUST live in ONE shared turn-engine module that both this REPL and the TUI chat consume. The REPL MUST NOT carry its own copy of the turn body.

The agent session MUST carry the thread id in its scope, so a plan that runs from chat stamps `cortex_runs.thread_id`. The cli MUST NOT import the DBOS SDK anywhere in the chat path. It MUST NOT issue raw SQL against a harness-owned table there either.

#### Scenario: A turn round-trips the thread machinery

- **WHEN** a user sends a second message in the same chat
- **THEN** the assembled context contains the persisted prior turn (token-budgeted window), the working-memory render, and the analysis context
- **AND** the new turn is appended to the same thread

#### Scenario: Chat-launched runs carry thread lineage

- **WHEN** the agent executes an approved plan during a chat
- **THEN** the resulting run row's `thread_id` equals the chat's thread id

#### Scenario: One turn engine serves both surfaces

- **WHEN** the REPL and the TUI each run a turn
- **THEN** both drive the same exported turn-engine function, and neither carries a private prepare-run-append sequence

#### Scenario: A conversation thread resolves the conversation agent

- **WHEN** a turn runs on a thread whose type is `conversation`
- **THEN** the engine hands `runAgent` the agent `agents.forThread("conversation")` resolves, and the turn proceeds as before

#### Scenario: An unregistered thread type refuses the turn before the loop

- **WHEN** a turn runs on a thread whose type has no registered agent in this build
- **THEN** the engine returns the unresolved-agent outcome naming the thread type
- **AND** `runAgent` is never called, nothing is appended to the thread, and the REPL prints the refusal to stderr

### Requirement: Thread selection is new-by-default with explicit resume

By default, a chat invocation MUST make a fresh thread for the analysis. It MUST also accept an explicit thread reference, to resume an existing thread.

The command MUST refuse a thread that does not exist, and a thread that belongs to a different analysis, with an actionable message. The harness reports both as not-found, and the command must not tell them apart.

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

The emit sink of the command MUST render these to stdout:

- Accumulated `text-delta` content as it arrives, with no paced or typewriter reveal.
- A one-line tool chip on `tool-started`, closed on `tool-finished` with the tool name and the outcome.
- The `data-plan` part as text: the plan id, the title, and the step dependency graph. The graph is the same `planToDag` rendering that the TUI plan-card block uses, emitted as plain text. If the plan has no steps, or the graph fails to render, the sink falls back to a per-step list.
- The `data-run-card` part as text: the run id, the title, and the step count. These are the fields that the harness `RunCardData` contract carries, and it has no run-status field.

A text-shaped `data-presentation` part (`markdown`, `code`, `table`) MUST print inline as text. Markdown prints as its source, code prints fenced, and a table prints as aligned text.

A pixel-shaped part MUST print one line for each entry. These parts are an `echart` or `svg` presentation (materialized through the shared cache), and a `data-file-reference` entry. The line carries a kind tag, a title, and the resolved path inside an OSC 8 `file://` hyperlink. The plain path stays visible, for a terminal with no hyperlink support.

A sub-agent event is one whose call path is deeper than the top-level agent. The sink MUST NOT print such an event at the transcript root. If a tool call is open, the sink MUST print the activity label of the event as a subordinate line under that tool call. If no tool call is open, the sink MUST drop the event. Any other conversation-emitted part MUST print a one-line tagged fallback, so the sink observes it rather than swallows it.

The sink MUST extract what it renders at receipt. It MUST NOT retain a received event or part object, because an in-process emit shares mutable references with the agent loop.

Diagnostics go to stderr. Only the conversation goes to stdout.

#### Scenario: Streaming text renders as it arrives

- **WHEN** the agent streams a text answer
- **THEN** stdout shows the accumulated text growing per received chunk, with no per-character pacing

#### Scenario: Tool activity is visible as chips

- **WHEN** the agent calls a tool during a turn
- **THEN** stdout shows a chip line when the call starts and its outcome when it finishes

#### Scenario: A plan part renders readably

- **WHEN** the agent presents a plan through `show_plan`
- **THEN** stdout renders the plan id, the title, and the step dependency graph as plain text
- **AND** it falls back to a per-step list when the plan has no steps, or when the graph fails to render

#### Scenario: An openable renders as a linked path

- **WHEN** the agent shows a file through `show_file`
- **THEN** stdout prints one line for each file, with its caption and resolved absolute path
- **AND** the path is hyperlinked through OSC 8 and stays readable as plain text

#### Scenario: Sub-agent traffic stays out of the transcript

- **WHEN** an inner agent (planner, literature reviewer) emits events during a turn
- **THEN** no delta and no tool chip of that agent prints at the transcript root
- **AND** an activity label of that agent prints as a subordinate line under the open tool call
- **AND** nothing prints for that agent when no tool call is open

#### Scenario: Unknown parts are observed, not hidden

- **WHEN** the agent emits a conversation part the printer has no renderer for
- **THEN** stdout shows a one-line tagged mention of the part type

### Requirement: Plan approval is conversational

The command MUST NOT add an approval mechanism beyond the conversation itself. The prompt-enforced product gate is the whole mechanism: the agent presents a plan, it asks, and the user's message licenses `execute_plan`.

The command MUST NOT auto-approve, auto-execute, or inject a synthetic approval message. If an unprompted launch is ever observed, the structural fallback is a `RunAuthorizer` realization that refuses. That is an embedder seam, recorded in the design and not built here.

#### Scenario: Declining a plan launches nothing

- **WHEN** the agent presents a plan and the user's next message declines or requests changes
- **THEN** no run row is created and no workflow is launched

### Requirement: Interrupt aborts the turn, not the process

During a streaming turn, an interrupt (Ctrl+C) MUST abort the in-flight turn through its abort signal, and return to the prompt.

Under the abort contract of the harness, the aborted run RESOLVES with its partial transcript. The engine MUST persist `[userMessage, …partialLoopOutput]`. Thus the tokens already streamed to the terminal enter the thread, and the final assistant message carries the interruption marker of the harness. An abort before any output persists the user's message alone.

At the idle prompt, an interrupt or an EOF MUST exit the REPL cleanly. The command releases each held lock and shuts the runtime down through the existing graceful-shutdown path.

A second interrupt, while an abort is already in flight, can force the process to exit.

#### Scenario: Mid-turn interrupt returns to the prompt

- **WHEN** the user presses Ctrl+C while the agent is mid-turn
- **THEN** the turn's signal aborts, and the user's message and the streamed partial are persisted to the thread
- **AND** the REPL shows the next prompt in the same process

#### Scenario: At-prompt interrupt exits cleanly

- **WHEN** the user presses Ctrl+C (or EOF) at the idle prompt
- **THEN** the REPL releases held locks and exits through the graceful-shutdown path
