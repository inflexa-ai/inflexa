## ADDED Requirements

### Requirement: manage_inputs shows its input, its result, and its error

`manage_inputs` MUST declare a view of the kinds of the harness `tool-call-values` capability. The view MUST show these values:

- the whole input of the call, as a JSON value
- the whole ok value of the call, as a JSON value, for the result
- the error text of a call with the outcome `error`

#### Scenario: An add call shows its input and its result

- **GIVEN** the `manage_inputs` tool
- **WHEN** its view reads an `add` call with one path, and the ok value of that call
- **THEN** the shown input is the input of the call, and the shown result is the ok value

#### Scenario: The view declares the error

- **GIVEN** the `manage_inputs` tool
- **WHEN** the tool is constructed
- **THEN** its packaged view declares `error`
