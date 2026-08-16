# report-block-model Specification

## Purpose

Define the composable block tree that a report is made of. A report is a tree of
typed blocks, not a flat list of sections. A `section` is itself a block, and it
nests. Thus a new report shape is a new arrangement of existing blocks, and not a
new type.

The block set is closed. Each block carries a stable `id` and a `kind`
discriminant, and the shape of each kind carries its own grammar. A `text` block
holds no binding field, a `metric` value slot admits one scalar reference only, and
no atom holds a child-block array. Thus a forbidden construction is unrepresentable,
and a schema parse rejects it. The grammar is the shape, and not a separate pass
that runs later.

The resolution of a binding is the concern of the `report-grounding` capability.
This capability defines which block carries a binding, and where a block can sit.

## Requirements

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

### Requirement: The chart grammar
A chart block MUST carry either the quick path or the composition, and never both. The quick path is one chart type with one encoding. The composition holds one or more series, optional annotations, and optional axes. A series has a form (`line`, `scatter`, `bar`, `area`, `step`) and its own column encoding. An `area` series can name a `y0` lower-bound column. A channel is a column name, or a column with a per-row transform (`log10`, `neg_log10`, `abs`, `rank`). The encoding can name a `label` column for the identity of a point.

The annotations are typed members. A reference line names an axis and a constant. A reference band names an axis and two constants. Point labels name a rank rule over a named column, with a bounded count. The chart type enum holds the seven base types and the presets `volcano`, `manhattan`, `ma`, and `km`.

The bar MUST admit an optional orientation: `vertical`, the default, and `horizontal`. The quick path carries the orientation beside the chart type, and the composition carries it on the bar series form. The channels keep their data meaning in both orientations: `x` names the category column, and `y` names the value column. An orientation beside a quick-path type that is not a bar is an authoring fault.

The grammar MUST keep the fabrication holes unrepresentable. No member carries a data literal, and no member carries script text. The structural tier MUST refuse a grammar column that the bound table does not hold.

#### Scenario: The quick path and the composition exclude each other
- **WHEN** a chart block carries a chart type and a composition together
- **THEN** the parse fails

#### Scenario: A transform channel parses
- **WHEN** a chart series maps y onto a p-value column through `neg_log10`
- **THEN** the block parses, and the channel carries the column with the transform

#### Scenario: A data literal is unrepresentable
- **WHEN** a composition member carries an array of numbers as series data
- **THEN** the parse fails, because no member admits a data literal

#### Scenario: A grammar column outside the table refuses
- **WHEN** a series channel names a column that the bound table does not hold
- **THEN** the structural tier refuses the block before a landing

#### Scenario: A preset parses on the quick path
- **WHEN** a chart block carries the `volcano` type with an effect column, a p column, and a label column
- **THEN** the block parses on the quick path

#### Scenario: A horizontal bar validates
- **WHEN** the author binds a quick-path `bar` with the `horizontal` orientation
- **THEN** the block validates, and the orientation rides the stored document

#### Scenario: An orientation on a non-bar refuses
- **WHEN** the author states an orientation beside the `line` chart type
- **THEN** the render refuses with a problem that names the fault

#### Scenario: An absent orientation stays vertical
- **WHEN** a stored bar block carries no orientation
- **THEN** the block validates, and the chart renders exactly as before

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

### Requirement: A table binding declares its column meanings

A whole-table binding MUST admit two optional maps, keyed by the column name: a meaning, and a display label. The meanings are a closed set: `p-value`, `effect`, `count`, `identifier`, and `category`. A meaning states what the column is, and it is not a format. No block carries a format field.

The field descriptions MUST teach the declaration, because the authoring tools carry the schema to the agent. A key that names no column of the artifact is ignored, because absence is a normal condition.

#### Scenario: A binding declares a meaning and a label

- **WHEN** the author binds a table and declares one column as a `p-value` with a display label
- **THEN** the block validates, and the declaration rides the stored document

#### Scenario: An unknown key changes nothing

- **WHEN** a declaration names a column that the artifact does not hold
- **THEN** the render proceeds, and the stray key has no effect
