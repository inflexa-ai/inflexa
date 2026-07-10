# cli-core Delta

## MODIFIED Requirements

### Requirement: inflexa open opens the output directory

The system SHALL register `inflexa open <id|name>` (`runOpen` in `src/modules/analysis/open.ts`) that resolves the analysis, ensures its workspace root exists, prints the path, and opens it with the platform opener (`open`/`xdg-open`/`start`). The revealed directory is the analysis's single tree — staged inputs, run artifacts, reports, and provenance exports — not a provenance-only side location.

Every surface that opens the workspace — the `inflexa open` command and the TUI palette's equivalent — SHALL print a `workspace_unavailable` error's `message` verbatim. That message already names the folder, the reason, and the remedy; reducing it to its `type` tells the user nothing they can act on.

#### Scenario: Open the workspace root

- **WHEN** `inflexa open <ref>` runs for an existing analysis
- **THEN** its workspace root is created if needed, the path is printed, and the OS opener is invoked

#### Scenario: Run artifacts are inside the opened directory

- **GIVEN** an analysis with a completed run
- **WHEN** `inflexa open <ref>` runs
- **THEN** the opened directory contains that run's artifacts under `runs/<runId>/…`

#### Scenario: An unusable workspace explains itself on every surface

- **GIVEN** an analysis whose anchor folder is missing or not writable
- **WHEN** the workspace is opened from the CLI or from the TUI command palette
- **THEN** the printed error names the folder and the remedy, not just an error type
