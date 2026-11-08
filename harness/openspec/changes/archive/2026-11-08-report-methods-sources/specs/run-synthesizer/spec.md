## ADDED Requirements

### Requirement: submit_synthesis checks a method reference against the methods of the run

The synthesis MUST have an optional `methodReferences` field. Each entry gives a step id and the citation key of a source as `doi:<doi>` or `pmid:<id>`. It also gives a short citation, and the method that the source supports. The step of the summaries MUST also read the methods of each completed step. The stored plan of the run and the decision records of the step give them. A checkpoint of that step with no methods MUST give no method source. The seed of the synthesizer MUST list the bounded method sources of each step with their citation keys. It MUST give the count of the tail. The `data-run-synthesis` part MUST carry the method references.

`submit_synthesis` MUST refuse a method reference whose step has no method source. It MUST also refuse a method reference whose key the methods of that step do not list. The check MUST compare a DOI key in lower case. The check MUST read each source of the step, also a source past the bound of the seed. The check MUST read the methods of the run and not the lookups, thus a method source needs no lookup.

#### Scenario: A method reference with no lookup

- **GIVEN** a step whose decision record cites the DOI `10.1186/s13059-014-0550-8`
- **WHEN** the synthesizer submits a method reference to `doi:10.1186/S13059-014-0550-8` for that step with no lookup
- **THEN** `submit_synthesis` accepts the reference, and `synthesis.json` keeps it

#### Scenario: A lookup PMID is not a method source

- **GIVEN** a lookup of the run that returned the PMID `12345678`
- **WHEN** the synthesizer submits a method reference to `pmid:12345678` for a step whose methods do not list it
- **THEN** `submit_synthesis` refuses the reference at its `source` path

#### Scenario: A step with no method source

- **WHEN** the synthesizer submits a method reference for a step with no method source
- **THEN** `submit_synthesis` refuses the reference at its `stepId` path
