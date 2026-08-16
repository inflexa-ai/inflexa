# report-authoring Specification

## Purpose

Define the authoring surface of a report document under composition. The block
contract defines a valid document, and the mechanical validator does a check of a
whole document. This capability is the producer between the two: an agent composes
a document one operation at a time, and it changes one block in place through its
stable id.

A document under composition is a draft. A draft permits an empty section list and
an empty section, because authoring starts from nothing. An edit refuses a fault, and
the finish refuses a gap. Thus the completeness rules of the
document schema gate one time, at the finish.

Each operation validates with the structural tier of the `report-snapshot`
capability, and it opens no file. The value tier stays with the report gate, and
the `report-grounding` capability defines its seam.

## Requirements

### Requirement: Draft composition from empty
The draft model MUST let a report document grow from an empty draft, one operation at a time. An empty draft and an empty section are legal draft states. The completeness rules of the document schema MUST gate only in the finish operation.

#### Scenario: The first section lands on an empty draft
- **WHEN** the agent adds a section with no child blocks to an empty draft
- **THEN** the operation lands, and the draft holds one empty section

#### Scenario: Completeness does not block an edit
- **WHEN** the agent removes the last child block of a section
- **THEN** the operation lands, and the section stays in the draft with no children

### Requirement: Block addition with an anchor destination
The add operation MUST put a new block at a destination that names a parent and a place. The parent is a section id, or the root when the id is absent. The place is `start`, `end`, `before` an id, or `after` an id. The default place is `end`. The root MUST admit a section only.

An add payload can be a section that carries children, and the validation MUST cover each block of the payload. An anchor implies its parent, and a named parent that disagrees with the anchor MUST refuse with `unknown-target`.

#### Scenario: A section subtree lands in one operation
- **WHEN** the agent adds a section that carries two child blocks
- **THEN** the operation lands, and the validation covers the section and each child

#### Scenario: An atom lands in a section
- **WHEN** the agent adds a metric block with a section id as the parent
- **THEN** the metric lands at the end of that section

#### Scenario: An anchor places a block
- **WHEN** the agent adds a text block with `before` set to the id of a sibling block
- **THEN** the text block lands directly before that sibling

#### Scenario: An atom at the root refuses
- **WHEN** the agent adds a chart block with no parent
- **THEN** the operation refuses with the reason `atom-at-root`, and the draft does not change

#### Scenario: An unknown parent refuses
- **WHEN** the agent adds a block with a parent id that no block holds
- **THEN** the operation refuses with the reason `unknown-target`, and the draft does not change

#### Scenario: An atom as the parent refuses
- **WHEN** the agent adds a block with the id of a metric block as the parent
- **THEN** the operation refuses with the reason `not-a-section`, and the draft does not change

### Requirement: Block change by id
The change operation MUST replace the content of one block, named by its id. For an atom target, the payload is a full atom. The operation stamps the target id on the payload, thus an id mismatch is unrepresentable and the id of the payload does not matter. A kind change is permitted when the payload parses. For a section target, the payload is a title only, and the block field MUST be absent.

#### Scenario: One field changes on a chart
- **WHEN** the agent changes a chart block with the same payload except `chartType` set to `pie`
- **THEN** the block holds `pie`, and its id stays the same

#### Scenario: A table becomes a chart
- **WHEN** the agent changes a table block with a chart payload
- **THEN** the draft holds a chart block at the same id

#### Scenario: A section retitles
- **WHEN** the agent changes a section with a new title and no block field
- **THEN** the section holds the new title, and its children do not change

#### Scenario: A section payload for an atom target refuses
- **WHEN** the agent changes a metric block with a section payload
- **THEN** the operation refuses with the reason `payload-kind-mismatch`

### Requirement: Block removal by id
The remove operation MUST remove one block, named by its id. A removed section takes its whole subtree with it. A removed id is free for a later add.

#### Scenario: A section removal takes the subtree
- **WHEN** the agent removes a section that holds three child blocks
- **THEN** the section and its three children leave the draft

#### Scenario: An unknown id refuses
- **WHEN** the agent removes an id that no block holds
- **THEN** the operation refuses with the reason `unknown-target`

### Requirement: Block movement with an anchor destination
The move operation MUST move one block, named by its id, to a destination with the same shape as the add destination. A section MUST NOT move into its own subtree. A move with the moved block as its own anchor MUST refuse with `unknown-target`.

#### Scenario: A block moves between sections
- **WHEN** the agent moves a figure block from one section to the end of a different section
- **THEN** the figure leaves its old place, and it lands at the new place

