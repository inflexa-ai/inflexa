# chembl-tools Specification

## Purpose

Defines the five harness bio-lookup tools that wrap the ChEMBL REST API
(`https://www.ebi.ac.uk/chembl/api/data`) so agents can resolve compounds,
bioactivities, targets, mechanisms of action, and approved-drug records from a
single curated cheminformatics source. Each tool is a thin `defineTool`
wrapper over the shared pure-async client (`harness/src/tools/lib/chembl-client.ts`)
and the shared `apiFetch` boundary; the client owns mapping and the HTTP error
channel so the tools stay declarative.

The tools follow the harness tool-error contract: an expected ChEMBL outcome —
a `404` for an identifier that resolves to nothing — is returned as a data
variant (an empty array), never an error. An unexpected failure (5xx, timeout,
retry exhaustion, transport error) is thrown out of `execute`; the agent loop
catches it at the dispatch boundary and turns it into a `tool_result
{ is_error: true }`, so the tools themselves never fabricate a `success` flag or
error envelope.

On-wire tool ids are snake_case (`search_compounds`, `get_bioactivity`,
`search_targets`, `get_mechanism`, `get_drug_info`) — that is the identifier the
model sees and calls. The exported TypeScript symbols are the camelCase
`...Tool` constants. The tools are not handed to every sandbox agent: they are
entries in the central sandbox tool registry (`resolveSandboxTools` in
`harness/src/agents/sandbox/shared.ts`) and reach a sandbox agent only when that
agent's `meta.tools` allowlist names them; they are also wired directly into the
conversation agent. They are deliberately absent from `BASE_SANDBOX_TOOLS`.

## Requirements

### Requirement: ChEMBL tools wrap the ChEMBL REST API

The system SHALL provide five harness tools defined in `harness/src/tools/bio/`,
each built with `defineTool` from `harness/src/tools/define-tool.ts`, each
accepting a Zod-validated input schema and issuing server-side HTTP requests to
the ChEMBL REST API via the shared `apiFetch` helper. The exported symbols
SHALL be `searchCompoundsTool`, `getBioactivityTool`, `searchTargetsTool`,
`getMechanismTool`, and `getDrugInfoTool`, with on-wire ids `search_compounds`,
`get_bioactivity`, `search_targets`, `get_mechanism`, and `get_drug_info`.

#### Scenario: Tools are importable with snake_case ids

- **WHEN** importing from `harness/src/tools/bio/index.js`
- **THEN** `searchCompoundsTool`, `getBioactivityTool`, `searchTargetsTool`, `getMechanismTool`, and `getDrugInfoTool` are available
- **AND** their on-wire ids are `search_compounds`, `get_bioactivity`, `search_targets`, `get_mechanism`, and `get_drug_info`

### Requirement: search_compounds tool

`searchCompoundsTool` SHALL search for compounds by target name/ChEMBL ID,
compound name, or SMILES substring, selected by a required `searchType` of
`target` | `compound` | `smiles`. It SHALL return `ok({ compounds })` where each
compound carries `chemblId`, `preferredCompoundName`, `canonicalSmiles`,
`molecularWeight`, `alogp`, and `molecularFormula`. The `limit` SHALL default to
500 (max 500). Results SHALL NOT be re-sorted by relevance — they are returned
in the order ChEMBL yields them.

#### Scenario: Search compounds by target

- **WHEN** `search_compounds` is called with `{ query: "EGFR", searchType: "target" }`
- **THEN** it resolves the target, fetches its activities, and returns the unique active compounds
- **AND** each result includes `chemblId`, `canonicalSmiles`, and `molecularWeight`

#### Scenario: Search compounds by name

- **WHEN** `search_compounds` is called with `{ query: "imatinib", searchType: "compound" }`
- **THEN** it returns compound(s) matching the name, each with its `canonicalSmiles`

#### Scenario: Result limit is honored

- **WHEN** `search_compounds` is called with `{ query: "EGFR", searchType: "target", limit: 100 }`
- **THEN** at most 100 activity records drive the molecule fan-out

### Requirement: get_bioactivity tool

`getBioactivityTool` SHALL retrieve bioactivity data for a compound or target by
ChEMBL ID, with a required `type` of `compound` | `target`. It SHALL return
`ok({ activities })` where each activity carries `activityId`,
`compoundChemblId`, `targetChemblId`, `standardType`, `standardValue`,
`standardUnits`, `assayChemblId`, `assayType`, and `pchemblValue`. An optional
`activityType` SHALL filter by `standard_type`; `limit` defaults to 500.

#### Scenario: Get bioactivity for a compound

