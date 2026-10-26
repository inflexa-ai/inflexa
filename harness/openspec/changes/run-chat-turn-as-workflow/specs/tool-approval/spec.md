## ADDED Requirements

### Requirement: A tool declares its approval before it runs

A tool MUST be able to declare an approval hook. The hook gets the input of the call and the context, and it gives an `AskRequest` or nothing. The hook can read the disk and the database, and it MUST NOT change them. The loop MUST run the hook after the call policy and before `execute`. A call whose hook gives nothing MUST run with no ask.

`execute` MUST check its input again when it runs. When a fact that the approval saw changed, `execute` MUST fail with an error result, and it MUST NOT act.

#### Scenario: A command that needs approval waits before it runs

- **GIVEN** a tool whose hook gives a request for the input of the call
- **WHEN** the model calls the tool
- **THEN** the ask row is `pending` and the `data-ask` part reaches the stream before `execute` starts

#### Scenario: A command with a standing grant runs with no ask

- **GIVEN** a grant of the user for the grant key of the request
- **WHEN** the model calls the tool
- **THEN** the call runs, and no ask row is written

### Requirement: The wait for an approval is durable

Inside a turn workflow, the turn MUST wait for the answer of an ask with a durable wait of the workflow, up to the time limit of the ask. The answer of the host MUST reach the waiting turn by the ask id. A wait MUST NOT run inside a step.

#### Scenario: An answer after a crash

- **GIVEN** a turn that waits for an answer, and then the host stopped and started again, and the host function gives the credential of the turn
- **WHEN** the turn recovers and the user answers `once`
- **THEN** the call runs, and the ask row is `resolved`

#### Scenario: An ask that nobody answers

- **WHEN** the time limit of a pending ask ends
- **THEN** the ask row is `expired`, and the call gets a denied result

### Requirement: A denial gives the call a denied result and stops the turn

A `reject` answer and an expired ask MUST give the call an `execution-denied` result with the feedback of the user. The turn MUST stop after the calls of the same reply complete, and it MUST NOT make a model request after the denial. `once` and `always` MUST let the call run.

#### Scenario: A rejected command

- **WHEN** the user answers `reject` with the feedback "not this file"
- **THEN** the call result is denied with that feedback, the tool does not run, and no model request follows

## REMOVED Requirements

### Requirement: A conversation tool requests user approval through ctx.ask

**Reason**: The approval is decided before `execute`, through the approval hook of the tool. A tool does not ask from inside `execute`.

**Migration**: Move the request of the tool from `execute` into its approval hook. Check the input again in `execute`.

### Requirement: A rejected ask throws to end the turn

**Reason**: A tool does not ask from inside `execute`, thus no ask throws into a tool.

**Migration**: Refer to "A denial gives the call a denied result and stops the turn".

### Requirement: Approval polling never blocks a durable step

**Reason**: The chat turn is a workflow, and its wait is a durable wait of the workflow body, not a poll inside a step.

**Migration**: Refer to "The wait for an approval is durable".

### Requirement: Ask state lives in a poll-backed ledger with the database as the single source of truth

**Reason**: The decision reaches the turn as a message to its workflow. The ledger row stays the record of each ask, but no poll reads it.

**Migration**: Refer to "The wait for an approval is durable". The `answer` call writes the row and sends the reply to the turn.

## MODIFIED Requirements

### Requirement: Approval is deny-by-default when unwired

An approval that no surface can answer MUST be denied. A loop outside a turn workflow, for example a step agent or a test, MUST deny each request of an approval hook. It MUST NOT wait on a surface that cannot answer.

#### Scenario: An unwired host denies every ask

- **GIVEN** a loop that runs outside a turn workflow
- **WHEN** the approval hook of a tool gives a request
- **THEN** the call gets a denied result rather than a wait
