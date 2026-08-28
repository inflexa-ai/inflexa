# chembl-tools Delta

## MODIFIED Requirements

### Requirement: get_drug_info tool

The drug lookup (the `drug` action of the `chembl` tool) MUST search approved drugs by name or by indication. It MUST return `ok({ drugs })` where each drug carries `moleculeChemblId`, `preferredName`, `maxPhase`, `moleculeType`, `firstApproval`, and `indication`.

A name query MUST run the molecule search filtered to `max_phase >= 4`. An indication query MUST run the `drug_indication` resource, with the `efo_term__icontains` and `mesh_heading__icontains` filters, and then resolve the molecules. The client MUST read the indications of the returned molecules from the `drug_indication` resource.

The client MUST NOT call `/drug/search.json`, because that endpoint does not exist on the ChEMBL API. The client MUST read `max_phase` as a wire number, because ChEMBL serializes it as the string `"4.0"`. `limit` MUST default to 10 (max 25).

#### Scenario: Search drugs by indication

- **WHEN** the `drug` action is called with `{ query: "melanoma" }`
- **THEN** it returns drugs with melanoma indications, with `maxPhase` and `firstApproval` as numbers

#### Scenario: Search drugs by name

- **WHEN** the `drug` action is called with `{ query: "imatinib" }`
- **THEN** it returns the approved molecules, with `preferredName` set and `maxPhase` equal to 4

#### Scenario: An approved row with a string max_phase parses

- **WHEN** the wire row carries `max_phase: "4.0"` and `pref_name: null`
- **THEN** the schema accepts the row, and the mapped drug carries `maxPhase: 4` and `preferredName: null`
