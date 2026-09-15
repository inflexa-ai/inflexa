# uniprot-tools Specification

## Purpose

Defines the harness tool `search_protein`, which wraps the UniProtKB search
endpoint (`https://rest.uniprot.org/uniprotkb/search`). UniProtKB is the curated
protein knowledgebase of EMBL-EBI, SIB, and PIR. It is keyless and public.

`harness/src/tools/lib/uniprot-client.ts` held `getUniProtRecord` before this
tool, but only the target-assessment workflow imported it. Thus no agent could
look up a protein. `search_gene` accepts a UniProt accession, but it answers
with Ensembl gene records only. This tool answers with the protein itself: the
name, the gene names, the sequence length, the curated function, and the
subcellular locations.

The tool follows the harness tool-error contract literally. The search endpoint
answers an unknown query with HTTP 200 and `{"results":[]}`, and never with a
404. Thus the empty answer is `ok({ proteins: [] })` and it needs no
status-code branch. An unexpected failure throws out of `execute` — a 5xx, a
timeout, retry exhaustion, or a schema mismatch. The agent loop then wraps it
as a `tool_result { is_error: true }`.

Three decisions bind the tool. First, the search takes its own field list.
`FIELDS` feeds `getUniProtRecord`, thus a widening of it would change what
that function reads.

Second, the two identifier spaces overlap, thus the query searches both. A
gene symbol such as `P2RY12` or `B3GAT1` matches the accession form exactly. A
lookup in the accession space alone reports that protein as absent. Thus an
accession-shaped input searches both spaces.

The shape still decides one thing. UniProt validates the value of an
`accession:` clause, and it answers HTTP 400 for a value that is not
accession-shaped. Thus a plain symbol never reaches that clause.

The narrowing filters stay off the accession side. An accession is a unique
key, and `accession:P02769` under the human default would otherwise answer
nothing, although that accession names bovine serum albumin.

The accession side carries `active:true`, and that is the one filter it takes.
A deleted accession still answers an `accession:` query, as an `Inactive` row
with no name and no function, and the mapper has no field for the deletion
reason. `B3GAT1` names one such accession. Thus the filter removes that hollow
row from the answer.

Third, the answer is bounded and it says so. UniProt reports its match count in
the `x-total-results` header, and `apiFetch` exposes no header. Thus the client
asks for one row beyond the limit and reports `hasMore`. That separates a
trimmed answer from a complete one, which is what the bio barrel requires.

## Requirements

### Requirement: UniProtKB protein search tool

The system MUST give a `searchProteinTool` (on-wire id `search_protein`, built
with `defineTool`) that takes a required `query` string. It MUST also take
`organismId` (an NCBI Taxonomy ID, default 9606, nullable to search every
organism), `reviewedOnly` (default true), and `limit`. It MUST return
`ok({ proteins, hasMore })`. Each protein carries `accession`, `uniProtkbId`,
`proteinName`, `geneNames`, `sequenceLength`, `function`,
`subcellularLocations`, and `reviewed`.

#### Scenario: A gene symbol resolves to its reviewed protein

- **WHEN** the tool is called with `query: "BRCA1"` and the default organism and reviewed filter
- **THEN** it returns one protein whose `accession` is `P38398` and whose `uniProtkbId` is `BRCA1_HUMAN`

#### Scenario: An accession-shaped input searches both identifier spaces

- **WHEN** the `query` matches a documented UniProt accession form, for example `P38398`, `A0A0B4J1Y9`, or the gene symbol `P2RY12`
- **THEN** the request OR-s an `accession:` clause with the `gene_exact:` clause, thus a symbol that is shaped like an accession still resolves

#### Scenario: The narrowing filters stay off the accession clause

- **WHEN** the `query` is an accession that names an entry of another organism, for example `P02769` under the default `organismId` of 9606
- **THEN** the `organism_id:` and `reviewed:true` clauses bind the `gene_exact:` side only, and the accession still resolves

#### Scenario: A deleted accession does not answer

- **WHEN** the `query` is accession-shaped and it also names a deleted entry, for example `B3GAT1`
- **THEN** the `accession:` clause carries `active:true`, thus the `Inactive` row does not answer, and the `gene_exact:` side still resolves the human protein

#### Scenario: A symbol that is not accession-shaped sends no accession clause

