# chat-command — Delta

## MODIFIED Requirements

### Requirement: Chat is a deliberate, temporary walking-skeleton surface

The system SHALL provide a dedicated `inflexa chat <analysis>` command — a clack/stdout REPL, not a
TUI surface — that converses with the harness conversation agent scoped to a resolved analysis. The
command module SHALL carry a `TODO(extend)` comment block stating its clearing contract: its product
replacement is the TUI chat (capability `tui-harness-chat`, landed by change `tui-harness-chat`);
the command remains a dev/E2E surface for exercising the harness loop without a TUI, to be gated
under a dev umbrella (excluded from production builds) by the follow-up demotion change, at which
point this capability records that status. No passive flow SHALL boot the runtime or start a chat —
deliberate boot actions are this command, the profile/run commands, and opening an analysis chat in
the TUI (see `tui-harness-chat`). The command SHALL run the same pre-flight prerequisite gates as
the run/profile launches before booting, and SHALL acquire the per-analysis instance lock after
resolution and before boot.

#### Scenario: The dev surface is marked in code

- **WHEN** the chat command module is inspected
- **THEN** it carries a `TODO(extend)` block naming the TUI chat as the product replacement and the dev-umbrella demotion as its pending disposition

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
