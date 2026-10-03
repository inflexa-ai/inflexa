## MODIFIED Requirements

### Requirement: Chat is a dev-channel harness REPL

The system MUST give a dedicated `inflexa chat <analysis>` command that converses with the harness conversation agent, scoped to a resolved analysis. It is a clack/stdout REPL, not a TUI surface. The dev channel registers it alone, and a release build does not carry it. Refer to `dev-commands`.

The command module MUST carry a `TODO(extend)` comment block that states its standing role. That block names the TUI chat (capability `tui-harness-chat`) as the product conversation surface. It also states that this REPL exists to exercise the harness loop headlessly, and that the channel gate keeps it out of a production build.

The command MUST be a client of the local server. It boots no runtime and takes no lock in its own process. Before its action, it connects to the local server, and it starts one in the background when none answers (refer to `local-server`). The prerequisites of the runtime are the boot of the server, thus the command runs no pre-flight gate of its own.

A turn that the server refuses MUST NOT start. Examples are a runtime that is not ready, an analysis that a different process holds, and a thread that is gone. The REPL MUST print the refusal of the server to stderr, and then show the prompt again.

#### Scenario: The dev surface is marked in code

- **WHEN** the chat command module is inspected
- **THEN** it carries a `TODO(extend)` block naming the TUI chat as the product surface and the dev-channel gate as this command's standing disposition

#### Scenario: Absent from release builds

- **WHEN** a release-channel build runs `inflexa chat`
- **THEN** the invocation fails non-zero as an unrecognized argument (the command is not registered), per `dev-commands`

#### Scenario: Failed prerequisite is reported before side effects

- **WHEN** a prerequisite of the runtime fails (the sandbox image, the embedding endpoint, the skills directory, the proxy key, the model, or Postgres)
- **THEN** the boot of the server fails, the REPL prints the `unavailable` refusal of the server to stderr, and no turn starts

#### Scenario: A turn before the runtime is ready is refused

- **WHEN** the user sends a message while the runtime of the server is still starting
- **THEN** the REPL prints the `unavailable` refusal of the server to stderr, no turn starts, and the prompt shows again

#### Scenario: Locked analysis is refused before boot

- **WHEN** the analysis is already held by another live inflexa process
- **THEN** the REPL prints the `locked` refusal of the server to stderr, and no turn starts

### Requirement: The turn loop runs through the harness app-fn seam

Each REPL turn MUST be one turn of the chat route of the local server (`POST {A}/chat`), the same route that the TUI chat sends to. The REPL MUST NOT run a turn in its own process, and it MUST NOT carry its own copy of the turn body.

The server runs each turn through ONE shared turn-engine module, which runs the chat turn of the harness:

1. The harness opens the turn: the ownership gate, the title seed, the analysis-status load, and the message assembly.
2. The harness runs the agent that it resolves for the thread's type. The run takes the provider of the booted runtime, a turn-scoped abort signal, and the frame sink of the turn.
3. The harness stores the opening, each round when it completes, and the outcome in the pg thread store.

The engine MUST NOT take a pre-selected agent from a caller.

A type that the harness refuses (`unregistered_thread_type`) MUST end before the turn opens. The agent never runs, and nothing is stored. The server refuses the request with a message that names the thread type.

The agent session MUST carry the thread id in its scope, so a plan that runs from chat stamps `cortex_runs.thread_id`. The cli MUST NOT import the DBOS SDK anywhere in the chat turn path. It MUST NOT issue raw SQL against a harness-owned table there either.

#### Scenario: A turn round-trips the thread machinery

- **WHEN** a user sends a second message in the same chat
- **THEN** the assembled context contains the persisted prior turn (token-budgeted window), the working-memory render, and the analysis context
- **AND** the new turn is appended to the same thread

#### Scenario: Chat-launched runs carry thread lineage

- **WHEN** the agent executes an approved plan during a chat
- **THEN** the resulting run row's `thread_id` equals the chat's thread id

#### Scenario: One turn engine serves both surfaces

- **WHEN** the REPL and the TUI each run a turn
- **THEN** both send `POST {A}/chat` to the local server, and neither runs a private turn sequence

#### Scenario: A conversation thread resolves the conversation agent

- **WHEN** a turn runs on a thread whose type is `conversation`
- **THEN** the engine runs the agent that the harness resolves for `conversation`, and the turn proceeds as before

#### Scenario: An unregistered thread type refuses the turn before the loop

- **WHEN** a turn runs on a thread whose type has no registered agent in this build
- **THEN** the server refuses the turn with a message that names the thread type
- **AND** the agent never runs, nothing is appended to the thread, and the REPL prints the refusal to stderr

### Requirement: The printer renders the emit stream coarsely and safely

The frame sink of the command MUST render these frames of the turn stream to stdout:

- Accumulated `text-delta` content as it arrives, with no paced or typewriter reveal.
- A one-line tool chip on `tool-started`, closed on `tool-finished`. The chip carries the tool name, the call detail of the harness when the tool gives one, and the outcome.
- The `data-plan` part as text: the plan id, the title, and the step dependency graph. The graph is the same `planToDag` rendering that the TUI plan-card block uses, emitted as plain text. If the plan has no steps, or the graph fails to render, the sink falls back to a per-step list.
- The `data-run-card` part as text: the run id, the title, and the step count. These are the fields that the harness `RunCardData` contract carries, and it has no run-status field.

