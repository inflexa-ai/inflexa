## MODIFIED Requirements

### Requirement: Pool sizing is centralized and budget-checked at boot

App-pool size SHALL default to `DEFAULT_APP_POOL_SIZE` and be overridable via the
optional `DB_POOL_MAX` (parsed by `resolveAppPoolSize`); the DBOS pool size SHALL
be `DBOS_SYSTEM_POOL_SIZE`. Both constants live in `src/runtime/pools.ts`. At
boot the harness SHALL assert that `app + DBOS + safety margin` fits inside
Postgres `max_connections` and SHALL fail boot loudly when it does not.

The app pool SHALL additionally bound how long a caller waits to acquire a
connection, failing with an error once that bound is exceeded. The driver's
default is an unbounded wait, which gives a caller on a saturated pool no failure
mode at all — only an indefinite hang, indistinguishable from work still in
progress and therefore capable of stalling a caller's own in-flight guard
permanently. A bounded wait turns that silent stall into a surfaced error the
caller can degrade on.

#### Scenario: Pool size override is honored

- **WHEN** `DB_POOL_MAX` is set to a positive integer
- **THEN** the app pool uses that value as its maximum size

#### Scenario: Footprint exceeding max_connections aborts boot

- **GIVEN** the combined per-pod footprint plus safety margin exceeds `max_connections`
- **WHEN** the connection-budget guard runs
- **THEN** it throws and the process aborts boot instead of degrading under load

#### Scenario: A saturated pool fails rather than hanging

- **GIVEN** every connection in the app pool is checked out
- **WHEN** a caller requests a connection and none is released within the bound
- **THEN** the request rejects with an error rather than waiting indefinitely