- **WHEN** `get_bioactivity` is called with `{ chemblId: "CHEMBL25", type: "compound" }`
- **THEN** it returns activity records, each including `standardType`, `standardValue`, and `standardUnits`

#### Scenario: Filter by activity type

- **WHEN** `get_bioactivity` is called with `{ chemblId: "CHEMBL203", type: "target", activityType: "IC50" }`
- **THEN** only IC50 records are returned

### Requirement: search_targets tool

`searchTargetsTool` SHALL search for biological targets by gene symbol, protein
name, or ChEMBL ID and SHALL return `ok({ targets })` where each target carries
`targetChemblId`, `preferredName`, `targetType`, `organism`, and `geneNames`.
`limit` SHALL default to 25 (max 25).

#### Scenario: Search target by gene symbol

- **WHEN** `search_targets` is called with `{ query: "BRAF" }`
- **THEN** it returns target(s) matching BRAF, each with `targetChemblId`, `preferredName`, and `organism`

### Requirement: get_mechanism tool

`getMechanismTool` SHALL retrieve mechanism-of-action data for a compound by
ChEMBL ID and SHALL return `ok({ mechanisms })` where each mechanism carries
`mechanismOfAction`, `actionType`, `targetChemblId`, `targetName`, and
`moleculeChemblId`. Target names SHALL be resolved by a batched follow-up lookup.

#### Scenario: Get mechanism for a drug

- **WHEN** `get_mechanism` is called with `{ chemblId: "CHEMBL941" }`
- **THEN** it returns the mechanism of action including `actionType` and the resolved target

### Requirement: get_drug_info tool

`getDrugInfoTool` SHALL search for approved drugs by name or indication and
SHALL return `ok({ drugs })` where each drug carries `moleculeChemblId`,
`preferredName`, `maxPhase`, `moleculeType`, `firstApproval`, and `indication`.
When the drug endpoint yields nothing it SHALL fall back to a molecule search
filtered to `max_phase >= 4`. `limit` SHALL default to 25 (max 25).

#### Scenario: Search drugs by indication

- **WHEN** `get_drug_info` is called with `{ query: "melanoma" }`
- **THEN** it returns drugs with melanoma indications, including `maxPhase` and `firstApproval`

### Requirement: ChEMBL tools are available via the per-agent allowlist

The five ChEMBL tools SHALL be entries in the central sandbox tool registry that
`resolveSandboxTools` (`harness/src/agents/sandbox/shared.ts`) resolves, reaching
a sandbox agent only when that agent's `meta.tools` allowlist names them. They
SHALL also be wired directly into the conversation agent
(`harness/src/agents/conversation-agent.ts`). They SHALL NOT be members of
`BASE_SANDBOX_TOOLS`, so they are not granted to every sandbox agent.

#### Scenario: Sandbox agent resolves ChEMBL tools from its allowlist

- **WHEN** a sandbox-agent meta lists ChEMBL tool names in `meta.tools`
- **THEN** `createSandboxAgent` resolves them via `resolveSandboxTools` and adds them to that agent's tool array

#### Scenario: ChEMBL tools are not granted by default

- **WHEN** a sandbox agent's `meta.tools` does not name any ChEMBL tool
- **THEN** the resolved tool array contains none of `search_compounds`, `get_bioactivity`, `search_targets`, `get_mechanism`, `get_drug_info`

#### Scenario: Conversation agent has the ChEMBL tools

- **WHEN** the conversation agent is created
- **THEN** its tool array includes `searchCompoundsTool`, `getBioactivityTool`, `searchTargetsTool`, `getMechanismTool`, and `getDrugInfoTool`

### Requirement: Error handling, retry, and timeout

ChEMBL tools SHALL treat a `404` as an expected "not found" and return an empty
result array, not an error. The shared `apiFetch` boundary SHALL retry `429` and
`503` with exponential backoff up to `maxRetries` (3, i.e. up to 4 attempts) and
SHALL apply a default request timeout of 90 seconds. Any unexpected failure —
5xx, timeout, or retry exhaustion — SHALL be thrown out of `execute` so the
agent loop wraps it as `tool_result { is_error: true }`; the tools do not return
a self-authored error envelope.

#### Scenario: Target not found returns empty

- **WHEN** `search_targets` is called with a query that resolves to no target (404)
- **THEN** it returns an empty `targets` array, not an error

#### Scenario: Rate limit triggers backoff retry

- **WHEN** the ChEMBL API returns 429 or 503
- **THEN** `apiFetch` retries after exponential backoff up to 3 retries

#### Scenario: Server error surfaces as an error tool result

- **WHEN** the ChEMBL API returns a 5xx after retries are exhausted
- **THEN** `execute` throws and the agent loop records the call as `tool_result { is_error: true }`
