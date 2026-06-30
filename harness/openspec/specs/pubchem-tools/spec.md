# pubchem-tools Specification

## Purpose

Defines the three harness tools that wrap PubChem's PUG-REST API
(`https://pubchem.ncbi.nlm.nih.gov/rest/pug`): `search_pubchem_compound`,
`get_pubchem_cross_refs`, and `get_pubchem_assays`. PubChem covers 110M+
compounds — far broader than ChEMBL's curated set — so these tools give agents a
resolution path for compounds ChEMBL does not recognize and a bridge from a
PubChem CID to other registries (ChEMBL, DrugBank, KEGG, PDB) and to
high-throughput screening data.

Each tool is a `defineTool` wrapper over the shared `apiFetch` boundary and the
PubChem config module (`harness/src/tools/lib/pubchem-config.ts`). They follow
the harness tool-error contract literally: an expected outcome — a `404` for a
CID/query with no match, no cross-references, or no assay data — is returned as a
data variant with an empty array; an unexpected failure (5xx, timeout, retry
exhaustion) is thrown out of `execute` and the agent loop wraps it as a
`tool_result { is_error: true }`. The tools return bare result objects
(`ok({ results })`, `ok({ crossRefs })`, `ok({ assays })`) and never a
self-authored `{ success, error }` envelope.

In the cheminformatics agent prompt these tools are taught as a dedicated
**Mode C — PubChem Compound Resolution** (not an extension of the ChEMBL-centric
Mode B): resolve a compound in PubChem, optionally bridge to ChEMBL via its
cross-references, and supplement curated bioactivity with broader PubChem
screening data.

## Requirements

### Requirement: PubChem compound search tool

The system SHALL provide a `searchPubchemCompoundTool` (on-wire id
`search_pubchem_compound`, built with `defineTool`) that resolves compounds by
name, SMILES, InChI, InChIKey, or CID via a required `searchBy` enum. It SHALL
return `ok({ results })` where each result carries compound identity (`cid`,
`canonicalSmiles`, `inchi`, `inchiKey`, `iupacName`, `molecularFormula`) and
computed properties (`molecularWeight`, `xlogp`, `tpsa`, `hbondDonorCount`,
`hbondAcceptorCount`, `rotatableBondCount`, `complexity`).

#### Scenario: Search by compound name

- **WHEN** the tool is called with `query: "aspirin"` and `searchBy: "name"`
- **THEN** it returns `ok({ results })` with at least one result whose `cid` is 2244, plus its `canonicalSmiles` and `molecularWeight`

#### Scenario: Search by CID

- **WHEN** the tool is called with `query: "2244"` and `searchBy: "cid"`
- **THEN** it returns the compound with CID 2244 and all identity + property fields

#### Scenario: Compound not found returns empty results

- **WHEN** the query matches no PubChem compound (404)
- **THEN** it returns `ok({ results: [] })`, not an error

#### Scenario: Server error surfaces as an error tool result

- **WHEN** PubChem returns a 5xx after retries are exhausted
- **THEN** `execute` throws and the agent loop records the call as `tool_result { is_error: true }`

### Requirement: PubChem cross-references tool

The system SHALL provide a `getPubchemCrossRefsTool` (on-wire id
`get_pubchem_cross_refs`, built with `defineTool`) that takes a numeric `cid` and
returns `ok({ crossRefs })`, where `crossRefs` is a flat array of
`{ source, id }` entries drawn from PubChem's `RegistryID`/`SourceName` xref
lists (ChEMBL, DrugBank, KEGG, PDB, and other registries). The entries are not
grouped by source. This enables bridging: resolve a compound in PubChem, read
its ChEMBL id from `crossRefs`, then query the ChEMBL tools.

#### Scenario: Compound with cross-references

- **WHEN** the tool is called with a CID that has registry links (e.g. aspirin CID 2244)
- **THEN** it returns `ok({ crossRefs })` as a flat array whose entries include a `{ source, id }` for ChEMBL

#### Scenario: CID with no external references

- **WHEN** the tool is called with a CID that has no registry links, or a CID that does not exist (404)
- **THEN** it returns `ok({ crossRefs: [] })`

### Requirement: PubChem bioassay summary tool

The system SHALL provide a `getPubchemAssaysTool` (on-wire id
`get_pubchem_assays`, built with `defineTool`) that takes a numeric `cid` and
returns `ok({ assays })`, where each assay carries `aid`, `assayName`,
`targetName`, `activityOutcome`, and `activityValue`. It SHALL accept
`activeOnly` (default false) to keep only assays whose outcome is "active", and a
`limit` (default 50, max 500) that caps the returned records.

#### Scenario: Compound with bioassay data

- **WHEN** the tool is called with a CID screened in PubChem BioAssays
- **THEN** it returns assay summaries with `activityOutcome` and `targetName`

#### Scenario: Filter by active results

- **WHEN** the tool is called with `activeOnly: true`
- **THEN** only assays whose `activityOutcome` is "active" (case-insensitive) are returned

#### Scenario: Limit caps the result count

- **WHEN** the tool is called with `limit: 10`
- **THEN** at most 10 assay records are returned

#### Scenario: No assay data returns empty

- **WHEN** the tool is called with a CID that has not been screened (404)
- **THEN** it returns `ok({ assays: [] })`

### Requirement: PubChem config module

The system SHALL provide `harness/src/tools/lib/pubchem-config.ts` exporting the
PUG-REST base URL and shared request headers, mirroring `chembl-config.ts`.

#### Scenario: Config exports

- **WHEN** `pubchem-config.ts` is imported
- **THEN** it exports `PUBCHEM_BASE` (the PUG-REST base URL string) and `PUBCHEM_HEADERS` (`{ Accept: "application/json" }`)

### Requirement: PubChem tools are available via the per-agent allowlist and the conversation agent

The three PubChem tools SHALL be entries in the central sandbox tool registry
that `resolveSandboxTools` (`harness/src/agents/sandbox/shared.ts`) resolves —
reaching a sandbox agent only when its `meta.tools` allowlist names them — and
SHALL also be wired directly into the conversation agent
(`harness/src/agents/conversation-agent.ts`).

#### Scenario: Sandbox agent resolves PubChem tools from its allowlist

- **WHEN** a sandbox-agent meta lists the PubChem tool names in `meta.tools`
- **THEN** `createSandboxAgent` resolves them via `resolveSandboxTools` and adds them to that agent's tool array

#### Scenario: Conversation agent has the PubChem tools

- **WHEN** the conversation agent is created
- **THEN** its tool array includes `searchPubchemCompoundTool`, `getPubchemCrossRefsTool`, and `getPubchemAssaysTool`

### Requirement: Cheminformatics agent teaches PubChem as Mode C

The cheminformatics agent prompt SHALL present a dedicated **Mode C — PubChem
Compound Resolution** path that resolves compounds via `search_pubchem_compound`,
bridges to ChEMBL via `get_pubchem_cross_refs`, and supplements activity data via
`get_pubchem_assays`. The prompt SHALL teach when to prefer PubChem (broader
compound coverage, cross-database bridging) versus ChEMBL (curated bioactivity,
target–compound relationships).

#### Scenario: Agent uses PubChem for compound resolution

- **WHEN** the agent receives a compound name ChEMBL does not recognize
- **THEN** it uses `search_pubchem_compound` to resolve the compound

#### Scenario: Agent bridges PubChem to ChEMBL

- **WHEN** the agent resolves a compound in PubChem and needs curated bioactivity
- **THEN** it uses `get_pubchem_cross_refs` to obtain the ChEMBL id, then queries the ChEMBL tools
