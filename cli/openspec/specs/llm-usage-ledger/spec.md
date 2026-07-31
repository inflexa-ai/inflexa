# llm-usage-ledger Specification

## Purpose
TBD - created by archiving change cli-token-usage-ledger. Update Purpose after archive.
## Requirements
### Requirement: The CLI realizes the harness UsageRecorder seam at its composition root

The CLI SHALL supply a `UsageRecorder` realization to `assembleCoreRuntime` at the single composition root that builds the harness runtime, so that every `runAgent` invocation the CLI can reach — the conversation turn, the planner and other sub-agent loops, the data-profile agent, and every analysis run step — delivers its records to that one realization. The realization SHALL be constructed once per booted runtime, not per turn or per call.

The realization SHALL satisfy the seam's two contract terms without qualification: `record` SHALL NOT throw for any input, and SHALL NOT await. A storage fault encountered while recording SHALL be reported through the structured logger and otherwise discarded, so that a usage-ledger failure can never fail, abort, or alter a turn that would otherwise have succeeded.

#### Scenario: Every reachable loop records under one realization

- **WHEN** a conversation turn dispatches a sub-agent tool that itself runs an agent loop
- **THEN** the calls of both loops arrive at the same injected recorder, each carrying its own `agentId` and `callPath`

#### Scenario: A storage fault cannot fail a turn

- **GIVEN** a recorder whose underlying write fails for every record
- **WHEN** a turn completes
- **THEN** `record` throws nothing, the turn's outcome is unchanged, and the failure is logged

#### Scenario: A host that wires nothing is unaffected

- **GIVEN** a harness runtime assembled without a recorder
- **WHEN** an agent loop runs
- **THEN** the no-op recorder absorbs every record and no ledger row is written

### Requirement: Records persist to a local ledger keyed by the harness record key

The CLI SHALL persist one row per `LlmUsageRecord` in its local SQLite database, in a table whose PRIMARY KEY is the record's `recordKey`. The write SHALL be an upsert on that key: a record whose key is already present SHALL update the stored token figures and model identities rather than inserting a second row or failing.

The ledger SHALL NOT define a foreign key from a usage row to any other table. Scope identifiers are minted by the harness and include ids the CLI's local tables never hold, and a referential failure would surface as a throw on the one path forbidden to throw.

The row's arrival timestamp SHALL be set when the record is first observed and SHALL NOT be advanced by a subsequent upsert of the same key, so the ledger's time axis records when work was performed rather than when a recovery re-delivered it.

#### Scenario: A replayed workflow body does not double-count

- **GIVEN** a durable run whose step body is replayed after recovery, re-firing `record` with identical keys
- **WHEN** the ledger is read
- **THEN** each call appears exactly once, and the totals equal those of a run that never replayed

#### Scenario: The first observation fixes the row's time

- **GIVEN** a record persisted, then re-delivered later under the same key
- **WHEN** the row is read
- **THEN** its recorded time is the first delivery's, while its token figures reflect the latest delivery

#### Scenario: A record for an unknown scope still persists

- **GIVEN** a record whose scope id matches no row in the local analyses table
- **WHEN** it is recorded
- **THEN** the row is written and no error is raised

### Requirement: Persistence preserves the absent-means-not-reported discipline

Each of the record's token quantities SHALL be stored in a nullable column and SHALL be written as NULL when the provider did not report it. A quantity that was not reported SHALL NOT be stored as zero, and the ledger SHALL NOT apply a zero default to any token column.

Aggregation over the ledger SHALL preserve the same distinction: a sum over a set of rows in which no row reported a given quantity SHALL be reported as absent, not as zero.

The five quantities SHALL NOT be added to one another, at any layer. Cache-read, cache-write, and reasoning counts are breakdowns of the input and output counts rather than amounts alongside them, so no query, aggregate, or surface SHALL compute a single combined token figure. Consumption SHALL be reported as an input figure and an output figure, with the remaining quantities presented only as breakdowns of those two.

#### Scenario: An unreported quantity is not a zero measurement

- **GIVEN** a provider that reports input and output tokens but never cache reads
- **WHEN** its calls are persisted and then totalled
- **THEN** the cache-read total is absent, distinguishable from a provider that reported a cache-read count of zero

