## ADDED Requirements

### Requirement: A report is a tree of typed blocks

The report document MUST be a tree of blocks, not a flat list. Each block MUST carry
a stable `id` and a `kind` discriminant. A block MUST be addressable by its `id`
across a version.

#### Scenario: A well-formed tree validates

- **WHEN** a document holds a root of blocks, each with an `id` and a `kind`
- **THEN** the block model validates the document as a tree

#### Scenario: A block without an id is rejected

- **WHEN** a block has a `kind` but no `id`
- **THEN** validation rejects the block

#### Scenario: A block without a kind is rejected

- **WHEN** a block has an `id` but no `kind`
- **THEN** validation rejects the block

### Requirement: The block set is a closed discriminated union

The `kind` field MUST be one of `section`, `text`, `claim`, `metric`, `table`,
`chart`, `figure`, or `citation`. The union MUST discriminate on `kind`. An unknown
`kind` MUST fail validation.

#### Scenario: Each of the eight kinds validates

- **WHEN** a document holds one block of each of the eight kinds, each well-formed
- **THEN** validation accepts every block

#### Scenario: A nested section validates

- **WHEN** a `section` holds another `section` that holds a `claim`
- **THEN** validation accepts the nested tree

#### Scenario: An unknown kind is rejected

- **WHEN** a block carries a `kind` that is not one of the eight
- **THEN** validation rejects the block

### Requirement: A content grammar constrains nesting

The grammar MUST define which block can hold which. A `section` MUST hold any block
kind. A `text` block and a `claim` block MUST be leaves that hold inline text only. A
`table`, a `chart`, a `figure`, and a `metric` MUST be atoms with no block children.
The root MUST hold at least one section, and a `section` MUST hold at least one
block.

#### Scenario: A chart inside a metric is rejected

- **WHEN** a `metric` block holds a `chart` block as a child
- **THEN** validation rejects the document for a grammar violation

#### Scenario: A claim inside a section validates

- **WHEN** a `section` holds a `claim` block
- **THEN** validation accepts the block

#### Scenario: An empty report is rejected

- **WHEN** a document holds a root with no section
- **THEN** validation rejects the document

#### Scenario: An empty section is rejected

- **WHEN** a `section` holds no block
- **THEN** validation rejects the section

### Requirement: Each evidentiary kind carries a binding field

A `claim`, a `metric`, a `table`, a `chart`, a `figure`, and a `citation` MUST each
carry a non-empty binding field. The type MUST enforce the presence, not a lint
rule. A `text` block MUST NOT carry a binding. A `metric` MUST carry exactly one
scalar binding. The resolution of a binding is the concern of the `report-grounding`
capability.

#### Scenario: A claim with no binding is rejected

- **WHEN** a `claim` block carries no binding
- **THEN** validation rejects the block at the type level

#### Scenario: A text block with a binding is rejected

- **WHEN** a `text` block carries a binding
- **THEN** validation rejects the block

#### Scenario: A metric with two bindings is rejected

- **WHEN** a `metric` block carries two bindings
- **THEN** validation rejects the block, because a metric carries exactly one scalar binding
