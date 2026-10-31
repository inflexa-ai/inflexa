## ADDED Requirements

### Requirement: run_inflexa shows its argv, its status, and its output

`run_inflexa` MUST declare a view of the kinds of the harness `tool-call-values` capability, as follows:

- The input is the whole input of the call: the argv that the model sent, after the parse with the input schema. The classifier normalization does not change it. The detail of the call names the normalized argv.
- The result is a `fields` value. Its first field is `status`, a text of the status of the call. The other fields depend on the status:
  - `ran`: `exitCode`, a JSON value, then `stdout` and `stderr`, each a text.
  - `timed_out`: `stdout` and `stderr`, each a text.
  - `invalid` and `blocked`: `message`, a text.
  - `cancelled`: no other field.
- A `stdout` or `stderr` field is absent when its stream is empty.
- The view declares `error`, thus a call with the outcome `error` shows its error text.

#### Scenario: A call shows its argv and declares the error

- **GIVEN** the `run_inflexa` tool
- **WHEN** its view reads a call with the argv `["refs", "list"]`
- **THEN** the shown input is `{ "argv": ["refs", "list"] }`, and the view declares `error`

#### Scenario: A call that ran shows its status, its exit code, and each stream with text

- **GIVEN** a call that ran with the exit code 0, the stdout `out`, and an empty stderr
- **WHEN** the view reads its result
- **THEN** the result has the fields `status` (text), `exitCode` (JSON), and `stdout` (text), in that order, and no `stderr`

#### Scenario: A blocked call and a canceled call show their status

- **GIVEN** a call with the status `blocked` and a message, and a call with the status `cancelled`
- **WHEN** the view reads each result
- **THEN** the blocked call has the fields `status` and `message`, and the canceled call has the field `status` only
