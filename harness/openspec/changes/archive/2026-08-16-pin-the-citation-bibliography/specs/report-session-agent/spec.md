# Delta: report-session-agent

## MODIFIED Requirements

### Requirement: The read-only roster

The listing MUST give each pinned citation as its key with the short citation beside it, when the pinned record carries one. Thus the agent reads which id is which paper, and it composes a citation block with no guess. A key with no record lists bare, because absence is a normal condition.

#### Scenario: The listing names the paper beside the key

- **WHEN** the agent calls the listing tool in a session whose pin records `Hugo et al. 2016` under `pmid:26997480`
- **THEN** the listed citation carries the key and the short citation
