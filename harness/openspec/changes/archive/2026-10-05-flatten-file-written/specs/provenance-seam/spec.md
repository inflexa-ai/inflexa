# provenance-seam — delta

## MODIFIED Requirements

### Requirement: The session emits observation events

The harness MUST emit one typed session event for each of these actions, when
the member is bound:

- make a session, of the kind `conversation` or of the kind `report`
- add a block
- change a block
- remove a block
- move a block
- set the title
- run a derivation
- preview the page
- record a version
- write a file with a file tool, from a conversation turn

Each event carries the analysis id and the data of its action. Each event
except `write-file` carries the thread id. The `write-file` event carries the
thread id when the scope of the session holds one.

A block event names the block id and the kind of the block. On a change, the
event records the kind after the act, because a kind change is permitted. On
a remove, the event records the kind of the removed block. The set-title
event targets the document, and it carries no block id.

The `create-session` event MUST come from the site that writes the thread
row, one time for each session. The site emits it after the row lands, and
before any act of that session. A refused write emits nothing, because no
session exists. The store of the threads MUST NOT emit, because the state
layer knows no seam.

The `create-session` event MUST name the kind of the session, and it MUST
name the parent thread of a child session. Thus the document of the analysis
tells the whole tree of the sessions. A reader walks that tree with no second
read of the seam. A root session has no parent, thus the event carries none.

The `write-file` event MUST come from the mutate seam of the conversation
agent, after the bytes land. It carries the analysis-root-relative path, the
SHA-256 hash of the exact bytes, the size in bytes, and the tool name. It
also carries the `invocationId` of the tool call. The invocation id is the
replay-stable identity of the write, and the consumer keys the deterministic
call activity on it. A refused write and a failed write emit nothing.

#### Scenario: The creation of a conversation emits

- **WHEN** the turn writes a new conversation thread and the member is bound
- **THEN** the member receives one `create-session` event with the kind
  `conversation`, and with no parent thread id

#### Scenario: A turn on a thread that exists emits nothing

- **WHEN** the turn runs on a conversation thread that the store already
  holds
- **THEN** the member receives no `create-session` event

#### Scenario: The creation of a report session emits

- **WHEN** the spawn of a report session succeeds and the member is bound
- **THEN** the member receives one `create-session` event with the kind
  `report`, the new thread id, and the parent thread id

#### Scenario: A block act names its kind

- **WHEN** the agent adds a chart block and the member is bound
- **THEN** the member receives one event with the action, the block id, the
  kind `chart`, the analysis id, and the thread id

#### Scenario: The set-title action emits

- **WHEN** the agent sets the title and the member is bound
- **THEN** the member receives one event that targets the document, with no
  block id

#### Scenario: A conversation file write emits

- **WHEN** a `write_file` call of the conversation agent lands its bytes and
  the member is bound
- **THEN** the member receives one `write-file` event with the analysis id,
  the thread id, the path, the hash, the size, and the tool `write_file`
- **AND** the event carries the invocation id of the call
