## ADDED Requirements

### Requirement: The harness runs the whole chat turn

The harness MUST give one app function that runs one chat turn from the user input to the outcome. It MUST prepare the turn, resolve the agent of the thread type, and store the opening. Then it MUST run the loop with a round sink, and close the turn with its outcome. A host MUST NOT run these steps itself.

#### Scenario: A host runs a turn with one call

- **WHEN** a host runs a turn with its emit sink, its signal, and the user message
- **THEN** the thread holds the opening, each round, and a closed turn record, and the host wrote no row itself

#### Scenario: A refused thread type writes nothing

- **GIVEN** a thread whose type has no registered agent
- **WHEN** the host runs a turn on it
- **THEN** the result is `agent_unresolved` with the thread type, and the turn wrote no row

#### Scenario: A thread of a different analysis is not found

- **GIVEN** a thread that a different analysis owns
- **WHEN** the host runs a turn on it
- **THEN** the result is `not_found`, and the thread did not change

### Requirement: A host gives only its transport values

A host MUST give only these values for a turn: the emit sink of its surface, the abort signal, the author of the user message, and the start time. It can also give a cache policy for the root loop. The harness MUST make the model, the text stream, the usage recorder, and the approval binding of the turn from its own runtime.

#### Scenario: The conversation agent is recorded with no host wiring

- **WHEN** a host runs a turn and gives no usage recorder
- **THEN** each model call of the turn reaches the usage recorder of the runtime

### Requirement: A turn gives one result

The function MUST give one of these results:

- `prepare_failed`, with the cause
- `not_found`
- `agent_unresolved`, with the thread type
- `ran`, with the outcome and the final text. It also gives the duration, the turn usage, and a store error when there is one.
 A turn that ends before the run writes no row and no turn record.

#### Scenario: A failed preparation

- **WHEN** the preparation of a turn throws
- **THEN** the result is `prepare_failed` with the cause, and the turn wrote no row
