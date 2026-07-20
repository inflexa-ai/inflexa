# agent-cli-tool Specification

## Purpose

Define the conversation-agent tool that drives the local `inflexa` CLI as a policy-gated subprocess: the single-tool argv contract, the commander-as-oracle classifier that auto-allows introspection and resolves every action's registration-declared policy (the `agent-command-policy` capability), the subcommand-path standing grant, subprocess hygiene, and dev/release invocation resolution. The agent drives `inflexa` the way it drives any command — it discovers the surface through `--help`. Policy is declared per command at registration in three tiers and is the command's floor; explicitly-set flags only escalate, and within the `approval` tier the in-chat approval prompt remains the security boundary.

## Requirements

### Requirement: The agent drives the inflexa CLI through one subprocess tool

The system SHALL provide exactly one conversation-agent tool (`run_inflexa`) that takes an argv array, runs the `inflexa` CLI as a subprocess, and returns the exit code and captured stdout/stderr to the model. The tool SHALL NOT be a family of per-command tools. Per-command availability SHALL derive solely from the registration-declared agent policy (the `agent-command-policy` capability): the declared policy is a command's floor, explicitly-set options can only escalate an invocation toward approval — never de-escalate it — and within the `approval` tier the in-chat approval prompt remains the security boundary. The surface the agent learns is the CLI's own, discovered through `--help`. Input SHALL be an argv `string[]` passed to the subprocess as an argv array (no shell); a single-element input that contains whitespace SHALL be tokenized shell-style into argv before use, so a model that emits one string still runs safely. Tokenization SHALL happen exactly once — the argv the classifier verdicts on is the same argv displayed for approval and spawned, so the two can never diverge.

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

### Requirement: Interactive TUI-launcher commands are blocked from the agent

The commands that exist only to open an interactive terminal UI — bare `inflexa`, `inflexa config`, `inflexa new`, `inflexa resume`, and the dev-channel `inflexa chat` — cannot function as a captured subprocess: with `stdin` ignored and `stdout`/`stderr` piped, there is no terminal to drive. Each SHALL be registered with a `blocked` agent policy whose reason explains this to the model, and the tool SHALL refuse such a command outright — a blocked result WITHOUT prompting for approval and WITHOUT spawning. A blocked command's introspection (its `--help`) SHALL remain allowed, since it runs no UI.

The policy declaration is the courtesy layer, not the safety boundary: every TUI launcher SHALL itself refuse a non-interactive stdin at entry, before doing any other work — so a TUI command misdeclared or unclassified exits non-zero with a clear message instead of hanging, and a launcher that creates state before its first frame (`inflexa new` creates the analysis during target resolution) refuses before any state exists.

#### Scenario: Bare inflexa is refused

- **WHEN** the tool is invoked with an empty argv (bare `inflexa`, which opens the TUI)
- **THEN** it returns a blocked result to the model without prompting and without spawning

#### Scenario: inflexa config is refused

- **WHEN** the tool is invoked with `["config"]` (which opens the interactive settings UI)
- **THEN** it returns a blocked result to the model without prompting and without spawning

#### Scenario: inflexa new is refused before it can create an analysis

- **WHEN** the tool is invoked with `["new", "myanalysis"]` (which creates an analysis and opens its chat TUI)
- **THEN** it returns a blocked result to the model without prompting and without spawning

#### Scenario: inflexa resume is refused

