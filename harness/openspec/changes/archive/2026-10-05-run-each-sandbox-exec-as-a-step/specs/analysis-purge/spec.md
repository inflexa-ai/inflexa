## MODIFIED Requirements

### Requirement: Purge names what it does not reach

`purgeAnalysis` MUST NOT remove state that it cannot attribute to an analysis.
Its contract MUST state those exclusions, thus nobody mistakes an absent
coverage for a delivered coverage. It MUST NOT touch these items:

- the scheduled operational workflows (the sandbox reaper and the notification
  sweep). They belong to no analysis, and they accumulate independently of each
  purge.
- the `messages` rows whose thread row is gone already. They carry no analysis
  attribution, and by construction nothing can reach them.
- the shared regulatory corpus.
- the workspace files on disk. The embedder owns their disposal.

#### Scenario: Scheduled workflows survive a purge

- **GIVEN** scheduled operational workflows in the ledger alongside an analysis's workflows
- **WHEN** `purgeAnalysis` completes for that analysis
- **THEN** the scheduled workflows' rows remain

#### Scenario: Another entity's state survives a purge

- **GIVEN** a second analysis
- **WHEN** one analysis is purged
- **THEN** the second analysis retains every row

#### Scenario: Workspace files are untouched

- **GIVEN** an analysis with files in its workspace tree
- **WHEN** `purgeAnalysis` completes
- **THEN** the files on disk are unchanged and the host remains responsible for their disposal
