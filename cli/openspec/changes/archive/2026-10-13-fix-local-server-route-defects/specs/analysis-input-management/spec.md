## ADDED Requirements

### Requirement: Each removal surface tries each matched input

`POST {A}/inputs/remove`, the removals of `PUT {A}/inputs`, and the `remove` action of `manage_inputs` MUST call the shared `removeInput` operation one time for each matched input. A failed removal MUST NOT stop the removals that follow it, because each input is independent.

If each removal succeeds, the route MUST answer 200 with the removed inputs and the paths that match no input. If one or more removals fail, the route MUST answer 500 `internal_error` after it tries each matched input. The message MUST name each input that failed and each input that the route removed. The cause of each failure MUST go only to the log.

`PUT {A}/inputs` MUST obey the same rule for its removals. Its message MUST also name each input that it added. A failed add MUST change nothing, and its message MUST say so.

The `remove` action of `manage_inputs` MUST give `status: "error"` after it tries each matched input. The message MUST name each input that failed, the type of each error, and each input that the tool removed.

#### Scenario: One failed removal keeps the others

- **GIVEN** three matched inputs, and the removal of the second input fails
- **WHEN** a client sends `POST {A}/inputs/remove` with the three paths
- **THEN** the first input and the third input are removed, and each of the two removals emits `prov.input_removed`
- **AND** the server answers 500 `internal_error`, and the message names the second input as failed and the first and third inputs as removed

#### Scenario: Each removal succeeds

- **WHEN** a client sends `POST {A}/inputs/remove`, and each matched input is removed
- **THEN** the server answers 200 with `removed` and `notInputs`

#### Scenario: A replacement names each failed removal

- **GIVEN** four inputs, and the removal of the second input and of the third input fails
- **WHEN** a client sends `PUT {A}/inputs` with a set that holds none of the four inputs
- **THEN** the first input and the fourth input are removed
- **AND** the server answers 500 `internal_error`, and the message names the second input and the third input as failed and the first input and the fourth input as removed

#### Scenario: The agent tool names each failed removal

- **GIVEN** four inputs, and the removal of the second input and of the third input fails
- **WHEN** the agent calls `manage_inputs` with `remove` and the four paths
- **THEN** the first input and the fourth input are removed
- **AND** the tool gives `status: "error"`, and the message names the second input and the third input as failed and the first input and the fourth input as removed
