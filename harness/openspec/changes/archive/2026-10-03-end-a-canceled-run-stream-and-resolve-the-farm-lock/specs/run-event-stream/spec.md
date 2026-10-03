## MODIFIED Requirements

### Requirement: A run-scoped subscription delivers the run's durable event parts

The harness SHALL expose a run-event subscription that, given a run id, delivers every typed event part that run produces to a caller-supplied handler. The subscription SHALL accept an abort signal. It SHALL return a promise that settles in one of these cases:

- The run reached a terminal status, each stream that it opened drained, and the handler took the last part.
- The signal aborted.

The promise SHALL NOT settle while a part waits in the delivery queue. Thus a caller that awaits it knows that the handler took each part.

The delivered values SHALL be the harness's existing chat data-part types. No type belonging to the durability engine SHALL appear in the subscription's signature, so an embedder can consume run events without depending on the engine — the same boundary the run-launch seam draws for starting workflows.

#### Scenario: Parts reach the handler

- **WHEN** a caller subscribes to an active run and the run emits event parts
- **THEN** each part is passed to the caller's handler as a typed chat data part

#### Scenario: The subscription completes with the run

- **WHEN** the observed run reaches a terminal status and its streams drain
- **THEN** the returned promise settles and no further parts are delivered

#### Scenario: A slow handler takes each part before the settle

- **GIVEN** a handler that takes longer for each part than the streams take to drain
- **WHEN** the observed run reaches a terminal status
- **THEN** the returned promise settles only after the handler has taken the last part

#### Scenario: Aborting ends the subscription

- **WHEN** the caller aborts the supplied signal while the run is still active
- **THEN** the subscription stops delivering parts and the returned promise settles

#### Scenario: The signature is engine-agnostic

- **WHEN** an embedder imports the subscription
- **THEN** it can name every type in its signature without importing the durability engine

## ADDED Requirements

### Requirement: A canceled run ends with a terminal part

A canceled workflow runs no more steps, thus it never writes its own terminal part. The canceler cannot write a stream, because the durability engine lets only a workflow body write one. The subscription SHALL thus make the terminal part of a canceled run on the read side.

When every stream of the run ends and no `data-run-completed` or `data-run-failed` part came, the subscription SHALL read the status of the run row. If the row reads `canceled`, it SHALL deliver `{ type: "data-run-failed", runId, error: "Run canceled", reason: "canceled" }` as the last part. The canceler writes the row after the engine cancel, thus the subscription SHALL read an active row (`running` or `suspended_insufficient_funds`) again, up to 4 reads at 500 ms. It SHALL deliver no part in these cases:

- No row has the run id.
- The row reads a different terminal status.
- The row stays active after the last read.
- The signal aborted.

A failed read SHALL go to the logger, and the next read SHALL come after it.

#### Scenario: A canceled run gets a terminal part

- **GIVEN** a run whose streams end with no terminal part
- **WHEN** the run row reads `canceled`
- **THEN** the last part delivered is `data-run-failed` with `reason: "canceled"`

#### Scenario: A run with its own terminal part gets no second part

- **WHEN** a run writes `data-run-completed` and its streams end
- **THEN** the subscription reads no run row and adds no part

#### Scenario: The row changes after the stream ends

- **GIVEN** a run whose streams end while its row still reads `running`
- **WHEN** a later read finds the row `canceled`
- **THEN** the subscription delivers the canceled terminal part

#### Scenario: A row that stays active gets no part

- **WHEN** the row reads `running` on each of the reads
- **THEN** the subscription settles with no terminal part
