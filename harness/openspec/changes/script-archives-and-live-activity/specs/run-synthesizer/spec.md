## MODIFIED Requirements

### Requirement: The synthesizer declares its terminal tools, its lookups, and the read tool

The synthesizer MUST declare `submit_synthesis` and `report_blocker`, then `read_tool_output` when the composition has a tool output store. Its lookups MUST be script tools of `run_script`. The synthesizer MUST use the tool output store of the run. It MUST hold no tool that runs a sub-agent.

#### Scenario: The declared tools with a store

- **GIVEN** a synthesizer with a tool output store, no embedding provider, and the lookup `pubmed`
- **WHEN** its first request is sent
- **THEN** the request declares `read_file`, `list_files`, `file_stat`, `grep`, `inspect_data_profile`, `submit_synthesis`, `report_blocker`, `read_tool_output`, and `run_script`, in that order
- **AND** the script tools are `pubmed`, `read_table`, `read_pdf`, and `list_archive`

#### Scenario: The synthesizer reads a long lookup result again

- **GIVEN** a PubMed result of 40,000 characters that the loop of the synthesizer cut
- **WHEN** the synthesizer calls `read_tool_output` with the reference of the excerpt
- **THEN** the call gives a page of the result

### Requirement: The synthesizer reads the workspace and writes nothing

The synthesizer MUST declare the read tools of the workspace before its terminal tools: `read_file`, `list_files`, `file_stat`, `grep`, `workspace_search` when an embedding provider is bound, and `inspect_data_profile`. `read_table`, `read_pdf`, and `list_archive` MUST be script tools. The synthesizer MUST hold no tool that writes. A step summary can omit a fact that a file of the run holds.

#### Scenario: No write tool

- **WHEN** the tools of the synthesizer are resolved
- **THEN** they hold `read_file` and no `write_file` or `edit_file`