#### Scenario: A cycle refuses
- **WHEN** the agent moves a section into one of its own child sections
- **THEN** the operation refuses with the reason `cycle`, and the draft does not change

### Requirement: Validation before a change lands
Each operation MUST validate the result before the change lands. The validation covers the payload grammar, the uniqueness of each id that the payload brings, and the structural resolution of each incoming reference.

The id scan MUST read the payload and not the whole draft. Thus a duplicate that the draft already carries MUST NOT refuse an operation on a different block. Resolution runs against the pinned snapshot with the structural tier. An operation MUST NOT open a file. A refused operation MUST leave the draft as it was.

#### Scenario: A malformed payload refuses
- **WHEN** the agent adds a text block with an extra field in its content
- **THEN** the operation refuses with the reason `malformed-block`, and the detail names the fault

#### Scenario: A duplicate id refuses
- **WHEN** the agent adds a block with an id that the draft already holds
- **THEN** the operation refuses with the reason `duplicate-id`

#### Scenario: An unrelated duplicate does not refuse
- **WHEN** the draft already holds one id two times, and the agent operates on a different block
- **THEN** the operation lands

#### Scenario: A reference outside the snapshot refuses
- **WHEN** the agent adds a metric whose value reference names a path that the snapshot does not hold
- **THEN** the operation refuses with the reason `unresolved-reference`, and the refusal carries each unresolved reference

### Requirement: The hash stamps from the pinned snapshot
The land path of an add and of a change MUST accept an artifact reference that carries the path alone. The land stamps the absent hash from the snapshot entry at that path, before the grammar parse. A path-only reference whose path is not in the snapshot MUST refuse as an unresolved reference, and the refusal names the path. The stamp fills an absent hash only. An explicit hash that differs from the snapshot MUST keep the `hash-mismatch` refusal, because that arm serves a draft that predates a re-pin.

#### Scenario: A path-only reference lands with the snapshot hash
- **WHEN** the agent adds a table block whose binding carries a path in the snapshot and no hash
- **THEN** the block lands, and the persisted reference carries the hash of the snapshot entry

#### Scenario: An unknown path refuses and names the path
- **WHEN** the agent adds a block whose binding carries a path that the snapshot does not hold, and no hash
- **THEN** the operation refuses as an unresolved reference, and the detail names the path

#### Scenario: A stale explicit hash still refuses as a mismatch
- **WHEN** the agent adds a block whose binding carries a hash that differs from the snapshot entry
- **THEN** the operation refuses with the `hash-mismatch` reason

#### Scenario: A derivation input stamps too
- **WHEN** the agent adds a metric whose derivation inputs carry paths in the snapshot and no hashes
- **THEN** the block lands, and each input carries the hash of its snapshot entry

### Requirement: A refusal is typed data in the ok channel
A refused operation MUST return typed data in the ok channel of the tool result. The refusal carries a reason from a closed set, and a prose detail. An operation MUST NOT throw for an expected refusal.

A destination that names two places at one time MUST refuse with `conflicting-destination`, and not with `unknown-target`. The two faults need different repairs: `unknown-target` means that no block holds a named id, and `conflicting-destination` means that the agent must drop one of the fields it gave.

#### Scenario: The agent reads the reason
- **WHEN** an operation refuses
- **THEN** the tool result is ok data with `applied: false`, the reason, and the detail

#### Scenario: A conflicting destination names its own fault
- **WHEN** the agent names both `before` and `after` in one destination
- **THEN** the operation refuses with the reason `conflicting-destination`

### Requirement: Read-back without the full tree
The read surface MUST give an outline of the draft, and one block by its id. An outline entry carries the id, the kind, the nesting, and a short label. It carries no binding and no full prose.

A landed operation MUST return the child order of each container that it changed, and it MUST NOT return the whole outline. The whole outline costs the size of the draft on each landing. Thus a report of n blocks spends n-squared outline entries of agent context to author it. The agent chose the id of its own block, and no other branch moved. Thus the container that the operation touched is the one thing that a landing can tell it.

A move across two containers reports both, and an operation that changes no child order reports none. The read of the whole outline stays one call away.

The label of every block kind MUST clip, because a title, a caption, and a note are free prose too. A clipped label MUST carry a marker, thus the agent can tell a clipped label from a whole one. The clip MUST count code points, thus it never splits a character.

A read of a section MUST give the title of the section and the id of each child, and never the subtree. The outline already names every block under the section. Thus a subtree returns the tree that the outline exists to keep out of the context.

