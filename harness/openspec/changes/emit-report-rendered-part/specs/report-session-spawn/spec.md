## MODIFIED Requirements

### Requirement: The tool announces a started session as one durable chat part

When the spawn succeeds, `start_report_session` SHALL emit one `data-child-session-started` part through the emit sink of its tool context. The part SHALL carry the `threadId` of the child, the `parentThreadId` of the conversation, and the `threadType` of the child in the thread store's vocabulary (`"report"` for a report session). The `threadType` field SHALL be a plain string and not an enum, thus a future session type does not fail validation in an older consumer. The tool SHALL NOT emit the part on the existing-session arm or on a refusal, because those arms start no session.

The part SHALL be a durable conversation part in the part registry, thus the display projection of the turn persists it in the position of its emission. A reload then shows the entry at the spawn point, and no message `seq` rides the wire.

The part is a placement record and a freshness signal only. The thread store SHALL stay the authority for the session: its existence, its title, and its archived state. A consumer whose part names an archived or absent thread SHALL render nothing for it.

#### Scenario: A started session emits one part

- **WHEN** the agent calls `start_report_session` and the spawn succeeds
- **THEN** the tool emits exactly one `data-child-session-started` part, and the part carries the thread id of the child, the thread id of the parent conversation, and the thread type `"report"`

#### Scenario: The existing-session arm emits nothing

- **GIVEN** a parent whose newest report child sits at or past the last user turn
- **WHEN** the agent calls the tool and the advice names that child
- **THEN** the tool emits no part

#### Scenario: A refusal emits nothing

- **WHEN** the tool refuses a call, for any refusal arm
- **THEN** the tool emits no part

#### Scenario: The part persists into the display projection

- **GIVEN** a turn whose loop records the conversation display
- **WHEN** the tool emits the part between two text runs
- **THEN** the persisted display of the turn holds the part between the two text runs
