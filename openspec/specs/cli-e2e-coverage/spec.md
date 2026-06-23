# cli-e2e-coverage Specification

## Purpose
TBD - created by archiving change add-test-suite. Update Purpose after archive.
## Requirements
### Requirement: Read-only commands are tested end-to-end
The suite SHALL verify the read-only commands (`inf ls`, `inf status`, `inf sessions`,
`inf project ls`) via subprocess against a seeded temp DB: each exits 0 and prints the seeded
entities to stdout.

#### Scenario: ls lists seeded analyses
- **WHEN** the temp DB is seeded with analyses and `inf ls` runs as a subprocess
- **THEN** the process exits 0 and stdout contains the seeded analyses

#### Scenario: project ls lists seeded projects with counts
- **WHEN** the temp DB is seeded with projects and `inf project ls` runs
- **THEN** the process exits 0 and stdout lists each project

### Requirement: Write commands are tested end-to-end
The suite SHALL verify `inf project new <name>` via subprocess: a fresh name creates a persisted
row (read back from the DB), and a duplicate name exits non-zero with a useful error.

#### Scenario: new project persists
- **WHEN** `inf project new "Acme"` runs against an empty temp DB
- **THEN** it exits 0 and a `projects` row named "Acme" exists in the DB

#### Scenario: duplicate name fails
- **WHEN** `inf project new "Acme"` runs a second time
- **THEN** it exits non-zero and stderr explains the name is taken

### Requirement: Anchor backstop commands are tested end-to-end
The suite SHALL verify `inf repair [path]` via subprocess against a temp marker: a valid marker is
reconciled and the cached path updated.

#### Scenario: repair reconciles a moved marker
- **WHEN** a marker exists at a temp path and `inf repair <path>` runs
- **THEN** it exits 0 and reports the reconciled anchor

### Requirement: The no-litter guarantee is tested
The suite SHALL verify that passive/aborted flows write nothing: invoking a command that resolves
context but takes no deliberate action leaves the temp data/config dirs free of newly-created
marker/DB litter beyond what the command explicitly creates.

#### Scenario: passive resolution writes no marker
- **WHEN** a read-only command runs in a directory with no marker
- **THEN** no anchor marker file is created in that directory

### Requirement: Help and usage surfaces are tested
The suite SHALL verify `inf --help` exits 0 and lists the registered commands, and an unknown
command exits non-zero.

#### Scenario: help lists commands
- **WHEN** `inf --help` runs as a subprocess
- **THEN** it exits 0 and stdout includes the top-level command names

#### Scenario: unknown command errors
- **WHEN** `inf bogus-command` runs
- **THEN** it exits non-zero

