# chat-command — Delta

## RENAMED Requirements

- FROM: `### Requirement: Chat is a deliberate, temporary walking-skeleton surface`
- TO: `### Requirement: Chat is a dev-channel harness REPL`

## MODIFIED Requirements

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
