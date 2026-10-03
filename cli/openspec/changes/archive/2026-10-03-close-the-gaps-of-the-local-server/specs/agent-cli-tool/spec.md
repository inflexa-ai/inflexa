## MODIFIED Requirements

### Requirement: Interactive TUI-launcher commands are blocked from the agent

Some commands exist only to open an interactive terminal UI: bare `inflexa`, `inflexa config`, `inflexa new`, `inflexa resume`, and the dev-channel `inflexa chat`. Such a command cannot work as a captured subprocess, because its `stdin` is ignored and its output is piped. Each MUST have a `blocked` agent policy whose reason tells the model why. The tool MUST refuse such a command with a blocked result, with no approval prompt and no spawn. The introspection of a blocked command (its `--help`) MUST stay permitted, because it runs no UI.

The policy is the courtesy layer, not the safety boundary. Each TUI launcher MUST itself refuse a stdin that is not interactive. The refusal comes before it resolves a target, makes any state of an analysis, or renders a frame. Thus a misdeclared launcher exits non-zero with a clear message and does not hang. `inflexa new` makes the analysis during the resolution of its target, thus it refuses before any state exists.

The launchers bare `inflexa`, `inflexa config`, `inflexa new`, and `inflexa resume` are `instance` commands. Each MUST refuse a stdin that is not interactive before the check of the local server. That check can start a server in the background, and a refused launch MUST NOT leave a server behind. The dev `inflexa chat` refuses at the start of its action, after the check.

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

#### Scenario: A headless launch starts no server

- **GIVEN** no local server runs
- **WHEN** `inflexa new demo` runs with a stdin that is not interactive
- **THEN** the command exits non-zero with the terminal message, and no server starts
