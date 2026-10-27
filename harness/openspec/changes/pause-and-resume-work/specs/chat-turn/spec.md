## MODIFIED Requirements

### Requirement: A failed turn tells the model what occurred

A turn workflow pauses on a cause of a pause, and it does not fail (see the `work-pause` capability). A turn with no workflow cannot pause, thus it fails on each failure. When a turn fails, the close MUST append a failure note after the stored rounds. The note is a synthetic record message, thus it opens no turn, and the display shows it as a `system` message. The note MUST give the reason of the failure. It MUST also state that the rounds before it ran.

The reason MUST be a short text that the harness makes from the class of the error:

- A `suspend` error gives the suspend reason of the host, for example `payment_required`.
- An `auth` provider error gives a fixed text that the model endpoint refused the credential.
- A different provider error gives a fixed text that the model request failed.
- A different error gives a fixed text that the turn stopped on an internal error.

The reason MUST NOT hold the message of the error. An error message can hold a secret or a path of the host, and each later turn sends the note to the model provider.

Before the turn stores the last round, the loop answers each unanswered tool call of that round with the not-run result (see the harness-agent-loop capability). Thus the next turn continues from the stored rounds.

The result MUST carry the error as `cause`.

#### Scenario: A 401 keeps the work and adds a note

- **GIVEN** a turn with no workflow whose third model request fails with an `auth` provider error
- **WHEN** the turn ends
- **THEN** the thread holds the opening, two rounds, and a note with the credential reason, and the turn record is `failed` with the same reason

#### Scenario: A suspend error gives the reason of the host

- **GIVEN** a turn with no workflow whose model request fails with a `suspend` error with the reason `payment_required`
- **WHEN** the turn ends
- **THEN** the note and the turn record give the reason `payment_required`, and the status of the analysis does not change

#### Scenario: A suspend error pauses a turn workflow

- **GIVEN** a turn workflow whose model request fails with a `suspend` error with the reason `payment_required`
- **WHEN** the turn gets the failure
- **THEN** the turn waits in `paused`, the thread holds no failure note, and the status of the analysis does not change

#### Scenario: The note holds no error text

- **GIVEN** a turn that fails with an error whose message holds a URL and a key
- **WHEN** the turn ends
- **THEN** the note and the turn record hold the fixed reason, and no part of the error message

#### Scenario: The next turn continues from the stored rounds

- **GIVEN** a thread whose last turn failed after two rounds
- **WHEN** the next turn is prepared
- **THEN** its messages start with each stored row of the failed turn, byte-identical, the note included

### Requirement: A turn reads the live credential of its host

The harness MUST get the credential of a turn from a function that the host gives, by the turn id. The turn MUST ask before each model request. A sub-agent of the turn MUST ask for the credential of its root turn. When the function gives no credential, the request MUST NOT run, and the turn MUST pause with the cause `credential` (see the `work-pause` capability). After the resume, each later call of the turn MUST use the credential that the resume put.

#### Scenario: A recovered turn of a host with a fixed credential

- **GIVEN** a host whose function gives the same credential for each turn
- **WHEN** a turn of that host recovers after a restart
- **THEN** the turn continues, and it ends with one outcome

#### Scenario: A recovered turn with no credential

- **GIVEN** a turn that ran when its host stopped, and a host function that gives no credential after the restart
- **WHEN** the host starts again and DBOS recovers the turn
- **THEN** the turn makes no model call, it waits in `paused` with the cause `credential`, and its record stays `open`

#### Scenario: A resume gives the credential

- **GIVEN** a turn that waits in `paused` with the cause `credential`
- **WHEN** a host resumes the turn with a session that holds a credential
- **THEN** the turn sends its model request with that credential, and it ends with one outcome

### Requirement: A turn closes with one outcome

A turn MUST have one status: `open` while it runs or waits in a pause, then `done`, `aborted`, or `failed`. The close MUST set the status one time, in the transaction that stores the last rows of the turn.

The turn MUST select the status from the run:

- A run that returns with the finish reason `aborted` is `aborted`.
- A run that returns with a different finish reason is `done`. This includes the finish reasons `content-filter`, `max_iterations`, and `denied`.
- A run that throws an `AbortError` while the turn is stopped is `aborted`.
- A run that throws a different error is `failed`.

The close MUST store the usage rollup of the turn and its duration on the turn record. A rollup that reports no quantity is stored as absent. The duration counts from the start time that the host gives, or from the start of the workflow when the host gives none.

A turn whose workflow is canceled closes as `aborted` through the stop of the host. When the write of the close fails, the record stays `open`, and the result carries the store error.

#### Scenario: A clean turn closes as done

- **GIVEN** a turn whose model answers in text after one tool round
- **WHEN** the turn ends
- **THEN** the turn record is `done`, with the rollup of the turn and its duration

#### Scenario: A filtered reply closes as done

- **GIVEN** a turn whose model stops with the finish reason `content-filter`
- **WHEN** the turn ends
- **THEN** the turn record is `done`, and the outcome carries the finish with that reason

#### Scenario: An interrupt closes as aborted

- **GIVEN** a turn that the user stops before the model gives output
- **WHEN** the turn ends
- **THEN** the thread holds the opening, and the turn record is `aborted`

#### Scenario: A thrown abort closes as aborted

- **GIVEN** a turn whose run throws an `AbortError` after the user stops the turn
- **WHEN** the turn ends
- **THEN** the turn record is `aborted`, and the result carries no failure

### Requirement: A host reads the outcome of a turn

The harness MUST give the outcome of a turn by its id when the workflow of the turn ends: the status, the duration, the stop reason, the usage, and whether the opening landed. A failed turn MUST give a scrubbed text and a machine code, and its `error` frame MUST carry the same code. The code MUST be `provider` for a provider error with no cause of a pause, and `internal` for each other error. A turn with no workflow cannot pause, thus it also gives the suspend reason of the host, `credential`, or `outage`. The turn MUST log the whole cause of a failure at error level.

#### Scenario: A refused request gives its code

- **WHEN** the endpoint refuses a request of a turn with the status `400`
- **THEN** the outcome is `failed` with the code `provider`, the last frame is `error` with the same code, and the log holds the cause

#### Scenario: A turn that ran gives its stop reason

- **WHEN** a turn ends with a reply
- **THEN** the outcome is `done` with the stop reason of the root loop, the usage of the turn, and the final text
