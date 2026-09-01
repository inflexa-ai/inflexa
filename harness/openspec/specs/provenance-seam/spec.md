# provenance-seam Specification

## Purpose

Define the one provenance surface of the harness: the run emit, the session
emit, and the document read, as one optional seam. The embedder owns the
signed provenance document of the analysis, and the report events belong in
that same document. The harness holds no provenance format, thus it emits
typed events, gives the document back as opaque bytes, and keeps no ledger of
its own.

## Requirements

### Requirement: One seam carries the provenance surface

The harness MUST declare one `ProvenanceSeam` type with three optional
members: the run emit, the session emit, and the document read. Each member
is optional alone, and the harness treats an absent member as absence, never
as an error. The code of the harness never branches on which realization is
bound. The run emit keeps its `RunSession` parameter, because a durable run
carries one. A session act carries no session, thus the session emit takes
the event alone.

#### Scenario: A partial binding works

- **WHEN** the composition binds only the session emit
- **THEN** the session acts emit, the run events go nowhere, and the page
  carries no document asset

#### Scenario: The run emit receives the session

- **WHEN** the workflow emits a run event through the bound member
- **THEN** the member receives the event and the `RunSession` of the run

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
SHA-256 hash of the exact bytes, the size in bytes, and the tool name. A
refused write and a failed write emit nothing.

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

### Requirement: The emits are fire-and-forget

An emit MUST NOT block the action, and a seam failure MUST NOT fail the
action. The harness does not read a result from an emit member. When a member
is not bound, no event is emitted, and each action proceeds unchanged.

#### Scenario: A seam failure does not fail the action

- **WHEN** a bound emit member throws
- **THEN** the action completes, and the failure is logged

#### Scenario: The member is not bound

- **WHEN** the composition binds no emit member
- **THEN** each action proceeds, and no event is emitted

### Requirement: The document read gives opaque bytes

The document read MUST give the current provenance document and its
attestation as opaque bytes, for one analysis, or absence. The harness MUST
NOT parse the bytes. Thus the format belongs to the writer, and a format
change costs the harness nothing.

#### Scenario: The read gives a document

- **WHEN** the preview asks the bound member for the analysis
- **THEN** the member gives the document bytes and the attestation bytes

#### Scenario: The read gives absence

- **WHEN** the bound member has no document for the analysis
- **THEN** the preview proceeds, and the page carries no document asset

### Requirement: The preview exports the document into the page assets

The preview MUST write the document and the attestation as content-addressed
script assets that register one page global. The asset name derives from the
content hash, thus an unchanged document writes the same asset. The sweep
keeps the assets of the run, and a stale document asset is swept. When the
read member is not bound, the preview writes no document asset.

#### Scenario: The document rides the page

- **WHEN** the preview renders with a bound read that gives a document
- **THEN** the assets hold the document and the attestation as script assets,
  and the page loads them

#### Scenario: The document changes between previews

- **WHEN** a second preview runs after the document changes
- **THEN** the new asset lands under a new name, and the sweep removes the
  old asset

#### Scenario: The page opens offline

- **WHEN** the rendered page opens through `file://`
- **THEN** the document loads through the script asset, with no fetch of a
  local file
