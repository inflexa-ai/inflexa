# launch-dir-listing Specification

## Purpose

Define the read-only, CLI-injected conversation-agent tool that enumerates candidate input files in an analysis's anchor/launch folder — the folder the user launched `inflexa` in. It reuses the staging walk's noise-directory rules and marks which files are already registered inputs, so the agent can surface files that exist on disk but are not yet staged, without the harness learning anything host-specific.

## Requirements

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

### Requirement: list_launch_dir explicitly declines a call detail

`list_launch_dir` SHALL declare `describeCall: "none"`. Its input schema is empty — the folder it lists is resolved from the analysis's anchor inside `execute`, not supplied by the caller — so every call is identical and no detail can distinguish one from another.

The declaration SHALL be explicit rather than an omission. Under the harness's tool-definition contract a tool must make the decision, and an explicit decline records that this tool's calls are genuinely indistinguishable, rather than leaving a reader to wonder whether the hook was forgotten.

The tool SHALL NOT declare a constant detail naming the launch folder or restating its own purpose. The surface rendering a call already prints the tool's name, so a constant would add a second copy of it and imply a variation that does not exist.

#### Scenario: The tool declares the decline and packages no hook

- **GIVEN** the `list_launch_dir` tool definition
- **WHEN** the tool is constructed
- **THEN** construction succeeds and the packaged tool exposes no `describeCall`

#### Scenario: Its calls render exactly as they do without a hook

- **GIVEN** a `list_launch_dir` call
- **WHEN** its tool-call events are emitted
- **THEN** they carry no detail, and the call renders as the tool name alone
