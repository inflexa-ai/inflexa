# Spec Delta

## MODIFIED Requirements

### Requirement: Base tools plus ChEMBL/PubChem via meta.tools

The agent's `meta.tools` SHALL spread `BASE_SANDBOX_TOOLS` and SHALL add its
compound-data tools explicitly. The `chembl` and `pubchem` tools SHALL be
granted through `meta.tools`, NOT through `BASE_SANDBOX_TOOLS`.

#### Scenario: Base set excludes compound-data tools

- **WHEN** `BASE_SANDBOX_TOOLS` is inspected
- **THEN** it contains neither `chembl` nor `pubchem`

#### Scenario: ChEMBL and PubChem are present via the allowlist

- **WHEN** the cheminformatics `meta.tools` is inspected
- **THEN** it includes `chembl` and `pubchem`
