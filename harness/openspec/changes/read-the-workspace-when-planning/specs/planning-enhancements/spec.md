# Spec Delta

## ADDED Requirements

### Requirement: The planner reads the workspace and writes nothing

The planner MUST declare the read tools of the workspace after its search tools: `read_file`, `list_files`, `file_stat`, `grep`, `workspace_search` when an embedding provider is bound, and `inspect_data_profile`. `read_table` and `read_pdf` MUST be script tools of `run_script`. The planner MUST hold no tool that writes. A paper or a protocol that the user staged can decide the steps of a plan.

#### Scenario: The planner holds the read tools

- **WHEN** the tools of the planner are resolved
- **THEN** they hold `read_file` and `inspect_data_profile`, and no `write_file`
- **AND** the script tools are `read_table` and `read_pdf`
