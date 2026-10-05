## MODIFIED Requirements

### Requirement: A canceled run ends with a terminal part

A canceled workflow runs no more steps, thus it never writes its own terminal part. The canceler cannot write the stream of a run. Only the body or a step of a workflow can write to the stream of that workflow. The subscription SHALL thus make the terminal part of a canceled run on the read side.

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
