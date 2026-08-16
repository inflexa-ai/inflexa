## MODIFIED Requirements

### Requirement: The chat shows an entry point into each report child at its anchor
The chat MUST show an openable entry for each report child of the open conversation. The entry MUST sit below the turn that asked for the session. The entry MUST open that child in place.

The entry MUST derive from the thread listing alone. It MUST NOT read a tool result, and no new harness data part is necessary. Thus a child that a different host spawned appears the same way.

The listing MUST read again after the turn that spawns a child settles. The open thread does not change at a spawn. Thus a read that tracks the open thread alone shows nothing until the user leaves the conversation.

The anchor is a store sequence number, and the loaded transcript holds no such number. The load reads each stored message with its sequence number, and the conversion to the display messages drops it. Thus the load path MUST pair each sequence number with the identity of the message that its row ends on. The pair MUST hold an identity and not a position, because a live append drops a message off the front at the cap.

The anchor names the last stored row BEFORE the turn that asked for the session. The spawn runs inside that turn, and the append of the turn lands after the spawn. Thus a placement at the anchor paints the entry above the words that asked for the report. The entry MUST instead sit after the reply of the turn that crosses the anchor: the first assistant message at or past the first pair above the anchor. When no assistant message sits at or past that pair, the entry MUST render at the end of the mounted transcript. The rule holds on a live transcript and on a reloaded one alike.

Two states still reach the end position, and both belong there. An anchor past every loaded pair is one. The other is a session that the newest turn spawned, before any of its rows load.

The transcript mounts the newest turns alone, thus an anchor below the mounted window is a normal state. The entry MUST then render at the top. A pair whose message the mounted window no longer holds MUST read the same way. A listing failure MUST show no entry, and it MUST NOT break the transcript. An archived child MUST show no entry, because the listing reads the live children alone.

#### Scenario: An entry sits below its request

- **WHEN** the open conversation holds a report child whose anchor names a loaded position
- **THEN** the entry renders after the reply of the turn that crossed the anchor, below the request

#### Scenario: A reloaded transcript keeps the entry below the request

- **WHEN** the transcript reloads after a turn that spawned a report child
- **THEN** the entry renders after the reply of that turn, and never above the message that asked

#### Scenario: A session that a turn spawns gets its entry

- **WHEN** a turn of the open conversation spawns a report child and that turn settles
- **THEN** the transcript shows an entry for that child, and the open thread does not change

#### Scenario: The entry opens the child

- **WHEN** the user opens the entry
- **THEN** the chat swaps onto that report child in place

#### Scenario: An anchor past the loaded transcript renders at the end

- **WHEN** the anchor of a report child names a position past the loaded transcript
- **THEN** the entry renders at the end, and nothing throws

#### Scenario: A session that the newest turn spawned sits below the request

- **WHEN** the newest turn of the open conversation spawns a report child, and none of its rows are loaded
- **THEN** the entry renders at the end of the mounted transcript, below the request that asked for the report

#### Scenario: An anchor below the mounted window renders at the top

- **WHEN** the anchor of a report child names a position older than the mounted window
- **THEN** the entry renders at the top, and nothing throws

#### Scenario: A failed listing leaves the transcript whole

- **WHEN** the listing of the report children fails
- **THEN** the transcript renders with no entry, and no error reaches the user as a crash

#### Scenario: An archived child shows no entry

- **WHEN** a report child of the open conversation is archived
- **THEN** the transcript shows no entry for that child, and each other child keeps its entry
