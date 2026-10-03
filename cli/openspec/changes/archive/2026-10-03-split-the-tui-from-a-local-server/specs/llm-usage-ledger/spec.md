# llm-usage-ledger Delta

## MODIFIED Requirements

### Requirement: The usage command reports what an analysis consumed

The CLI SHALL provide a read-only `usage` command that reports an analysis's recorded consumption, resolved from the current working context or named by an option. It SHALL report per-quantity sums rather than one combined number, and SHALL break the consumption down by served model and by agent, since "which model spent this" and "which agent spent this" are the questions the capability exists to answer.

The command SHALL be a client of the local server: it reads the local ledger through the usage route of the server, and it starts the server when none answers. That route SHALL read only the local ledger, and SHALL NOT require the harness runtime, its database, or any network service other than the local server. It SHALL declare an `auto` agent policy whose safe-flag allowlist covers its analysis selector.

The command SHALL NOT write. Resolving which analysis to report on SHALL therefore take the non-touching resolve path: a report is not a sighting, and under an `auto` policy an agent may run it unprompted, so recording a folder-liveness heartbeat would make `last_seen` measure agent polling rather than the user's presence. The one write the shared resolver can still perform is repairing a moved anchor's cached path, which is the resolver's own healing behaviour on every read command rather than anything this command initiates.

An analysis with no recorded usage SHALL report that plainly rather than rendering an empty table or zeroed figures.

#### Scenario: Reporting does not record a sighting

- **GIVEN** an analysis whose anchor carries a last-seen heartbeat
- **WHEN** the usage command reports on it
- **THEN** the heartbeat is unchanged

#### Scenario: A report is produced with the durable engine stopped

- **GIVEN** a local ledger with recorded rows, and a local server whose harness runtime is not ready (still booting, or failed to boot)
- **WHEN** the usage command runs
- **THEN** it prints the analysis's consumption and exits successfully

#### Scenario: The breakdowns reconcile with the analysis's figures

- **GIVEN** an analysis whose calls were served by two different models across three agents
- **WHEN** the usage command runs
- **THEN** the output shows a per-model breakdown and a per-agent breakdown, each of which sums per quantity to the analysis's reported figures

#### Scenario: An analysis with no usage says so

- **WHEN** the usage command runs for an analysis with no recorded calls
- **THEN** it reports that no usage has been recorded, and does not print zeroed figures
