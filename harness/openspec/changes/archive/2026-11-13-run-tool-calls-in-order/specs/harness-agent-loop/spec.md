## ADDED Requirements

### Requirement: The calls of one reply that are not concurrent run one at a time, in order

The loop MUST run each call of a tool that does not declare `concurrent: true` alone. Such calls MUST run in the order of the reply. A call of a concurrent tool MUST NOT wait for another call. The order applies to one series of requests. A call of one run MUST NOT wait for a call of a different run, of a different session, or of a sub-agent.

The wait for the turn of a call MUST be inside the durable step of the call. The duration of the call MUST NOT include the wait.

#### Scenario: Two edits of one file in one reply

- **GIVEN** a file that holds `alpha beta`
- **WHEN** one reply calls `edit_file` two times on the file, the first call replaces `alpha` and the second call replaces `beta`
- **THEN** the file holds both replacements
- **AND** each call gives `ok`

#### Scenario: Calls that are not concurrent do not overlap

- **WHEN** one reply calls a tool that is not concurrent two times, and each call runs for 100 ms
- **THEN** the second call starts after the first call ends
- **AND** each `tool-finished` event reports about 100 ms

#### Scenario: Concurrent calls overlap

- **WHEN** one reply calls a concurrent tool two times, and each call runs for 100 ms
- **THEN** the two calls run at the same time

#### Scenario: Two runs do not wait for each other

- **WHEN** two runs each call a tool that is not concurrent, at the same time
- **THEN** the two calls run at the same time
