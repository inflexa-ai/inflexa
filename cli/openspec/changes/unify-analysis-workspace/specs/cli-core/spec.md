# cli-core Delta

## MODIFIED Requirements

### Requirement: inflexa new creates and opens an analysis

The system SHALL register `inflexa new [name] [paths...] [--project <p>]` that resolves `--project` by id or name, validates/prompts the name as a `Str256`, calls `createAnalysis` with cwd, name, input paths, and project, prints the resolved workspace root, then opens chat. There SHALL be no `--output` flag — the workspace location is the anchor-derived rule, not a setting. The action lives in `src/tui/app.launch.tsx` as `launchNew`.

#### Scenario: Create with name and inputs

- **WHEN** `inflexa new "Batch 42" ./data` runs
- **THEN** an analysis is created with those inputs, its workspace root path is printed, and chat opens

#### Scenario: Missing name is prompted

- **WHEN** `inflexa new` runs with no name
- **THEN** it prompts for a name, re-asking until a valid `Str256` is given, before creating the analysis

#### Scenario: Non-writable folder is refused with an actionable message

- **WHEN** `inflexa new` runs in a folder the process cannot write to
- **THEN** the command exits with the creation error's actionable message and no analysis exists

### Requirement: inflexa open opens the output directory

The system SHALL register `inflexa open <id|name>` (`runOpen` in `src/modules/analysis/open.ts`) that resolves the analysis, ensures its workspace root exists, prints the path, and opens it with the platform opener (`open`/`xdg-open`/`start`). The revealed directory is the analysis's single tree — staged inputs, run artifacts, reports, and provenance exports — not a provenance-only side location.

#### Scenario: Open the workspace root

- **WHEN** `inflexa open <ref>` runs for an existing analysis
- **THEN** its workspace root is created if needed, the path is printed, and the OS opener is invoked

#### Scenario: Run artifacts are inside the opened directory

- **GIVEN** an analysis with a completed run
- **WHEN** `inflexa open <ref>` runs
- **THEN** the opened directory contains that run's artifacts under `runs/<runId>/…`

#### Scenario: Unresolvable workspace is an actionable error

- **WHEN** the analysis's anchor cannot be resolved or is not writable
- **THEN** the command exits with the resolution error's actionable message instead of opening another location
