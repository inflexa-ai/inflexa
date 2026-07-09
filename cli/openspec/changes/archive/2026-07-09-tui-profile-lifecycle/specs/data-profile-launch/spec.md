# data-profile-launch Delta

## MODIFIED Requirements

### Requirement: Data-profile launch is a deliberate action

The system SHALL provide a dedicated text command that runs a data profile for a resolved analysis.
Staging files, booting the harness runtime, and triggering workflows SHALL happen only on deliberate
actions: this command, the run/chat commands, opening an analysis chat in the TUI, mutating an
analysis's inputs while the TUI's runtime is ready, and the TUI's manual re-profile action — the TUI
edges keep the profile at managed parity with the current input set (drift re-trigger, clear on an
emptied set; see `tui-harness-chat`). Parity *checks* on these edges SHALL be read-only (the
identity-only enumeration per `input-staging`); staging writes happen only when a (re-)trigger
actually fires. Flows that resolve to no analysis chat — bare `inflexa` resolving to nothing, the
welcome screen, `--status` views, `inflexa ls`/`status` — SHALL remain free of staging writes and
runtime boots.

#### Scenario: No-analysis flows stay side-effect free

- **WHEN** the user runs bare `inflexa` and it resolves to no analysis (welcome/no-op path)
- **THEN** no session tree is created, no files are staged, and DBOS is not launched

#### Scenario: Opening an analysis chat is a deliberate profile trigger

- **WHEN** the TUI opens an analysis chat for an analysis whose profile is missing or drifted from the current input set
- **THEN** the same stage → seed → trigger sequence runs (non-blocking), per `tui-harness-chat`

#### Scenario: A no-drift check stages nothing

- **WHEN** a parity edge fires for an analysis whose completed profile matches the current input set
- **THEN** no staging write occurs and no workflow is triggered

#### Scenario: The command performs the run

- **WHEN** the user invokes the profile command for an analysis with staged-able inputs
- **THEN** inputs are staged, the runtime is booted (if needed), and the data-profile workflow is triggered
