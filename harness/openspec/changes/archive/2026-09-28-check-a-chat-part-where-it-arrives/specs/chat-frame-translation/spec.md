## ADDED Requirements

### Requirement: A part frame is checked where it arrives

The harness MUST export `checkChatPart(frame)`. For a type that the registry knows, it MUST check the frame against the schema of that type. It MUST give the parsed part and keep the source, or give the error. A field that the schema does not know MUST NOT stay in the part. A type that the registry does not know MUST pass unchanged, because a newer emitter can send it.

A consumer MUST check each live part frame one time, where it arrives. After the check, the consumer MUST read the part through its harness type, and not as `unknown`.

#### Scenario: A known part that its schema rejects

- **GIVEN** a `data-ask` frame with the status `maybe`
- **WHEN** `checkChatPart` checks it
- **THEN** the result is an error

#### Scenario: A part of an unknown type

- **GIVEN** a frame of a type that the registry does not know
- **WHEN** `checkChatPart` checks it
- **THEN** the frame passes unchanged

### Requirement: The stored plan card keeps each step field that the card shows

A plan step of a `data-plan` part MUST accept the optional fields `track`, `step_type`, `acceptance_criteria`, `constraints`, `caveats`, and `resources.gpu`. The display recorder MUST keep them, thus a reloaded plan card shows the same steps as the live card.

#### Scenario: A reloaded plan keeps its acceptance criteria

- **GIVEN** a `data-plan` part whose step has acceptance criteria, constraints, caveats, a track, a step type, and a GPU count
- **WHEN** the recorder stores the turn
- **THEN** the stored step holds each of those fields
