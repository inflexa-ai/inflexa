## ADDED Requirements

### Requirement: list_launch_dir declares that it shows no value

`list_launch_dir` MUST declare `view: "none"`. Thus no call of the tool shows an input, a result, or an error value. A refused call still shows the refusal text, because the call policy writes that text for each tool.

The declaration MUST be explicit, as the `describeCall` decision is. The tool-definition contract of the harness makes the decision required, and an explicit `"none"` records that the tool shows nothing.

#### Scenario: The tool declares none and packages no view

- **GIVEN** the `list_launch_dir` tool definition
- **WHEN** the tool is constructed
- **THEN** construction succeeds, and the packaged tool has no `view` key
