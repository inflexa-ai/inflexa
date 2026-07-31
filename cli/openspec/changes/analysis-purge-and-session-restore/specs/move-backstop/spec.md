## MODIFIED Requirements

### Requirement: Prune dead anchors

The system SHALL register `inflexa prune` (`runPrune`) that, for each anchor with `markerWritten: true` whose `cachedPath` no longer exists and which `resolveAnchor` cannot re-find, lists the affected analyses and, on confirmation, reclaims each analysis's Postgres footprint, then deletes the analyses (cascading their inputs via the FK) and the anchor. It SHALL NOT delete on a transient or re-findable miss.

The purge SHALL precede the SQLite deletion, for the same reason it does in the analysis-delete flow: the SQLite rows carry the only copy of the analysis ids, so deleting them first strands every one of those analyses' Postgres footprints beyond the reach of any retry — in bulk, and while reporting success. Prune is the second path that has been creating those orphans, so leaving it SQLite-only would keep the defect alive in the command most likely to encounter many analyses at once.

Prune is headless — it boots no harness runtime — so it SHALL obtain Postgres through the provisioning gate rather than a runtime pool, starting the container stack if it is not already up. A maintenance command is frequently run precisely because the environment is in a bad state, so refusing until the user starts the stack themselves would block the cleanup at the moment it is most wanted; and unlike the interactive delete flow, prune has no running application whose containers are already up by construction. The pool it opens SHALL be drained when the command finishes.

A failed purge for an analysis SHALL abort the prune with every SQLite row still present, and SHALL say that nothing was lost. Because the purge is idempotent, re-running `inflexa prune` after the cause is fixed SHALL be a supported recovery: the same anchors are still dead, the same analyses are still listed, and the purge simply runs again.

#### Scenario: Prune offers to drop a gone folder's records

- **WHEN** an anchor's folder has been deleted and cannot be re-found
- **THEN** `inflexa prune` lists it with its analysis count and, on confirmation, deletes them

#### Scenario: Re-findable anchors are not pruned

- **WHEN** an anchor's folder moved but is still re-findable via reconciliation
- **THEN** `inflexa prune` does not list or delete it

#### Scenario: Pruning reclaims each analysis's Postgres footprint

- **GIVEN** a dead anchor with two analyses that have conversations and runs
- **WHEN** `inflexa prune` is confirmed
- **THEN** `purgeAnalysis` runs for both analysis ids before either SQLite row is deleted

#### Scenario: Prune starts Postgres when it is down

- **GIVEN** the container stack is not running
- **WHEN** `inflexa prune` is confirmed
- **THEN** it brings Postgres up through the provisioning gate and proceeds, rather than refusing

#### Scenario: An unreachable Postgres leaves the records intact

- **GIVEN** Postgres cannot be provisioned or reached
- **WHEN** `inflexa prune` is confirmed
- **THEN** no anchor and no analysis row is deleted, and the user is told nothing was lost

#### Scenario: A failed purge leaves the prune retryable

- **GIVEN** a confirmed prune whose purge fails on one analysis
- **WHEN** the failure is reported
- **THEN** every SQLite row remains, and re-running `inflexa prune` after the cause is fixed completes
