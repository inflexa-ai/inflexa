## MODIFIED Requirements

### Requirement: A chat turn opens before it runs

The harness MUST give an open call that takes the session and `{ analysisId, threadId, userInput }`. It MUST open the thread, resolve the agent of the thread type, claim the thread, and start the turn workflow. The workflow stores the opening. The open MUST give one of these results:

- `prepare_failed`, `not_found`, `agent_unresolved`, or `turn_in_progress`
- `started`, with the turn id and the resolved agent

A refusal MUST come back before the turn writes a row or a turn record. Thus a host can answer a refusal before it reads a stream.

The open MUST make an absent thread as a `conversation` thread of the analysis of the turn, with a title from the user input. Thus a host needs no other call to make a thread. The open MUST give `not_found` for a thread that a different analysis owns, live or archived. It MUST also give `not_found` for an archived thread of the same analysis. The open MUST NOT restore an archived thread. When the open cannot make or read the thread, the result MUST be `prepare_failed`.

#### Scenario: A thread of a different analysis is refused at the open

- **GIVEN** a thread that a different analysis owns
- **WHEN** a host opens a turn on it
- **THEN** the result is `not_found`, and the thread holds no row and no turn record of the turn

#### Scenario: An absent thread is made at the open

- **GIVEN** no thread with the id of the turn
- **WHEN** a host opens a turn on that id
- **THEN** the analysis of the turn owns a new `conversation` thread with that id, and its title comes from the user input

#### Scenario: An archived thread of a different analysis is refused at the open

- **GIVEN** an archived thread that a different analysis owns
- **WHEN** a host opens a turn on it
- **THEN** the result is `not_found`, and the thread holds no row and no turn record of the turn
- **AND** the thread stays archived, and a different analysis still owns it

#### Scenario: An archived thread of the same analysis is refused at the open

- **GIVEN** an archived thread of the analysis of the turn
- **WHEN** a host opens a turn on it
- **THEN** the result is `not_found`, and the thread holds no row and no turn record of the turn
- **AND** the thread stays archived

#### Scenario: A failed make of the thread fails the open

- **GIVEN** no thread with the id of the turn, and a store that fails the make of the thread
- **WHEN** a host opens a turn on that id
- **THEN** the result is `prepare_failed`, and no turn runs

### Requirement: The harness runs the whole chat turn

The harness MUST give one app function that runs one chat turn from the user input to the outcome. It MUST prepare the turn, resolve the agent of the thread type, and store the opening. Then it MUST run the loop with a round sink, and close the turn with its outcome. A host MUST NOT run these steps itself.

The preparation MUST obey the thread rules of the open of a chat turn. It MUST make an absent thread. It MUST give `not_found` for a thread of a different analysis, live or archived. It MUST also give `not_found` for an archived thread of the same analysis. It MUST give `prepare_failed` when it cannot make or read the thread.

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

#### Scenario: An archived thread of a different analysis is not found

- **GIVEN** an archived thread that a different analysis owns
- **WHEN** the host runs a turn on it
- **THEN** the result is `not_found`, the thread did not change, and no model request was sent

#### Scenario: An archived thread of the same analysis is not found

- **GIVEN** an archived thread of the analysis of the turn
- **WHEN** the host runs a turn on it
- **THEN** the result is `not_found`, the thread did not change, and it stays archived
