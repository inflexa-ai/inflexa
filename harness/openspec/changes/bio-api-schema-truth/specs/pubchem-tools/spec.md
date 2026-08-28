# pubchem-tools Delta

## MODIFIED Requirements

### Requirement: PubChem compound search tool

The system MUST give a `searchPubchemCompoundTool` (on-wire id `search_pubchem_compound`, built with `defineTool`). The tool resolves compounds by name, SMILES, InChI, InChIKey, or CID through a required `searchBy` enum. It MUST return `ok({ results })` where each result carries compound identity (`cid`, `canonicalSmiles`, `inchi`, `inchiKey`, `iupacName`, `molecularFormula`) and computed properties (`molecularWeight`, `xlogp`, `tpsa`, `hbondDonorCount`, `hbondAcceptorCount`, `rotatableBondCount`, `complexity`).

The client MUST request and read the wire property `ConnectivitySMILES` for `canonicalSmiles`, because PubChem retired the response key `CanonicalSMILES`. The client MUST read `MolecularWeight` as a wire number, because PubChem serializes it as a string.

#### Scenario: Search by compound name

- **WHEN** the tool is called with `query: "aspirin"` and `searchBy: "name"`
- **THEN** it returns `ok({ results })` with at least one result whose `cid` is 2244, plus its `canonicalSmiles` and `molecularWeight`

#### Scenario: Search by CID

- **WHEN** the tool is called with `query: "2244"` and `searchBy: "cid"`
- **THEN** it returns the compound with CID 2244 and all identity + property fields

#### Scenario: Compound not found returns empty results

- **WHEN** the query matches no PubChem compound (404)
- **THEN** it returns `ok({ results: [] })`, not an error

#### Scenario: A nonexistent CID does not fabricate a row

- **WHEN** the tool is called with a CID that does not exist, and PubChem answers HTTP 200 with a row that carries only the `CID` key
- **THEN** it returns `ok({ results: [] })`, not a row with empty fields

#### Scenario: Server error surfaces as an error tool result

- **WHEN** PubChem returns a 5xx after retries are exhausted
- **THEN** `execute` throws and the agent loop records the call as `tool_result { is_error: true }`

### Requirement: PubChem cross-references tool

The system MUST give a `getPubchemCrossRefsTool` (on-wire id `get_pubchem_cross_refs`, built with `defineTool`) that takes a numeric `cid`. It returns `ok({ crossRefs })`, where `crossRefs` is a flat array of `{ source, id }` entries drawn from PubChem's `RegistryID` list. The `source` of an entry MUST come from the identifier pattern of a fixed registry table: ChEMBL, DrugBank, KEGG, PDB, CAS, ChEBI, HMDB, and UNII. An id that matches no pattern MUST carry `source: null`.

The client MUST NOT pair `RegistryID` with `SourceName` by index, because the two arrays are not parallel and have different lengths. This enables bridging: resolve a compound in PubChem, read its ChEMBL id from `crossRefs`, then query the ChEMBL tools.

#### Scenario: Compound with cross-references

- **WHEN** the tool is called with a CID that has registry links, for example aspirin CID 2244
- **THEN** it returns `ok({ crossRefs })` as a flat array whose entries include `{ source: "ChEMBL", id: "CHEMBL25" }`

#### Scenario: An unmatched id keeps a null source

- **WHEN** a registry id matches no pattern in the registry table
- **THEN** the entry carries the id and `source: null`, and no source name is guessed

#### Scenario: CID with no external references

- **WHEN** the tool is called with a CID that has no registry links, or a CID that does not exist (404)
- **THEN** it returns `ok({ crossRefs: [] })`

### Requirement: PubChem bioassay summary tool

The system MUST give a `getPubchemAssaysTool` (on-wire id `get_pubchem_assays`, built with `defineTool`) that takes a numeric `cid`. It returns `ok({ assays })`, where each assay carries `aid`, `assayName`, `targetName`, `activityOutcome`, and `activityValue`. It MUST accept `activeOnly` (default false) to keep only assays whose outcome is "active". It MUST accept a `limit` (default 50, max 500) that caps the returned records.

The schema MUST model the wire shape of the assay table: `Table.Columns.Column` is an array of plain strings, and each `Row.Cell` is an array of plain strings with one entry per column. The parser MUST select columns by the wire headings, which carry spaces, for example `"Assay Name"`, `"Activity Outcome"`, and `"Activity Value [uM]"`. The `targetName` of an assay MUST come from the `"Target Accession"` column.

#### Scenario: Compound with bioassay data

- **WHEN** the tool is called with a CID screened in PubChem BioAssays
- **THEN** it returns assay summaries with `activityOutcome` and `targetName`

#### Scenario: The real table shape parses

- **WHEN** the wire serves `Column` as plain strings and each `Cell` as plain strings with `""` for an empty cell
- **THEN** the schema accepts the table, and the parser reads the values by heading position

#### Scenario: Filter by active results

- **WHEN** the tool is called with `activeOnly: true`
- **THEN** only assays whose `activityOutcome` is "active" (case-insensitive) are returned

#### Scenario: Limit caps the result count

- **WHEN** the tool is called with `limit: 10`
- **THEN** at most 10 assay records are returned

#### Scenario: No assay data returns empty

- **WHEN** the tool is called with a CID that has not been screened (404)
- **THEN** it returns `ok({ assays: [] })`
