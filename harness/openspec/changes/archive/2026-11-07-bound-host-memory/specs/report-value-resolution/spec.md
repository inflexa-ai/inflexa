# Spec Delta

## MODIFIED Requirements

### Requirement: The host fast path under the cap
The realization MUST parse CSV, TSV, JSON, and parquet on the host for a file at or under the cap, in a bounded decode worker. The parquet read MUST use a pure-JavaScript reader, thus no native library enters the package. The cap MUST be a composition-root value with a 16 MiB default. The host arm MUST parse a strict dialect only. A table whose cells pass 1,000,000 MUST NOT decode on the host.

#### Scenario: A small CSV resolves in process
- **WHEN** a reference addresses a cell in a 2 MiB CSV
- **THEN** the host arm gives the cell, and no sandbox starts

#### Scenario: The embedder tunes the cap
- **WHEN** the composition root sets a 4 MiB cap
- **THEN** a 10 MiB file takes the fall-through

### Requirement: The fall-through takes every doubt
An over-cap file, a table over the cell budget, a decode that ran out of memory, an unknown format, and a host parse fault MUST take the fall-through. The host arm MUST NOT give a partial or guessed answer. Thus correctness never depends on the host parser. The realization has no sandbox arm, thus the fall-through gives a typed failure and no value.

#### Scenario: A parse fault falls through
- **WHEN** the host parser fails on an odd CSV dialect
- **THEN** the reference fails with `extraction-unavailable`, and the failure gives no guessed value from the host fault

#### Scenario: A table over the cell budget falls through
- **WHEN** a reference addresses a cell of a parquet file of 2,000,000 cells
- **THEN** the reference fails with `extraction-unavailable`, and the file is not decoded

## ADDED Requirements

### Requirement: The read cache of the process is bounded by cells
The read store of the report path MUST hold one bounded cache for the process. It MUST drop the least recently used entry while the cells of the held rows pass 2,000,000, or while the entries pass 128. A dropped entry costs one read again, and it is never wrong.

#### Scenario: Large tables of two analyses
- **GIVEN** a cache that holds the rows of two tables of 900,000 cells each, of two analyses
- **WHEN** a pass of a third analysis reads a table of 500,000 cells
- **THEN** the cache drops the rows of the older table, and it holds the rows of the other two
