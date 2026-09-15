## ADDED Requirements

### Requirement: The seam route counts an image package as present

The seam route MUST read the image record at the root of the store. It MUST
join `imagePoolIndex` of the harness to the pool index of the graph with
`joinPoolIndexes`. It MUST resolve each query one time over the joined index.
When the answer is `resolved` and the graph does not hold the identity, the
outcome MUST be `present`. Its version MUST be the runtime version of the
track in the record, and the seam MUST link nothing for it.

A record that is absent or that does not parse MUST give an index that holds
nothing. `store link` and `store add` MUST resolve over the graph alone.

#### Scenario: A base R package is present

- **GIVEN** a store whose record holds `stats` in `r_base` and the R runtime `4.6.0`
- **WHEN** the seam receives a query with the spelling `stats` and the track `r`
- **THEN** the outcome is `present` with the version `4.6.0`, and the farm links nothing

#### Scenario: A standard-library module is present

- **GIVEN** a store whose record holds `json` in `python_stdlib`
- **WHEN** the seam receives a query with the spelling `json`
- **THEN** the outcome is `present`

#### Scenario: A store with no record keeps the answer of the graph

- **GIVEN** a store with no image record
- **WHEN** the seam receives a query with the spelling `stats` and the track `r`
- **THEN** the outcome is `absent`