- **WHEN** the `query` matches no accession form, for example `BRCA1`
- **THEN** the request carries a `gene_exact:` clause and no `accession:` clause, because UniProt answers HTTP 400 for an accession value it cannot parse

#### Scenario: An unknown query returns an empty array

- **WHEN** UniProt answers HTTP 200 with `{"results":[]}`
- **THEN** the tool returns `ok({ proteins: [], hasMore: false })`, and not an `is_error` tool result

#### Scenario: The reviewed filter is a toggle

- **WHEN** `reviewedOnly` is false
- **THEN** the request carries no `reviewed:true` clause, thus a TrEMBL entry can answer

#### Scenario: Every organism is reachable

- **WHEN** `organismId` is null
- **THEN** the request carries no `organism_id:` clause

#### Scenario: A trimmed answer says that it was trimmed

- **WHEN** UniProt holds more rows than `limit`
- **THEN** the tool returns `limit` proteins and `hasMore: true`

#### Scenario: A server error surfaces as an error tool result

- **WHEN** UniProt returns a 5xx after retries are exhausted
- **THEN** `execute` throws, and the agent loop records the call as `tool_result { is_error: true }`

### Requirement: describeCall names the query

The tool MUST declare a `describeCall` hook that returns the `query` verbatim.
Thus a caller tells one call from another by the query alone.

#### Scenario: describeCall reports the query

- **WHEN** `describeCall` is invoked with `{ query: "BRCA1" }`
- **THEN** it returns the string `"BRCA1"`

### Requirement: The search client obeys the absence policy of UniProt

`searchProteins` MUST live in `harness/src/tools/lib/uniprot-client.ts`, beside
`getUniProtRecord`. It MUST take its own field list, and it MUST NOT widen the
`FIELDS` constant. Each field of the search schema MUST carry `.optional()`,
because UniProt omits the key of an absent value and never sends null. The
schema MUST be exported, so that the golden-fixture table drives it.

#### Scenario: An entry that omits the optional keys still maps

- **WHEN** a result row omits `genes` and `comments`, as `Q6ZQY7` does
- **THEN** the mapped protein carries empty `geneNames`, a null `function`, and empty `subcellularLocations`

#### Scenario: A submitted name stands in for a recommended name

- **WHEN** a TrEMBL row carries `submissionNames` and no `recommendedName`, as `X5D778` does
- **THEN** `proteinName` reads the submitted name, and it is not null

#### Scenario: A TrEMBL row reports reviewed false

- **WHEN** `entryType` reads `UniProtKB unreviewed (TrEMBL)`
- **THEN** `reviewed` is false, because the client matches `unreviewed` before it matches `reviewed`

#### Scenario: A Swiss-Prot row reports reviewed true

- **WHEN** `entryType` reads `UniProtKB reviewed (Swiss-Prot)`
- **THEN** `reviewed` is true

#### Scenario: A repeated location is kept once

- **WHEN** UniProt splits the subcellular locations over more than one comment and repeats one of them
- **THEN** `subcellularLocations` holds each distinct location one time, in the order UniProt lists them

### Requirement: search_protein reaches the conversation agent and the literature reviewer

The tool MUST be wired into the conversation agent
(`harness/src/agents/conversation-agent.ts`) and into the literature reviewer
(`harness/src/tools/research/literature-reviewer.ts`). The prompt of the
literature reviewer names each tool that it holds, thus
`harness/src/prompts/literature-reviewer.ts` MUST carry a usage note for this
one.

The tool MUST NOT be an entry in the sandbox tool registry, and
`SandboxToolName` (`harness/src/agents/sandbox/types.ts`) MUST NOT name it.
Identifier resolution answers a question of the conversation, thus no sandbox
agent reaches for one yet.

#### Scenario: Conversation agent has the tool

- **WHEN** the conversation agent is created
- **THEN** its tool array includes `searchProteinTool`

#### Scenario: The literature reviewer has the tool and its prompt says so

- **WHEN** the literature reviewer tool is built
- **THEN** its tool array includes `searchProteinTool`, and its prompt names `search_protein` in the tool usage notes

#### Scenario: No sandbox agent can declare the tool

- **WHEN** a sandbox-agent meta names the tool in `meta.tools`
- **THEN** the name is not a `SandboxToolName`, thus the typecheck rejects it
