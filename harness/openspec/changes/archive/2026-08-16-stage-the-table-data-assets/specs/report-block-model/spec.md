# Delta: report-block-model

## MODIFIED Requirements

### Requirement: A table binding declares its column meanings

A whole-table binding MUST also admit an optional row bound as content: the top N rows by a named column, with `desc` as the default order. The bound rows are the table: the resolution applies the bound, thus every reader of the binding sees one bounded set. A bound whose column the artifact does not hold refuses at the structural tier.

#### Scenario: A bounded binding validates

- **WHEN** the author binds a table with a row bound of the top 20 rows by a p-value column
- **THEN** the block validates, and the bound rides the stored document

#### Scenario: The bound applies at resolution

- **WHEN** a bounded binding resolves against a table of 14,201 rows
- **THEN** the resolved table holds the 20 bounded rows, sorted by the named column

#### Scenario: A bound over an unknown column refuses

- **WHEN** a row bound names a column that the artifact does not hold
- **THEN** the structural tier refuses the block before a landing
