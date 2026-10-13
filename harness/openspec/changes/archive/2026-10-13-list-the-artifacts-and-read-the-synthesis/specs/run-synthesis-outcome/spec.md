## ADDED Requirements

### Requirement: A read gives the synthesis record of a run as the flat part

The harness MUST give a read of the synthesis record of a run. The read takes the absolute workspace root of the analysis and the run id. It MUST read `runs/<runId>/synthesis.json` under that root, and it MUST read at most 1 MiB of the file. It MUST validate the text with the stored synthesis schema.

For a valid record, the read MUST give the flat `data-run-synthesis` part. That part MUST be equal to the part that the synthesis sink writes to the run stream for the same record.

The read MUST give `null` in these cases, and it MUST NOT throw:

- the run id can escape the run tree
- the file is absent, or its read fails
- the file holds more than 1 MiB
- the text is not JSON, or the JSON fails the stored synthesis schema

The read MUST NOT read the run row. The run row stays the authority on whether a synthesis exists, thus a caller decides from the recorded outcome if it reads the record. The report snapshot pin MUST read its records through the same bounded read. The root barrel of the package MUST export the read.

#### Scenario: A produced record gives the stream part

- **GIVEN** a run whose synthesis wrote a valid `synthesis.json`
- **WHEN** a caller reads the record of that run
- **THEN** it gets the part that the run stream carries for that synthesis, with `type` `data-run-synthesis` and `id` `synthesis-<runId>`
- **AND** each finding of the part has its references

#### Scenario: No record on disk

- **GIVEN** a run with no `synthesis.json`
- **WHEN** a caller reads the record of that run
- **THEN** it gets `null`

#### Scenario: A record that fails the schema

- **GIVEN** a `synthesis.json` whose findings have no `references`
- **WHEN** a caller reads the record of that run
- **THEN** it gets `null`

#### Scenario: A record over the cap

- **GIVEN** a `synthesis.json` that holds more than 1 MiB
- **WHEN** a caller reads the record of that run
- **THEN** it gets `null`

### Requirement: The finding of the synthesis part carries its references

The contract `SynthesizedFinding` and its schema `SynthesizedFindingSchema` MUST carry the required field `references`. Each reference MUST carry these fields:

- `pmid`
- `citation`
- `relevance`
- `concordance`: `supports`, `contradicts`, `extends`, or `contextualizes`

A parse of a `data-run-synthesis` part with `RunSynthesisPartSchema` MUST keep the references of each finding. The schema MUST refuse a finding with no `references`.

#### Scenario: A parse keeps the references

- **GIVEN** a `data-run-synthesis` part whose finding has one reference with the concordance `supports`
- **WHEN** a consumer parses the part with `RunSynthesisPartSchema`
- **THEN** the parsed finding has that reference with each of its fields

#### Scenario: A finding with no references

- **WHEN** a consumer parses a `data-run-synthesis` part whose finding has no `references`
- **THEN** the parse fails
