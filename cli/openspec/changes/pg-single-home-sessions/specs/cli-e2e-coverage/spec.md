## MODIFIED Requirements

### Requirement: Read-only commands are tested end-to-end

The suite SHALL verify the read-only commands (`inflexa ls`, `inflexa status`,
`inflexa project ls`) via subprocess against a seeded temp DB: each exits 0 and prints the seeded
entities to stdout.

#### Scenario: ls lists seeded analyses

- **WHEN** the temp DB is seeded with analyses and `inflexa ls` runs as a subprocess
- **THEN** the process exits 0 and stdout contains the seeded analyses

#### Scenario: project ls lists seeded projects with counts

- **WHEN** the temp DB is seeded with projects and `inflexa project ls` runs
- **THEN** the process exits 0 and stdout lists each project
