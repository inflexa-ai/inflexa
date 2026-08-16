# Delta: report-verification

## MODIFIED Requirements

### Requirement: The gate runs before the store

The record MUST prune the output file of each derivation that the recorded document does not reference, after the version lands. The prune reaches only a path under the session `derived/` directory. The records stay append-only, because the bytes are reproducible from the script and the sources. A failed removal logs, and it changes no outcome.

#### Scenario: The record prunes the unused outputs

- **WHEN** the record lands a version whose document names one of two derivation outputs
- **THEN** the unused output file goes, the used one stays, and both records stay

#### Scenario: A failed prune keeps the version

- **WHEN** the removal of an unused output throws
- **THEN** the version stands, and the log names the failed removal