The outcome of a chip MUST separate the three harness states: done, error, and denied. Thus a refused approval does not print as a failure. The sink MUST treat the detail as opaque display text, and it MUST NOT parse it.

A text-shaped `data-presentation` part (`markdown`, `code`, `table`) MUST print inline as text. Markdown prints as its source, code prints fenced, and a table prints as aligned text.

A pixel-shaped part MUST print one line for each entry. These parts are an `echart` or `svg` presentation, and a `data-file-reference` entry. The REPL MUST get the path of each entry of a card from the local server in one request (`POST {A}/artifacts/resolve` with `materialize`), and the server writes each `echart` or `svg` file first. The REPL MUST NOT write an artifact file in its own process. The line carries a kind tag, a title, and the resolved path inside an OSC 8 `file://` hyperlink. The plain path stays visible, for a terminal with no hyperlink support.

A sub-agent frame is one whose call path is deeper than the top-level agent. The sink MUST NOT print such a frame at the transcript root. If a tool call is open, the sink MUST print the activity label of the frame as a subordinate line under that tool call. If no tool call is open, the sink MUST drop the frame. Any other conversation part MUST print a one-line tagged fallback, so the sink observes it rather than swallows it.

The sink MUST extract what it renders at receipt, and it MUST NOT retain a received frame or part object. Each frame is a fresh object that the client parsed from the stream, and the sink prints it at receipt. Thus nothing that happens to a frame later changes what the sink wrote.

Diagnostics go to stderr. Only the conversation goes to stdout.

#### Scenario: Streaming text renders as it arrives

- **WHEN** the agent streams a text answer
- **THEN** stdout shows the accumulated text growing per received chunk, with no per-character pacing

#### Scenario: Tool activity is visible as chips

- **WHEN** the agent calls a tool during a turn
- **THEN** stdout shows a chip line when the call starts and its outcome when it finishes

#### Scenario: A described call names what it is doing

- **WHEN** the agent calls a tool that declares a call description
- **THEN** the chip line carries the tool name and its detail, and a tool with no description prints the name alone

#### Scenario: A refused approval is not printed as a failure

- **WHEN** a tool call finishes with the `denied` outcome
- **THEN** the chip prints `denied`, not the word for an error

#### Scenario: A plan part renders readably

- **WHEN** the agent presents a plan through `show_plan`
- **THEN** stdout renders the plan id, the title, and the step dependency graph as plain text
- **AND** it falls back to a per-step list when the plan has no steps, or when the graph fails to render

#### Scenario: An openable renders as a linked path

- **WHEN** the agent shows a file through `show_file`
- **THEN** stdout prints one line for each file, with its caption and resolved absolute path
- **AND** the path is hyperlinked through OSC 8 and stays readable as plain text

#### Scenario: Sub-agent traffic stays out of the transcript

- **WHEN** an inner agent (planner, literature reviewer) emits frames during a turn
- **THEN** no delta and no tool chip of that agent prints at the transcript root
- **AND** an activity label of that agent prints as a subordinate line under the open tool call
- **AND** nothing prints for that agent when no tool call is open

#### Scenario: Unknown parts are observed, not hidden

- **WHEN** the agent emits a conversation part the printer has no renderer for
- **THEN** stdout shows a one-line tagged mention of the part type

### Requirement: Interrupt aborts the turn, not the process

During a streaming turn, an interrupt (Ctrl+C) MUST send the abort of the turn to the local server (`POST {T}/turns/:turnId/abort`). An interrupt that comes before the server names the turn MUST send the abort when the id arrives. The REPL MUST read the stream to its end, then print the outcome and return to the prompt.

Under the abort contract of the harness, the aborted run RESOLVES with its partial transcript. The harness keeps the opening, each completed round, and the streamed partial. Thus the tokens already streamed to the terminal enter the thread, and the final assistant message carries the interruption marker of the harness. An abort before any output keeps the user's message alone.

At the idle prompt, an interrupt or an EOF MUST exit the REPL cleanly through the existing graceful-shutdown path. The REPL holds no runtime and no lock, thus the local server keeps running.

A second interrupt, while an abort is already in flight, MUST end the REPL after the turn unwinds, with the exit code 130.

#### Scenario: Mid-turn interrupt returns to the prompt

- **WHEN** the user presses Ctrl+C while the agent is mid-turn
- **THEN** the server stops the turn, and the user's message and the streamed partial are persisted to the thread
- **AND** the REPL shows the next prompt in the same process

#### Scenario: At-prompt interrupt exits cleanly

- **WHEN** the user presses Ctrl+C (or EOF) at the idle prompt
- **THEN** the REPL exits through the graceful-shutdown path, and the local server keeps running

#### Scenario: A second interrupt ends the REPL after the turn

- **WHEN** the user presses Ctrl+C a second time while the abort of the turn is in flight
- **THEN** the REPL exits with the code 130 after the turn unwinds
