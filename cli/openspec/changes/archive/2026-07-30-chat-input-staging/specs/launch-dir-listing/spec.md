## ADDED Requirements

### Requirement: List candidate input files in the analysis's launch folder

The system SHALL provide a read-only conversation-agent tool, injected by the CLI into the harness through the existing `hostTools` seam (alongside `run_inflexa`), that enumerates candidate input files under the analysis's resolved anchor/launch folder — the directory the user launched `inflexa` in. For each file it SHALL return the path relative to the anchor and the file size. It SHALL reuse the staging walk's noise-directory exclusions, so `.git`, `.inflexa`, `node_modules`, `__pycache__`, and the other ignored names are never enumerated. The tool SHALL be read-only: it SHALL create, modify, or delete nothing and SHALL register no inputs.

The tool SHALL indicate, per returned file, whether it is already a registered input of the analysis, so the agent can distinguish files that still need adding from files already staged and avoid re-offering them.

#### Scenario: Lists data files under the anchor folder

- **WHEN** the agent invokes the tool for an analysis anchored at a folder containing data files
- **THEN** the tool returns those files with their anchor-relative paths and sizes

#### Scenario: Noise directories are never enumerated

- **GIVEN** an anchor folder containing `.git/`, `.inflexa/`, and `node_modules/` alongside data files
- **WHEN** the tool runs
- **THEN** only the data files are returned and none of the ignored directories are enumerated

#### Scenario: Unstaged files are surfaced and marked

- **GIVEN** an anchor folder holding a file that is not yet a registered analysis input and another that is
- **WHEN** the tool runs
- **THEN** both files are returned
- **AND** each is marked with whether it is already a registered input

#### Scenario: The tool mutates nothing

- **WHEN** the tool runs for any analysis
- **THEN** no file is created, modified, or deleted and no `analysis_inputs` row is written
