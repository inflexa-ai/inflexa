## ADDED Requirements

### Requirement: A pause for a person suspends the run credential

The pause of a run, of a step of a run, of a sub-agent of a run, and of a profile SHALL record the run session of its workflow on its row. When the wait is in the state `paused`, or a person holds a wait in `retrying`, the pause SHALL call `RunAuthorizer.suspend` in a durable step, before it waits for the person. A wait in `retrying` SHALL NOT suspend, because its timer ends it with no person. A turn SHALL record no run session. A failed suspend SHALL NOT change the wait.

#### Scenario: A pause for a person suspends

- **GIVEN** a run with a run session that pauses with the cause `host`
- **WHEN** the pause writes its row
- **THEN** the row holds the run session, and `suspend` gets that session and the reason `paused:host`

#### Scenario: A held wait suspends

- **GIVEN** a run that waits in `retrying` after an outage
- **WHEN** a person holds the work
- **THEN** the row keeps the run session, and `suspend` gets the reason `paused:outage`

#### Scenario: A wait on the timer does not suspend

- **WHEN** an outage pauses a run in `retrying`, and the timer ends the wait
- **THEN** `suspend` is not called

### Requirement: A resume renews the run credential first

When a host resumes work whose rows hold a run session, `PausedWorkSurface.resume` SHALL call `RunAuthorizer.renew` one time for the work, with that run session and the `auth` of the session of the resume, before it sends a message. When the gate refuses, the resume SHALL give `{ kind: "refused", reason }` with the reason of the host, SHALL send no message, and the work SHALL stay paused.

#### Scenario: A renewal opens the way

- **GIVEN** a paused run with a run session
- **WHEN** a host resumes it and the host renews the credential
- **THEN** the resume gives `resumed`, and the run sends its request again

#### Scenario: A refused renewal keeps the work paused

- **GIVEN** a paused run with a run session
- **WHEN** a host resumes it and the host refuses the renewal with the reason `r`
- **THEN** the resume gives `{ kind: "refused", reason: "r" }`, the row stays, and the run sends nothing
