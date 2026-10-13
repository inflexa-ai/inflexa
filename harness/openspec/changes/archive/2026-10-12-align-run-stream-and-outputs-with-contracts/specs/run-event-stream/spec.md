## RENAMED Requirements

- FROM: `### Requirement: A canceled run ends with a terminal part`
- TO: `### Requirement: A run with a run row ends with a terminal part`

## MODIFIED Requirements

### Requirement: A run with a run row ends with a terminal part

A workflow writes its own terminal part only from `collectAndComplete`. A canceled workflow runs no more steps, thus it never writes its own terminal part. A workflow that fails before `collectAndComplete` writes none. A run whose workflow never started has no stream. The canceler cannot write the stream of a run. Only the body or a step of a workflow can write to the stream of that workflow. The subscription SHALL thus make the missing terminal part on the read side.

When every stream of the run ends and no `data-run-completed` or `data-run-failed` part came, the subscription SHALL read the run row. The canceler writes the row after the engine cancel, thus the subscription SHALL read a `running` row again, up to 4 reads at 500 ms. Then it SHALL deliver the last part from the row:

- No row: no part. A data-profile workflow has no run row.
- `canceled`: `{ type: "data-run-failed", runId, error: "Run canceled", reason: "canceled" }`.
- `suspended_insufficient_funds`: `data-run-failed` whose `error` and `reason` are the error of the row. A row with no error gives `error: "Run suspended"` and no `reason`.
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

#### Scenario: A suspended run with no workflow gets the reason of the host

- **GIVEN** a run row that reads `suspended_insufficient_funds` with the error `"budget_exceeded"`, and no workflow for the run
- **WHEN** a caller subscribes to the run
- **THEN** the last part delivered is `data-run-failed` with `error: "budget_exceeded"` and `reason: "budget_exceeded"`

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

## ADDED Requirements

### Requirement: A data part rides the run stream flat

A workflow that writes a data part to its run stream SHALL write the flat shape of the part contract, `{ type, ...fields }`. This is the shape of the chat stream. A data part that a loop or a tool gives as a `{ type, data }` envelope SHALL be flattened before the write. A workflow envelope outside the part registry, for example `data-loop-event` or `data-sandbox-event`, keeps its `{ type, data }` shape.

#### Scenario: The synthesis part matches its contract

- **GIVEN** a run whose synthesis produces a result
- **WHEN** a caller subscribes to the run
- **THEN** the delivered `data-run-synthesis` part has `id`, `runId`, `overview`, `findings`, `themes`, and `keyReferences` at its top level
- **AND** the part passes `RunSynthesisPartSchema`