#### Scenario: The outline stays small
- **WHEN** the agent reads the outline of a draft with a long claim block
- **THEN** the outline entry for the claim carries a clipped label, and not the full prose

#### Scenario: One block reads in full
- **WHEN** the agent reads an atom by its id
- **THEN** the result carries the full block, with its bindings

#### Scenario: A section reads shallow
- **WHEN** the agent reads a section by its id
- **THEN** the result carries the title of the section and the id of each child, and no child block

#### Scenario: A clipped label carries a marker
- **WHEN** the agent reads the outline of a draft with a long section title
- **THEN** the label is clipped, and it ends with a marker

#### Scenario: A landed change returns the container that it changed
- **WHEN** an add operation lands inside a section
- **THEN** the tool result carries `applied: true` and the child order of that section, and no block of a different section

#### Scenario: A move across two sections returns both
- **WHEN** a move operation takes a block from one section to a different section
- **THEN** the tool result carries the child order of the section that the block left and of the section that it reached

### Requirement: The finish operation
The finish operation MUST validate the whole draft against the full document schema, the id rule, and the structural tier. It MUST report each gap as data. When the draft passes, it MUST give the valid `ReportDocument` value. The finish MUST NOT open a file, and it MUST NOT change the draft. The finish runs the structural tier only, and the value-tier gate of the report pipeline is a different capability.

The finish MUST also carry each advisory warning, in both outcomes. A free numeral in prose is such a warning: it needs no file, thus the finish scans for it. A warning MUST NOT decide the outcome.

The finish MUST list each unused derivation as an advisory warning: a derivation record whose output path no binding of the document names. The warning names the output path, and it decides no outcome, exactly as a free-numeral warning does.

#### Scenario: An empty section is a gap at the finish
- **WHEN** the agent finishes a draft that holds one empty section
- **THEN** the finish reports the empty section as a gap, and it gives no document

#### Scenario: A complete draft finishes
- **WHEN** the agent finishes a draft that passes every rule
- **THEN** the finish gives the document value, and the draft stays as it is

#### Scenario: An untitled draft is a gap at the finish
- **WHEN** the agent finishes a draft that carries no title
- **THEN** the finish reports the title as a gap, and it gives no document

#### Scenario: A free numeral warns
- **WHEN** the agent finishes a draft whose prose carries a figure with no metric block behind it
- **THEN** the finish carries a warning for that block, and the warning does not change the outcome

#### Scenario: An unused derivation warns

- **WHEN** the finish runs over a document that ignores one derivation record
- **THEN** the finish carries a warning that names the unused output, and the outcome stays as the gaps decide

#### Scenario: A used derivation warns nothing

- **WHEN** every derivation output is named by a binding
- **THEN** the finish carries no derivation warning

### Requirement: The authoring tool surface
The operations MUST ship as harness tools, made with `defineTool` through one factory. The factory closes over a session-state gateway and reads no other ambient state. A tool MUST read the thread id from the scope of the call, and it MUST load the state through the gateway. A landed document MUST persist before the tool reports. A call whose scope carries no thread id MUST refuse as typed data in the ok channel.

The surface MUST give an operation that sets the title of the document. A draft starts with no title, thus without the operation every report finishes untitled or never finishes.

The published input schema of a block payload MUST carry the block grammar. A tool is self-describing at attach time. Thus a payload with no schema leaves the agent to discover each field through one refusal at a time. The runtime parse of the payload stays permissive, thus a malformed block still comes back as a typed refusal.

Each tool MUST declare the inline execution mode. The state loads fresh on each call, thus a replay-cached tool result reports a document that later operations changed.

#### Scenario: The factory packages the tools
- **WHEN** a caller gives the factory a session-state gateway
- **THEN** the caller gets the authoring tools, and each tool operates on the state of its own thread only

#### Scenario: A landed operation persists before the report
- **WHEN** an add operation lands on a thread
- **THEN** the gateway holds the new document before the tool result reports `applied: true`

#### Scenario: Two threads stay isolated through one factory
- **WHEN** two threads each add a block through one factory
- **THEN** the outline of each thread holds only its own block

#### Scenario: The agent titles the report
- **WHEN** the agent sets the title of the draft
- **THEN** the draft holds the new title, and the finish reports no title gap

#### Scenario: The payload schema names each block kind
- **WHEN** a caller reads the published input schema of the add operation
- **THEN** the schema carries each of the eight block kinds and the fields of each one
