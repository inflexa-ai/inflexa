# Delta: report-observation-seam

## MODIFIED Requirements

### Requirement: The report session emits observation events
The report session MUST emit one typed event for each of these actions, when the seam is bound:

- make a session, of the kind `conversation` or of the kind `report`
- add a block
- change a block
- remove a block
- move a block
- set the title
- run a derivation
- preview the page
- record a version

Each event carries the analysis id, the thread id, and the data of its action. A block event names the block id. The set-title event targets the document, and it carries no block id.

The `create-session` event MUST come from the site that writes the thread row, one time for each session. The site emits it after the row lands, and before any act of that session. A refused write emits nothing, because no session exists. The store of the threads MUST NOT emit, because the state layer knows no seam.

The `create-session` event MUST name the kind of the session, and it MUST name the parent thread of a child session. Thus the document of the analysis tells the whole tree of the sessions. A reader walks that tree with no second read of the seam. A root session has no parent, thus the event carries none.

#### Scenario: The creation of a conversation emits
- **WHEN** the turn writes a new conversation thread and the seam is bound
- **THEN** the seam receives one `create-session` event with the kind `conversation`, and with no parent thread id

#### Scenario: A turn on a thread that exists emits nothing
- **WHEN** the turn runs on a conversation thread that the store already holds
- **THEN** the seam receives no `create-session` event

#### Scenario: The creation of a report session emits
- **WHEN** the spawn of a report session succeeds and the seam is bound
- **THEN** the seam receives one `create-session` event with the kind `report`, the new thread id, and the parent thread id

#### Scenario: A block action emits
- **WHEN** the agent adds a block and the seam is bound
- **THEN** the seam receives one event with the action, the block id, the analysis id, and the thread id

#### Scenario: The set-title action emits
- **WHEN** the agent sets the title and the seam is bound
- **THEN** the seam receives one event that targets the document, with no block id