- **WHEN** the tool is invoked with `["resume", "some-analysis"]` (which reopens an analysis's chat TUI)
- **THEN** it returns a blocked result to the model without prompting and without spawning

#### Scenario: A blocked command's help is still allowed

- **WHEN** the tool is invoked with `["config", "--help"]`
- **THEN** it classifies as introspection and runs, returning the help text without prompting

#### Scenario: A TUI launcher invoked headless fails fast instead of hanging

- **WHEN** a TUI-launching command runs with a non-interactive stdin (a pipe, a script, or a captured subprocess)
- **THEN** the launcher exits non-zero with a clear message before creating any state or rendering any frame

### Requirement: Infrastructure lifecycle commands are blocked from the agent

The commands that manage the infrastructure containers the running conversation itself depends on — `inflexa up`, `inflexa down`, and `inflexa setup` — SHALL be registered with a `blocked` agent policy and refused outright: a blocked result to the model, WITHOUT prompting for approval and WITHOUT spawning. `inflexa down` stops the Postgres the harness session is connected to, so even an informed approval could sever the session mid-turn; `up` and `setup` mutate or re-provision the same stack. These commands run fine headless, so for this family the declared policy IS the gate — and the registration helper makes an undeclared lifecycle command unrepresentable: a new command cannot be registered without a policy at all. Their introspection (`--help`) SHALL remain allowed, since it touches nothing.

#### Scenario: inflexa down is refused

- **WHEN** the tool is invoked with `["down"]` (which stops the containers, including the session's own database)
- **THEN** it returns a blocked result to the model without prompting and without spawning

#### Scenario: inflexa up and setup are refused

- **WHEN** the tool is invoked with `["up"]` or `["setup"]`
- **THEN** it returns a blocked result to the model without prompting and without spawning

#### Scenario: A standing grant cannot resurrect a blocked command

- **GIVEN** an analysis holding an `always` grant whose grant key matches a command that is now registered `blocked`
- **WHEN** the tool is invoked with that command
- **THEN** it returns a blocked result — the policy check runs before the grant lookup, so a stale grant never overrides a block

### Requirement: Auto-classified invocations run without approval

For a command registered with the `auto` policy, the tool SHALL spawn immediately — no approval prompt and no grant lookup — if and only if every explicitly-set option of the invocation is in the policy's `safeFlags`. Any other invocation of the same command SHALL follow the full `approval` flow (`ctx.ask`, grantable per analysis): an out-of-set flag escalates, and nothing de-escalates. Positional operands SHALL NOT affect the auto decision — an `auto` declaration asserts read-only behavior over the command's entire positional domain, so only explicitly-set options are measured against `safeFlags`. An `auto` run's audit posture SHALL equal introspection's — it records no ask-ledger row (the tool result in thread history is its record); this is deliberate, as `auto` is a curated extension of the introspection tier. Introspection classification itself is unaffected by policy: help and version run free for every command, including blocked ones.

#### Scenario: A safe-flagged invocation runs free

- **GIVEN** `refs list` registered as `auto` with safeFlags covering `urls` and `json`
- **WHEN** the tool is invoked with `["refs", "list", "--json"]`
- **THEN** it spawns without prompting and returns the captured output

#### Scenario: An out-of-set flag escalates to approval

- **GIVEN** an `auto` command with a newly added option not present in its safeFlags
- **WHEN** the tool is invoked with that option explicitly set
- **THEN** it raises an approval request through the standard approval flow instead of running free

#### Scenario: A defaulted option does not escalate

- **GIVEN** an `auto` command with an option that has a default value and is absent from safeFlags
- **WHEN** the tool is invoked without mentioning that option
- **THEN** the invocation runs free — only explicitly-set options are measured against safeFlags

#### Scenario: Positional operands do not escalate

- **GIVEN** `refs verify` registered as `auto` with safeFlags covering `json`
- **WHEN** the tool is invoked with `["refs", "verify", "reactome-pathways", "--json"]`
- **THEN** the invocation runs free — the positional dataset id plays no part in the auto decision

### Requirement: Classification is the commander parse, not a string heuristic

The tool SHALL classify an argv by parsing it against the real commander program tree in-process — built through the `buildProgram()` factory, with a `preAction` hook that fires a classification sentinel the instant an action would run, `exitOverride` set, and help/version output silenced — never by a string match on the argv. Classification SHALL yield exactly one of: introspection (a help/version parse outcome) → auto-allow; a resolved action (the sentinel fires) → the action verdict, carrying the resolved subcommand path, the registration-declared agent policy read from the resolved `Command` instance, and the canonical attribute names of the options explicitly set by the invocation (option-value source, not argv string matching — short forms, `--opt=val`, and negations collapse to one canonical name, and a defaulted option is not "set"); or a parse error (unknown command/option, missing/excess argument) → returned to the model as a tool result WITHOUT spawning and WITHOUT prompting. Because the decision is commander's own parse, an argv that places `--help` after a `--` terminator SHALL classify as an action, not introspection.

#### Scenario: A masked help flag is gated, not auto-allowed

- **WHEN** the tool is invoked with `["refs", "download", "reactome-pathways", "--", "--help"]`
- **THEN** classification resolves it to the `refs download` action (the post-terminator `--help` is an operand) and it requires approval

#### Scenario: A malformed argv is returned to the model, not spawned

- **WHEN** the tool is invoked with an argv commander cannot resolve (an unknown command or option)
- **THEN** the tool returns a parse error to the model without spawning the CLI and without raising an approval

#### Scenario: Explicitly-set options are derived from the parse

- **WHEN** an option is passed in short form or as `--opt=value`
- **THEN** the action verdict reports the same canonical option name as the long form, and an option that was merely defaulted is not reported as set

### Requirement: An unclassified action fails closed

If an action verdict carries no registration-declared policy — reachable only by bypassing every static enforcement layer — the tool SHALL return a blocked result stating the command is not classified for agent use, WITHOUT prompting and WITHOUT spawning. Drift fails closed: a command can be needlessly blocked by a gap, never silently approvable.

#### Scenario: A policy-less action is blocked, not prompted

- **WHEN** the tool resolves an action whose `Command` carries no stamped policy
- **THEN** it returns a blocked result to the model without raising an approval and without spawning

### Requirement: The standing grant keys on the resolved subcommand path

The approval request SHALL display the exact argv as its `command` (an element carrying whitespace rendered quoted, so the word boundaries the user reads are the word boundaries that spawn), and SHALL set the harness `grantKey` to the resolved subcommand path only (the command names, with no argument or option values) — for example `inflexa refs download`. An `always` reply SHALL therefore auto-approve later invocations that resolve to the same subcommand path in the same analysis, without re-prompting for a different argument. The prompt SHALL make the granted subcommand-path class visible so an `always` is an informed decision.

#### Scenario: Approving one dataset covers the next on the same subcommand

- **GIVEN** an analysis where `["refs","download","reactome-pathways","--yes"]` was approved with `always`
- **WHEN** the tool is later invoked with `["refs","download","wikipathways-human","--yes"]` in that analysis
- **THEN** it spawns without a new approval prompt

#### Scenario: The prompt shows the exact command

- **WHEN** an approval is raised for an action argv
- **THEN** the displayed command is the exact argv being run, while the standing-grant class is the resolved subcommand path

### Requirement: Subprocess hygiene keeps the CLI a captured black box

The tool SHALL spawn the CLI with an argv array (never through a shell), `stdin` ignored, and `stdout`/`stderr` captured rather than inherited, so subprocess output never reaches the TUI alternate screen. The spawn SHALL be bounded by a timeout that terminates a child that does not exit, escalating to an untrappable kill after a grace so a child that traps the first signal cannot outlive the deadline. Captured output SHALL be bounded at capture time by one budget shared across stdout and stderr (the bound is per run — what the turn's context pays for — not per stream) — the streams are drained past the cap but not retained — so a runaway child can neither overflow the turn nor balloon the host process's memory, and neither pipe backpressure nor a grandchild holding the pipes open past the child's exit stalls the tool. A timeout result SHALL carry the (bounded) output produced before the deadline. A run ended by the turn's own abort SHALL be reported as cancelled — distinct from both a timeout and a completed run.

#### Scenario: An interactive command declines rather than hangs

- **WHEN** the tool spawns a command whose interactive path is gated on a TTY (e.g. `refs download` without `--yes`)
- **THEN** the ignored `stdin` makes the subprocess non-interactive so it declines instead of waiting for input

#### Scenario: A hung child is terminated

- **WHEN** a spawned child does not exit within the timeout — even one that traps the termination signal
- **THEN** the tool kills it and returns a timeout result carrying the output captured before the deadline

#### Scenario: A grandchild cannot stall the capture

- **WHEN** the spawned child exits but a process it spawned still holds the inherited pipes open
- **THEN** the tool returns shortly after the child's exit with the output captured so far, rather than waiting for the grandchild

#### Scenario: A cancelled turn is not reported as a completed run

- **WHEN** the turn's abort signal fires while the child is running
- **THEN** the child is terminated and the tool reports a cancelled result, not an exit code or a timeout

### Requirement: Invocation resolves dev vs release from the build channel

The tool SHALL resolve how it invokes the CLI from the baked build channel (`env.isDevelopment`): a development run SHALL invoke the CLI source entry through the `bun` runtime with the argv; a release binary SHALL invoke itself via `process.execPath` with the argv. There SHALL be one binary — the classifier and the real dispatch build the same program tree.

#### Scenario: Development run shells through bun

- **WHEN** the tool runs under a development build
- **THEN** it invokes the CLI via the bun entry point with the argv

#### Scenario: Release binary invokes itself

- **WHEN** the tool runs under a release binary
- **THEN** it invokes the compiled binary at `process.execPath` with the argv
