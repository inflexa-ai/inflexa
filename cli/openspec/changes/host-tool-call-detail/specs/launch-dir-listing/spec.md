## ADDED Requirements

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
