# agent-cli-tool Specification

## Purpose

Define the conversation-agent tool that drives the local `inflexa` CLI as an approval-gated subprocess: the single-tool argv contract, the commander-as-oracle classifier that auto-allows introspection and gates every action, the subcommand-path standing grant, subprocess hygiene, and dev/release invocation resolution. The agent drives `inflexa` the way it drives any command — it discovers the surface through `--help` — and the in-chat approval prompt is the security boundary, not a per-command allowlist.

## Requirements

### Requirement: The agent drives the inflexa CLI through one subprocess tool

The system SHALL provide exactly one conversation-agent tool (`run_inflexa`) that takes an argv array, runs the `inflexa` CLI as a subprocess, and returns the exit code and captured stdout/stderr to the model. The tool SHALL NOT be a family of per-command tools and SHALL NOT encode a per-command allowlist; the surface the agent learns is the CLI's own, discovered through `--help`. Input SHALL be an argv `string[]` passed to the subprocess as an argv array (no shell); a single-element input that contains whitespace SHALL be tokenized shell-style into argv before use, so a model that emits one string still runs safely.

#### Scenario: A command runs and returns its result

- **WHEN** the tool is invoked with an approved argv
- **THEN** it spawns the CLI with that argv and returns the process exit code and captured stdout/stderr to the model

#### Scenario: There is no shell to interpret the argv

- **WHEN** the tool spawns the CLI
- **THEN** it passes the argv as an array with no `sh -c`, so no shell metacharacter in an argument is interpreted

### Requirement: Introspection is auto-allowed; every action is approval-gated

The tool SHALL classify each argv before running it. An argv that classification resolves to help or version output — running no action — SHALL run WITHOUT an approval prompt, so the agent explores the CLI surface freely. Every other argv SHALL raise `ctx.ask`; the tool SHALL spawn only on approval, and a rejection SHALL end the turn through the harness denial path. The approval prompt is the security boundary: there is no separate allowlist deciding which non-introspection commands may run.

#### Scenario: A help invocation runs without a prompt

- **WHEN** the tool is invoked with `["--help"]` or `["refs", "--help"]`
- **THEN** it spawns the CLI and returns the help text with no approval prompt

#### Scenario: An action invocation requires approval

- **WHEN** the tool is invoked with an argv that classification resolves to an action (e.g. `["refs", "download", "reactome-pathways", "--yes"]`)
- **THEN** it raises an approval request and does not spawn until the user approves

#### Scenario: A rejection ends the turn without spawning

- **WHEN** the user rejects the approval
- **THEN** the tool does not spawn the CLI and the turn ends through the harness denial path

### Requirement: Classification is the commander parse, not a string heuristic

The tool SHALL classify an argv by parsing it against the real commander program tree in-process — built through the `buildProgram()` factory, with a `preAction` hook that fires a classification sentinel the instant an action would run, `exitOverride` set, and help/version output silenced — never by a string match on the argv. Classification SHALL yield exactly one of: introspection (a help/version parse outcome) → auto-allow; a resolved action (the sentinel fires) → approval, carrying the resolved subcommand path; or a parse error (unknown command/option, missing/excess argument) → returned to the model as a tool result WITHOUT spawning and WITHOUT prompting. Because the decision is commander's own parse, an argv that places `--help` after a `--` terminator SHALL classify as an action, not introspection.

#### Scenario: A masked help flag is gated, not auto-allowed

- **WHEN** the tool is invoked with `["refs", "download", "reactome-pathways", "--", "--help"]`
- **THEN** classification resolves it to the `refs download` action (the post-terminator `--help` is an operand) and it requires approval

#### Scenario: A malformed argv is returned to the model, not spawned

- **WHEN** the tool is invoked with an argv commander cannot resolve (an unknown command or option)
- **THEN** the tool returns a parse error to the model without spawning the CLI and without raising an approval

### Requirement: The standing grant keys on the resolved subcommand path

The approval request SHALL display the exact argv as its `command`, and SHALL set the harness `grantKey` to the resolved subcommand path only (the command names, with no argument or option values) — for example `inflexa refs download`. An `always` reply SHALL therefore auto-approve later invocations that resolve to the same subcommand path in the same analysis, without re-prompting for a different argument. The prompt SHALL make the granted subcommand-path class visible so an `always` is an informed decision.

#### Scenario: Approving one dataset covers the next on the same subcommand

- **GIVEN** an analysis where `["refs","download","reactome-pathways","--yes"]` was approved with `always`
- **WHEN** the tool is later invoked with `["refs","download","wikipathways-human","--yes"]` in that analysis
- **THEN** it spawns without a new approval prompt

#### Scenario: The prompt shows the exact command

- **WHEN** an approval is raised for an action argv
- **THEN** the displayed command is the exact argv being run, while the standing-grant class is the resolved subcommand path

### Requirement: Subprocess hygiene keeps the CLI a captured black box

The tool SHALL spawn the CLI with an argv array (never through a shell), `stdin` ignored, and `stdout`/`stderr` captured rather than inherited, so subprocess output never reaches the TUI alternate screen. The spawn SHALL be bounded by a timeout that terminates a child that does not exit, so an argv that resolves to an interactive or long-running command cannot wedge the chat turn. Captured output returned to the model SHALL be bounded so a large output does not overflow the turn.

#### Scenario: An interactive command declines rather than hangs

- **WHEN** the tool spawns a command whose interactive path is gated on a TTY (e.g. `refs download` without `--yes`)
- **THEN** the ignored `stdin` makes the subprocess non-interactive so it declines instead of waiting for input

#### Scenario: A hung child is terminated

- **WHEN** a spawned child does not exit within the timeout
- **THEN** the tool terminates it and returns a timeout result to the model

### Requirement: Invocation resolves dev vs release from the build channel

The tool SHALL resolve how it invokes the CLI from the baked build channel (`env.isDevelopment`): a development run SHALL invoke the CLI source entry through the `bun` runtime with the argv; a release binary SHALL invoke itself via `process.execPath` with the argv. There SHALL be one binary — the classifier and the real dispatch build the same program tree.

#### Scenario: Development run shells through bun

- **WHEN** the tool runs under a development build
- **THEN** it invokes the CLI via the bun entry point with the argv

#### Scenario: Release binary invokes itself

- **WHEN** the tool runs under a release binary
- **THEN** it invokes the compiled binary at `process.execPath` with the argv
