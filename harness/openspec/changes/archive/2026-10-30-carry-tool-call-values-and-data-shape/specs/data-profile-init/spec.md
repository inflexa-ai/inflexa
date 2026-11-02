## ADDED Requirements

### Requirement: The snapshot carries the dimensions of the primary matrix

`DataProfileResult` MUST have the optional field `shape` `{ rows: number; rowUnit: string; columns: number; columnUnit: string }`. The field holds the dimensions of a matrix, and not the form of the record. The contracts MUST export its type as `DataProfileShape`. `shape` describes the primary matrix of the full dataset, for example `{ rows: 61533, rowUnit: "genes", columns: 28, columnUnit: "samples" }`.

`submit_profile` MUST accept an optional `shape` of the same form. `rows` and `columns` MUST be positive integers, and `rowUnit` and `columnUnit` MUST be text that is not empty. The tool MUST refuse a submission whose `shape` breaks one of these rules, with an error that names the field. `buildDataProfileResult` MUST copy an accepted `shape` to the snapshot. A submission with no `shape` MUST give a snapshot with no `shape` key.

The profiler prompt MUST tell the agent these rules:

- The primary matrix is the matrix that holds the measurements of the dataset, for example the count matrix of an expression dataset. A metadata table or a sample sheet is not a primary matrix.
- The agent leaves `shape` out when the dataset holds no such matrix. It also leaves it out when different matrices hold different measurements and none is clearly primary.
- The agent measures the shape in the sandbox, with a method that reads no more than a line count. Examples are a line count of a delimited text, a Matrix Market header, and the metadata of an HDF5 or a Parquet file.
- The shape describes the full dataset. When each sample is a file of its own, the count of those files is one dimension.
- `rowUnit` and `columnUnit` name what one row and one column represent, for example `genes`, `samples`, or `cells`.
- The agent leaves `shape` out when it cannot measure the primary matrix. It never estimates a dimension.

A profile can re-apply a prior recipe with no agent run. Then the snapshot MUST keep the prior `shape` when its input signature equals the prior input signature. Otherwise the snapshot MUST have no `shape` key, because new or changed inputs can change the dimensions. A profile whose agent runs MUST take `shape` from its own submission only.

#### Scenario: A profile with a count matrix carries its shape

- **GIVEN** a submission with `shape` `{ rows: 61533, rowUnit: "genes", columns: 28, columnUnit: "samples" }`
- **WHEN** `buildDataProfileResult` builds the snapshot
- **THEN** the snapshot holds the same `shape`
- **AND** a host that reads the stored profile with `GET {A}/data-profile` gets the same `shape`

#### Scenario: A profile with no matrix has no shape

- **GIVEN** a submission with no `shape`
- **WHEN** `buildDataProfileResult` builds the snapshot
- **THEN** the snapshot has no `shape` key

#### Scenario: A bad shape is refused

- **WHEN** the agent submits a `shape` with `rows` 0, or with an empty `columnUnit`
- **THEN** `submit_profile` refuses the submission, and the error names the field

#### Scenario: A re-applied recipe over changed inputs drops the shape

- **GIVEN** a prior snapshot with a `shape`, and new inputs that the prior recipe covers
- **WHEN** the profile re-applies the recipe with no agent run
- **THEN** the new snapshot has no `shape` key

#### Scenario: A re-applied recipe over the same inputs keeps the shape

- **GIVEN** a prior snapshot with a `shape`, and a deliberate re-profile of the same inputs
- **WHEN** the profile re-applies the recipe with no agent run, and the input signature does not change
- **THEN** the new snapshot holds the prior `shape`
