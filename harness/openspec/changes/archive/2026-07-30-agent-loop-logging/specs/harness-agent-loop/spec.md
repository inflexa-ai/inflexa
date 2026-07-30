## ADDED Requirements

### Requirement: The loop reports its own lifecycle through an injected Logger

`runAgent` SHALL accept an optional `Logger` on its options and SHALL report its lifecycle through
it. The option SHALL be optional and SHALL resolve to `createNoopLogger()` when absent, so a caller
that wires nothing behaves exactly as it does with no logging at all, and SHALL be resolved once
per run rather than consulted conditionally at each call site.

Every record the loop writes SHALL carry the run's `agentId` and `callPath` as structured fields,
derived from the same `EventSource` value the loop builds for its emitted events, so a record and
an event can never disagree about which agent produced them. A sub-agent's records are therefore
attributable to the parent that spawned it, which is what makes them useful on a surface that
deliberately filters sub-agent *events* out by that same `callPath` depth.

The loop SHALL write exactly one terminal record per completed run, carrying the iteration count,
the finish reason, whether the run exhausted its iteration cap, and the token usage it accumulated.
It SHALL NOT write a terminal record per iteration.

#### Scenario: A completed run leaves one terminal record

- **GIVEN** an agent whose model replies without tool calls on its second iteration
- **WHEN** `runAgent` returns
- **THEN** exactly one terminal record is written, carrying the iteration count, the finish reason, `cappedOut`, and the accumulated token usage

#### Scenario: A record names the agent and its call path

- **GIVEN** a sub-agent invoked with a `callPath` extended from its parent
- **WHEN** the loop writes any record
- **THEN** that record carries `agentId` and `callPath` as structured fields rather than interpolated into the message

#### Scenario: A caller that wires no logger is unaffected

- **GIVEN** a `runAgent` call whose options omit the logger
- **WHEN** the run completes
- **THEN** no record is written anywhere and the returned result is identical to the same run with a logger wired

### Requirement: Loop log levels are assigned by outcome class, not by call site

The loop SHALL assign levels so that the default level stays affordable for a long run and a
degraded outcome is visible without raising it:

- `debug` — one record per iteration, naming the tools dispatched in that iteration.
- `info` — the terminal record of a run that ended as intended.
- `warn` — a run that produced a result but did not end as intended: it exhausted its iteration cap
  and took the forced wrap-up path, or it ended on a denied tool approval.
- `error` — a run that could not produce a result.

The per-iteration record is the only record whose count grows with the length of the run. At the
default level a run SHALL therefore contribute a bounded number of records regardless of how many
iterations it took.

#### Scenario: A capped-out run is visible at the default level

- **GIVEN** an agent that exhausts `maxIterations` and takes the tool-less wrap-up path
- **WHEN** the run completes
- **THEN** its terminal record is written at `warn` rather than `info`

#### Scenario: Per-iteration detail is confined to debug

- **GIVEN** an agent that runs for ten iterations
- **WHEN** the sink is filtered at `info`
- **THEN** one record survives for the run, and none of the ten per-iteration records do

#### Scenario: A denied approval is a degraded outcome

- **GIVEN** a tool approval that the user denies, terminating the turn
- **WHEN** the loop returns
- **THEN** the terminal record is written at `warn` and carries the denial as the finish reason

## MODIFIED Requirements

### Requirement: runToTerminal salvages a run that never reached its terminal tool

`runToTerminal` SHALL run the agent and, when the terminal-outcome cell is unresolved and the run was not aborted, grant exactly one salvage continuation whose tool surface is only the terminal tools, opened by a corrective nudge and with salvage step names namespaced so a durable caller does not reuse the first run's cache slots. When the run already resolved (or was aborted), it SHALL return the first run's result unchanged.

A started salvage continuation SHALL be reported at `warn` through the loop's `Logger`, because
reaching it means the agent ended without recording its terminal outcome. `runToTerminal` is the
only layer that can report this: `runAgent` sees the salvage run as an ordinary run with a small
budget and a restricted tool set, and cannot know it is a second attempt.

#### Scenario: An agent that never submits gets one terminal-only salvage turn

- **GIVEN** an agent that exhausts its budget without calling its terminal tool
- **WHEN** `runToTerminal` runs it
- **THEN** one salvage continuation runs with only the terminal tools offered and a corrective nudge prepended

#### Scenario: A resolved run is returned without salvage

- **GIVEN** an agent that calls its terminal tool during the first run
- **WHEN** `runToTerminal` runs it
- **THEN** no salvage continuation is started and the first run's result is returned

#### Scenario: A fired salvage is reported

- **GIVEN** an agent that exhausts its budget without calling its terminal tool
- **WHEN** `runToTerminal` starts the salvage continuation
- **THEN** a record is written at `warn` identifying the agent whose run failed to resolve

#### Scenario: A resolved run reports no salvage

- **GIVEN** an agent that calls its terminal tool during the first run
- **WHEN** `runToTerminal` returns
- **THEN** no salvage record is written
