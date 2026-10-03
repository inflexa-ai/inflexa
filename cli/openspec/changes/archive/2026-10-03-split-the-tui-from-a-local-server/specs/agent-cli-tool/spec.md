## ADDED Requirements

### Requirement: The commands of the local server process are blocked or gated for the agent

The conversation of the agent runs inside the local server, thus a command that starts or stops that server acts on the process of the agent itself. `inflexa serve` and `inflexa server stop` SHALL be registered `blocked`, and the tool SHALL refuse each one outright: a blocked result to the model, WITHOUT prompting for approval and WITHOUT spawning. The reason of `server stop` SHALL tell the model that the stop ends its own turn, and that the user runs it from their own shell. `inflexa server status` SHALL be `auto`, with `json` as its one safe flag, because it reads the discovery file, probes the server, and writes nothing. `inflexa server logs` SHALL be `approval`. The introspection of each (`--help`) SHALL remain allowed.

#### Scenario: inflexa server stop is refused

- **WHEN** the tool is invoked with `["server", "stop"]`
- **THEN** it returns a blocked result to the model without prompting and without spawning

#### Scenario: inflexa serve is refused

- **WHEN** the tool is invoked with `["serve", "--detach"]`
- **THEN** it returns a blocked result to the model without prompting and without spawning

#### Scenario: The server status runs free

- **WHEN** the tool is invoked with `["server", "status", "--json"]`
- **THEN** it spawns without prompting and returns the captured output

## MODIFIED Requirements

### Requirement: Interactive TUI-launcher commands are blocked from the agent

The commands that exist only to open an interactive terminal UI — bare `inflexa`, `inflexa config`, `inflexa new`, `inflexa resume`, and the dev-channel `inflexa chat` — cannot function as a captured subprocess: with `stdin` ignored and `stdout`/`stderr` piped, there is no terminal to drive. Each SHALL be registered with a `blocked` agent policy whose reason explains this to the model, and the tool SHALL refuse such a command outright — a blocked result WITHOUT prompting for approval and WITHOUT spawning. A blocked command's introspection (its `--help`) SHALL remain allowed, since it runs no UI.

The policy declaration is the courtesy layer, not the safety boundary: every TUI launcher SHALL itself refuse a non-interactive stdin at the start of its action, before it resolves a target, creates any state of an analysis, or renders a frame — so a TUI command misdeclared or unclassified exits non-zero with a clear message instead of hanging, and a launcher that creates state before its first frame (`inflexa new` creates the analysis during target resolution) refuses before any state exists. Each TUI launcher is an `instance` command, thus the connection to the local server, which can start a server in the background, comes before that refusal.

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
- **THEN** the launcher exits non-zero with a clear message before it resolves a target, creates any state of an analysis, or renders any frame
