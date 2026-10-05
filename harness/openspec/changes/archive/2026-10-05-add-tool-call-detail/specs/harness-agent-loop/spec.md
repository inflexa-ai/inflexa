## ADDED Requirements

### Requirement: The tool-finished observation reports a three-way outcome

The loop's `tool-finished` event SHALL report `outcome: "ok" | "error" | "denied"` rather than a boolean error flag. `denied` SHALL be reported when the tool result is `execution-denied`; `error` SHALL be reported for an error tool result from a thrown failure, an `err(ToolError)`, or rejected input; `ok` SHALL be reported otherwise.

The loop already distinguishes a denial from a recoverable tool error in its control flow — a denial hard-stops the turn, while an error is one the model reads and retries around. Folding both into one flag loses that distinction at the observation boundary, so a user who rejects an approval sees their own decision reported as a fault. A single three-state field SHALL carry it, rather than two booleans that can express the impossible combination.

#### Scenario: A denied approval is reported as denied, not as an error

- **GIVEN** a turn in which a tool's approval request is answered `reject`
- **WHEN** the loop emits that call's finished event
- **THEN** the event reports `outcome: "denied"`

#### Scenario: A thrown tool failure is reported as an error

- **GIVEN** a tool whose execution throws a non-fatal error
- **WHEN** the loop emits that call's finished event
- **THEN** the event reports `outcome: "error"`

#### Scenario: Rejected input is reported as an error

- **GIVEN** a tool call whose input fails the tool's Zod schema and cannot be repaired
- **WHEN** the loop emits that call's finished event
- **THEN** the event reports `outcome: "error"` and the tool was never executed

#### Scenario: A successful call is reported as ok

- **GIVEN** a tool that returns an `ok` data variant, including an expected "not found" outcome
- **WHEN** the loop emits that call's finished event
- **THEN** the event reports `outcome: "ok"`