#### Scenario: A record reporting nothing is not stored as an all-zero row

- **WHEN** a record arrives whose usage reports no quantity at all
- **THEN** the row's token columns are all NULL

#### Scenario: A cached prefix is never counted twice

- **GIVEN** a call whose reported input count already includes its cache-read count
- **WHEN** any surface reports that call's consumption
- **THEN** the input figure is the reported input count, and the cache-read count appears only as a breakdown of it

### Requirement: Usage rows outlive the analysis they attribute to

Deleting an analysis SHALL NOT delete the usage rows attributed to it, and the ledger SHALL NOT define a retention, expiry, or pruning policy. The ledger records tokens that were spent, and removing a local record of the work does not un-spend them.

An orphaned row SHALL remain readable and correctly attributed by scope id, and SHALL NOT appear in a report about any other analysis.

#### Scenario: Deleting an analysis leaves its usage recorded

- **GIVEN** an analysis with recorded usage
- **WHEN** the analysis is deleted
- **THEN** its usage rows remain in the ledger and the deletion succeeds

#### Scenario: An orphaned row does not intrude on another analysis's report

- **GIVEN** ledger rows whose scope id matches no existing analysis
- **WHEN** the usage command reports on a different analysis
- **THEN** the orphaned rows contribute nothing to that report

### Requirement: A usage row carries the attribution needed to answer where tokens went

Every persisted row SHALL carry the record's agent id, its call path, its scope discriminant and scope id, and — each present only when the record carried it — the thread id, run id, step id, requested model id, and served model id. The scope SHALL be stored as a discriminant plus an id so that both scope variants are representable and neither is silently discarded.

The ledger SHALL be queryable by scope id, by run id, and by served model, since these are the attributions the capability exists to report on.

#### Scenario: A chat call is attributable to its analysis and thread

- **WHEN** a conversation turn's call is persisted
- **THEN** its row carries the analysis id and the thread id, and carries no run id or step id

#### Scenario: A run step's call is attributable to its run and step

- **WHEN** an analysis run step's call is persisted
- **THEN** its row carries the run id and step id alongside the analysis id

#### Scenario: The served model is recorded distinctly from the requested one

- **GIVEN** an endpoint that answers a request for one model id by reporting a different served id
- **WHEN** the call is persisted
- **THEN** both ids are stored and are separately readable

### Requirement: The usage command reports what an analysis consumed

The CLI SHALL provide a read-only `usage` command that reports an analysis's recorded consumption, resolved from the current working context or named by an option. It SHALL report per-quantity sums rather than one combined number, and SHALL break the consumption down by served model and by agent, since "which model spent this" and "which agent spent this" are the questions the capability exists to answer.

The command SHALL read only the local ledger and SHALL NOT require the harness runtime, its database, or any network service to be running. It SHALL declare an `auto` agent policy whose safe-flag allowlist covers its analysis selector.

The command SHALL NOT write. Resolving which analysis to report on SHALL therefore take the non-touching resolve path: a report is not a sighting, and under an `auto` policy an agent may run it unprompted, so recording a folder-liveness heartbeat would make `last_seen` measure agent polling rather than the user's presence. The one write the shared resolver can still perform is repairing a moved anchor's cached path, which is the resolver's own healing behaviour on every read command rather than anything this command initiates.

#### Scenario: Reporting does not record a sighting

- **GIVEN** an analysis whose anchor carries a last-seen heartbeat
- **WHEN** the usage command reports on it
- **THEN** the heartbeat is unchanged

An analysis with no recorded usage SHALL report that plainly rather than rendering an empty table or zeroed figures.

#### Scenario: A report is produced with the durable engine stopped

- **GIVEN** a local ledger with recorded rows and no running harness runtime
- **WHEN** the usage command runs
- **THEN** it prints the analysis's consumption and exits successfully

#### Scenario: The breakdowns reconcile with the analysis's figures

- **GIVEN** an analysis whose calls were served by two different models across three agents
- **WHEN** the usage command runs
- **THEN** the output shows a per-model breakdown and a per-agent breakdown, each of which sums per quantity to the analysis's reported figures

#### Scenario: An analysis with no usage says so

- **WHEN** the usage command runs for an analysis with no recorded calls
- **THEN** it reports that no usage has been recorded, and does not print zeroed figures

