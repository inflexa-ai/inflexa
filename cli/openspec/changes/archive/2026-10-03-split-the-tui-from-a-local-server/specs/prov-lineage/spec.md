## ADDED Requirements

### Requirement: The lineage walk runs in the local server after a recorder flush

`inflexa prov lineage` SHALL be a client of `GET {A}/provenance/lineage`, which carries the reference, the direction, the depth bound, and the format. The server SHALL validate each option, flush the in-memory appends of the provenance recorder into the stored chain, and then resolve and walk the reference. Thus a walk sees each event that the server recorded. A flush that fails SHALL NOT stop the walk, which then reads the last stored chain. An unmatched reference SHALL answer `not_found` with the known-paths sample, and an ambiguous one SHALL answer `conflict` with its candidates, so the command prints the same failure as the resolution defines.

#### Scenario: A walk sees a file that the server did not flush yet

- **GIVEN** a server whose recorder holds the generation of a file that it did not flush yet
- **WHEN** `inflexa prov lineage my-analysis <that file>` runs
- **THEN** the file resolves and its lineage renders

#### Scenario: A bad depth fails before the walk

- **WHEN** `inflexa prov lineage my-analysis results.csv --depth 0` runs
- **THEN** the server refuses the depth with `validation_error`, and the command exits non-zero
