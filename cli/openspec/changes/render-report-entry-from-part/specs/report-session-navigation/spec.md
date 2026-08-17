## MODIFIED Requirements

### Requirement: The chat shows an entry point into each report child at its anchor

The chat MUST show an openable entry for each live report child of the open conversation. The entry
MUST open that child in place.

The anchor is the persisted `data-report-session-started` part. The harness records the part into
the turn at the position of the spawn, thus the mounted transcript states the position and the TUI
computes none. The entry MUST render where the part sits.

The part names the child, and the listing describes it. The entry MUST join the live report-children
listing by the thread id of the part, and it MUST read the title and the last-activity stamp off the
row. The listing is the authority for the session — its existence, its title, and its archived
state. A part whose row the listing does not hold MUST render nothing: an archived child leaves the
transcript at the next refresh, and a failed listing shows no entry without breaking the transcript.

A live child that no mounted part claims MUST render at the end of the mounted transcript. Two
states reach it, and both belong there: a session spawned before the part became durable carries no
part, and a part whose message left the mounted window is not mounted. The tail keeps both
reachable.

The listing MUST read again when the part arrives on the live stream, thus the entry paints inside
the turn that spawned the session. The listing MUST also read again after the turn settles, because
the title of the child is seeded after its first message. The open thread does not change at a
spawn.

#### Scenario: An entry sits at its spawn part

- **WHEN** the open conversation holds a report child whose spawn part is mounted
- **THEN** the entry renders at the position of the part, inside the turn that spawned the session

#### Scenario: A reloaded transcript keeps the entry at its part

- **WHEN** the transcript reloads after a turn that spawned a report child
- **THEN** the entry renders at the position of the persisted part, with the title from the listing

#### Scenario: A session that a turn spawns gets its entry inside the turn

- **WHEN** a turn of the open conversation spawns a report child
- **THEN** the transcript shows the entry when the part arrives, and the open thread does not change

#### Scenario: The entry opens the child

- **WHEN** the user opens the entry
- **THEN** the chat swaps onto that report child in place

#### Scenario: A child with no claiming part renders at the end

- **WHEN** a live report child has no mounted spawn part
- **THEN** the entry renders at the end of the mounted transcript, and nothing throws

#### Scenario: A part without its row renders nothing

- **WHEN** a mounted spawn part names a thread that the live listing does not hold
- **THEN** no entry renders for it, and each other child keeps its entry

#### Scenario: A failed listing leaves the transcript whole

- **WHEN** the listing of the report children fails
- **THEN** the transcript renders with no entry, and no error reaches the user as a crash

#### Scenario: An archived child shows no entry

- **WHEN** a report child of the open conversation is archived
- **THEN** the transcript shows no entry for that child, and each other child keeps its entry
