## RENAMED Requirements

- FROM: `### Requirement: The hash stamps from the pinned snapshot`
- TO: `### Requirement: The snapshot owns every reference hash`

## MODIFIED Requirements

### Requirement: The snapshot owns every reference hash
The authoring input of an artifact reference MUST carry the path and no hash field. The land path of an add and of a change stamps the hash from the snapshot entry at that path, before the grammar parse. A hash that a payload carries anyway MUST drop before the stamp, thus an echoed stored binding cannot mismatch. A path that is not in the snapshot MUST refuse as an unresolved reference, and the refusal names the path. The stored reference keeps its stamped hash, thus the grounding contract does not change, and the resolution still compares the pin against the fresh read.

#### Scenario: A path-only reference lands with the snapshot hash
- **WHEN** the agent adds a table block whose binding carries a path in the snapshot and no hash
- **THEN** the block lands, and the persisted reference carries the hash of the snapshot entry

#### Scenario: An echoed hash is dropped and stamped again
- **WHEN** the agent changes a block with a payload that carries a stale or mistyped hash
- **THEN** the operation lands, and the persisted reference carries the hash of the snapshot entry

#### Scenario: An unknown path refuses and names the path
- **WHEN** the agent adds a block whose binding carries a path that the snapshot does not hold
- **THEN** the operation refuses as an unresolved reference, and the detail names the path

#### Scenario: A derivation input stamps too
- **WHEN** the agent adds a metric whose derivation inputs carry paths in the snapshot and no hashes
- **THEN** the block lands, and each input carries the hash of its snapshot entry

### Requirement: Read-back without the full tree
The read surface MUST give an outline of the draft, and one block by its id. An outline entry carries the id, the kind, the nesting, and a short label. It carries no binding and no full prose.

A read of a block MUST elide the stamped hash of each binding. The snapshot owns the hash, thus an echo-back must not carry one, and the agent never sees a value it could mistype.

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

#### Scenario: A block reads hash-free
- **WHEN** the agent reads an atom whose bindings carry stamped hashes
- **THEN** the result carries each binding with its path and locator, and no hash field

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

The finish MUST also carry each advisory warning, in both outcomes. A free numeral in prose is such a warning: it needs no file, thus the finish scans for it. A prose numeral in an exponent form that the number helper would never print MUST warn too. Thus the prose notation and the page notation cannot drift silently. A warning MUST NOT decide the outcome.

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

#### Scenario: A drifted exponent form warns
- **WHEN** a prose sentence writes `4.3e-05` where the helper prints `4.3e-5`
- **THEN** the finish carries a warning that names the block, and the outcome stays as the gaps decide

#### Scenario: An unused derivation warns
- **WHEN** the finish runs over a document that ignores one derivation record
- **THEN** the finish carries a warning that names the unused output, and the outcome stays as the gaps decide

#### Scenario: A used derivation warns nothing
- **WHEN** every derivation output is named by a binding
- **THEN** the finish carries no derivation warning
