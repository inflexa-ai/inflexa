## ADDED Requirements

### Requirement: A run with a run row ends with one terminal part

A workflow writes its own terminal part only from `collectAndComplete`. A canceled workflow runs no more steps, thus it never writes its own terminal part. A workflow that fails before `collectAndComplete` writes none. A run whose workflow never started has no stream. The canceler cannot write the stream of a run. Only the body or a step of a workflow can write to the stream of that workflow. The subscription SHALL thus make the missing terminal part on the read side.

When every stream of the run ends and no `data-run-completed` or `data-run-failed` part came, the subscription SHALL read the run row. The canceler writes the row after the engine cancel, thus the subscription SHALL read a `running` row again, up to 4 reads at 500 ms. Then it SHALL deliver the last part from the row:

- No row: no part. A data-profile workflow has no run row.
- `canceled`: `{ type: "data-run-failed", runId, error: "Run canceled", reason: "canceled" }`.
- `failed`: `data-run-failed` whose `error` is the error of the row, with no `reason`. A row with no error gives `error: "Run failed"`.
- `completed` or `partial`: no part. `collectAndComplete` writes `data-run-completed` after the status write, in the same body. Such a row with no part means that the write of the part failed, and the row holds no step counts and no findings to make the part.

If the row still reads `running` after the last read, the subscription SHALL read the status of the parent workflow from the durability engine:

- `CANCELLED`: `{ type: "data-run-failed", runId, error: "Run canceled", reason: "canceled" }`.
- `ERROR`, `MAX_RECOVERY_ATTEMPTS_EXCEEDED`, or `SUCCESS`: `{ type: "data-run-failed", runId, error: "Run ended without a terminal status" }`, with no `reason`.
- An active status (`PENDING`, `ENQUEUED`, `DELAYED`): no part. A stream read stopped on a failure, and the run continues. The subscription SHALL log a warning.
- No workflow: no part. The launch did not start the workflow, or it never started.

The subscription SHALL deliver no part when the signal aborted. A failed read of the run row or of the workflow status SHALL go to the logger. After a failed row read the next row read SHALL come. A failed workflow-status read gives no part.

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

#### Scenario: A failed run with no terminal part gets one

- **GIVEN** a run row that reads `failed` with the error `"workflow start failed"`, and no stream part
- **WHEN** a caller subscribes to the run
- **THEN** the last part delivered is `data-run-failed` with `error: "workflow start failed"` and no `reason`

#### Scenario: A wedged run gets a failed part

- **GIVEN** a run whose row reads `running` on each of the reads, and whose parent workflow status is `ERROR`
- **WHEN** its streams end with no terminal part
- **THEN** the last part delivered is `data-run-failed` with `error: "Run ended without a terminal status"` and no `reason`

#### Scenario: A late canceler write still gives a canceled part

- **GIVEN** a run whose row reads `running` on each of the reads, and whose parent workflow status is `CANCELLED`
- **WHEN** its streams end with no terminal part
- **THEN** the last part delivered is `data-run-failed` with `reason: "canceled"`

#### Scenario: A completed row with no part gets no part

- **GIVEN** a run row that reads `completed`, and streams that hold no terminal part
- **WHEN** the streams end
- **THEN** the subscription delivers no terminal part

#### Scenario: A row that stays active gets no part

- **GIVEN** a run whose row reads `running` on each of the reads, and whose parent workflow status is `PENDING`
- **WHEN** the subscription settles
- **THEN** it delivers no terminal part, and it logs a warning

## REMOVED Requirements

### Requirement: A run with a run row ends with a terminal part

**Reason**: Its scenarios of a suspension describe a state that no longer exists. A MODIFIED block cannot drop a scenario, thus the requirement "A run with a run row ends with one terminal part" replaces it.

**Migration**: Refer to "A run with a run row ends with one terminal part" in this capability.
