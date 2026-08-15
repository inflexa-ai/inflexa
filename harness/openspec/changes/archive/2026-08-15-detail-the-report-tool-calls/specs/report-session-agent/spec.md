# Delta: report-session-agent

## ADDED Requirements

### Requirement: The session tools name their calls
The report tools MUST give a call detail that names their subject. `add_block` names the kind, with the title of a section or the file name of a bound artifact. `change_block`, `move_block`, and `remove_block` name the block id. On an ok outcome, `preview_report` names the page path, and `record_report_version` names the version. `examine_page` names the look outcome, and the listing tool names the listed count with the truncation.

#### Scenario: An added section names its title
- **WHEN** the agent adds a section block titled "Summary"
- **THEN** the call line reads the kind and the title

#### Scenario: An added table names its file
- **WHEN** the agent adds a table block bound to a workspace path
- **THEN** the call line reads the kind and the file name of the path

#### Scenario: The preview names the page
- **WHEN** the preview renders the page
- **THEN** the finished line names the page path
