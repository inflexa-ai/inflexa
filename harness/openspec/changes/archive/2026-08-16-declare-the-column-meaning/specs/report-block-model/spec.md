# Delta: report-block-model

## ADDED Requirements

### Requirement: A table binding declares its column meanings

A whole-table binding MUST admit two optional maps, keyed by the column name: a meaning, and a display label. The meanings are a closed set: `p-value`, `effect`, `count`, `identifier`, and `category`. A meaning states what the column is, and it is not a format. No block carries a format field.

The field descriptions MUST teach the declaration, because the authoring tools carry the schema to the agent. A key that names no column of the artifact is ignored, because absence is a normal condition.

#### Scenario: A binding declares a meaning and a label

- **WHEN** the author binds a table and declares one column as a `p-value` with a display label
- **THEN** the block validates, and the declaration rides the stored document

#### Scenario: An unknown key changes nothing

- **WHEN** a declaration names a column that the artifact does not hold
- **THEN** the render proceeds, and the stray key has no effect
