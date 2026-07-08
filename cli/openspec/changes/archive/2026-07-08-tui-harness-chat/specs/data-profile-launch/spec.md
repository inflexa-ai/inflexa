# data-profile-launch — Delta

## MODIFIED Requirements

### Requirement: Data-profile launch is a deliberate action

The system SHALL provide a dedicated text command that runs a data profile for a resolved analysis.
Staging files, booting the harness runtime, and triggering workflows SHALL happen only on deliberate
actions: this command, the run/chat commands, and opening an analysis chat in the TUI — which
auto-triggers the profile at managed parity when the analysis has resolvable inputs and no completed
or running profile (see `tui-harness-chat`). Flows that resolve to no analysis chat — bare `inflexa`
resolving to nothing, the welcome screen, `--status` views, `inflexa ls`/`status` — SHALL remain
free of staging writes and runtime boots.

#### Scenario: No-analysis flows stay side-effect free

- **WHEN** the user runs bare `inflexa` and it resolves to no analysis (welcome/no-op path)
- **THEN** no session tree is created, no files are staged, and DBOS is not launched

#### Scenario: The command performs the run

- **WHEN** the user invokes the profile command for an analysis with staged-able inputs
- **THEN** inputs are staged, the runtime is booted (if needed), and the data-profile workflow is triggered

#### Scenario: Opening an analysis chat is a deliberate profile trigger

- **WHEN** the TUI opens an analysis chat for an analysis with inputs and no completed or running profile
- **THEN** the same stage → seed → trigger sequence runs (non-blocking), per `tui-harness-chat`
