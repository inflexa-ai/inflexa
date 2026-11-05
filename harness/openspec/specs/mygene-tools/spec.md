# mygene-tools Specification

## Purpose

Defines the harness tool `resolve_gene_ids`, which reads the query service of
MyGene.info (`https://mygene.info/v3/query`). MyGene.info maps a gene across the
identifier spaces of its sources, as [Xin and others, Genome Biology 2016](https://genomebiology.biomedcentral.com/articles/10.1186/s13059-016-0953-9)
describe. The tool maps the HGNC symbol, the NCBI Entrez Gene ID, the Ensembl
gene ID, and the reviewed UniProt accession in one call.

Each source of the harness uses one identifier space as its key. `search_gene`
gives Ensembl records only, with no Entrez ID. `humanbase` takes Entrez IDs only.
Thus this tool is the step between the two, and in a script the `entrez` field
of a hit is the input of `humanbase`.

The tool sends one batch request (`POST /v3/query`) for each call. The query
matches the scopes `symbol`, `entrezgene`, `ensembl.gene`, and `uniprot`. The
scope `alias` is not one of them. An alias can match more than one current gene
with an equal score, and no rule picks one.

The tool is a `defineTool` wrapper over the MyGene client
(`harness/src/tools/lib/mygene-client.ts`). The client uses the shared
`apiFetchValidated` boundary. A miss is a data variant. `execute` throws an
unexpected failure, and the agent loop records it as
`tool_result { is_error: true }`. The tool never returns a `{ success, error }`
envelope.

`identifier-resolver.ts` and the private `resolveEntrezId` of
`cbioportal-client.ts` stay as they are, because they serve other tools:
`search_gene`, `gene_preclinical_profile`, and `gene_disease_evidence`.

## Requirements

### Requirement: The resolve_gene_ids tool maps a batch of identifiers

The system MUST give one harness tool, `resolveGeneIdsTool`
(`harness/src/tools/bio/resolve-gene-ids.ts`), with the on-wire id
`resolve_gene_ids`, built with `defineTool`. The input is `identifiers`, 1 to
200 identifiers of any of the four spaces, and `species`, with the default
`human`. The tool MUST return `ok({ genes, notFound, ambiguous, truncated })`.

Each hit in `genes` carries `query`, `symbol`, `name`, `entrez`, `ensembl`, and
`uniprot`. `query` is the identifier that the hit answers. `entrez` is a number,
or `null` for a gene with no Entrez record. `ensembl` and `uniprot` are arrays.

The client MUST trim each identifier, and it MUST send a duplicate identifier one
time. The client MUST send all the identifiers in one request.

#### Scenario: A symbol maps to its identifiers

- **WHEN** the tool is called with `identifiers: ["BRCA1"]`
- **THEN** the hit carries `entrez: 672`, `ensembl: ["ENSG00000012048"]`, and `uniprot: ["P38398"]`

#### Scenario: The batch goes in one request

- **WHEN** the tool is called with `[" BRCA1 ", "BRCA1", "7157"]` and `species: "mouse"`
- **THEN** the client posts one body with `q: ["BRCA1", "7157"]`, the four scopes, `species: "mouse"`, the cap, and `with_total`

#### Scenario: An identifier with more than one gene

- **WHEN** an identifier matches more than one gene, as a UniProt accession that a family of histone genes shares
- **THEN** `ambiguous` lists the identifier, and `genes` holds each of its genes

### Requirement: The hits of one identifier have a cap that the tool reports

The client MUST ask for at most 100 hits for each identifier, and it MUST ask
for the totals (`size` and `with_total`). MyGene cuts the hits of each
identifier at 10 by default, and the plain batch answer gives no sign of the
cut. `truncated` MUST list each identifier whose hits filled the cap when the
largest total of the batch is more than the cap.

#### Scenario: A gene family past the default cut

- **WHEN** the batch holds `P62805`, a UniProt accession that 14 histone genes share
- **THEN** `genes` holds 14 hits for `P62805`, and `truncated` is empty

#### Scenario: An identifier past the cap

- **WHEN** MyGene gives 100 hits for one identifier and a largest total of 120
- **THEN** `truncated` lists that identifier, and `genes` holds its 100 hits

### Requirement: A miss is a data variant

The tool MUST list each identifier that matches no gene in `notFound`, and it
MUST NOT drop the miss. MyGene marks a miss in the batch answer with
`notfound: true`, and it answers HTTP 200.

#### Scenario: A partial batch reports its misses

- **WHEN** the batch holds `BRCA1` and `NOTAGENE123`
- **THEN** `genes` holds the hit of `BRCA1`, and `notFound` is `["NOTAGENE123"]`

#### Scenario: No identifier matches

- **WHEN** no identifier of the batch matches a gene
- **THEN** the tool returns `ok({ genes: [], notFound, ambiguous: [], truncated: [] })`, not an error

### Requirement: An unexpected failure is an error tool result

`execute` MUST throw an HTTP error, a timeout, an exhausted retry, and a payload
that the schema refuses. An HTTP 400 carries the message of MyGene, for example
for an unknown species, and the error text MUST hold that message.

#### Scenario: An unknown species is an error

- **WHEN** MyGene answers HTTP 400 with `cannot map some species to taxids.`
- **THEN** `execute` throws, and the error text holds that message

#### Scenario: A server error surfaces as an error tool result

- **WHEN** MyGene answers with a 5xx after the retries
- **THEN** `execute` throws, and the agent loop records the call as `tool_result { is_error: true }`

### Requirement: The client obeys the absence policy of MyGene

The client schema MUST mark each field of a hit as `.optional()`, because MyGene
omits the key of an absent value. A comment at the top of the client MUST name
that policy. The client MUST read `entrezgene` with the shared wire-number
helper, because MyGene sends it as a string.

`ensembl` arrives as one object or as an array of objects. `uniprot.Swiss-Prot`
arrives as one string or as an array. The client MUST map each to an array, in
the wire order.

#### Scenario: An Ensembl-only gene parses

- **WHEN** a hit carries only `_id` and `ensembl`
- **THEN** the mapped hit has `symbol: null`, `name: null`, `entrez: null`, and `uniprot: []`

#### Scenario: A gene on alternate haplotypes parses

- **WHEN** the `ensembl` of a hit is an array, as for `HLA-A`
- **THEN** the mapped `ensembl` holds each gene ID of the array

### Requirement: The tool declares the type of its ok value

The tool MUST declare the schema of its ok value. Thus the catalog of
`run_script` shows the result type in the signature of the tool. A field of the
result type MUST NOT have the name `description`, because the catalog removes
each key of that name as prose.

#### Scenario: The catalog shows the result type

- **WHEN** the catalog of `run_script` is built over the tool
- **THEN** the signature of `resolve_gene_ids` shows its result type, not `unknown`

#### Scenario: A script passes the Entrez IDs to humanbase

- **WHEN** one script calls `resolve_gene_ids` with `["BRCA1", "NOTAGENE123"]`, and then calls `humanbase` with the `entrez` of each hit
- **THEN** the script gives the network of BRCA1, and it reads `NOTAGENE123` in `notFound`

### Requirement: The call detail names the identifiers

The `describeCall` hook MUST list a batch of at most 8 identifiers in full. For a
larger batch, the detail MUST give the count and the first 8 identifiers.

#### Scenario: The detail of a large batch

- **WHEN** the tool is called with 10 identifiers, `G1` to `G10`
- **THEN** the call detail is `10 genes: G1, G2, G3, G4, G5, G6, G7, G8, …`

### Requirement: The conversation agent and the network agent get the tool

The conversation agent MUST have `resolve_gene_ids` as a script tool, thus it
calls the tool from `run_script` (refer to the script-tools capability).

`SandboxToolName` MUST have `resolveGeneIds`, and the sandbox registry MUST map
that name to the tool. The network agent MUST list `resolveGeneIds` in
`meta.tools`, because it holds `humanbase`, and `humanbase` takes Entrez IDs
only.

#### Scenario: The conversation agent has the tool in a script

- **WHEN** the conversation agent is made
- **THEN** its script tools include `resolve_gene_ids`, and its tools do not

#### Scenario: The network agent has the tool in a script

- **WHEN** the network agent is made
- **THEN** its script tools include `resolve_gene_ids`

#### Scenario: A different sandbox agent does not get the tool

- **WHEN** a sandbox agent does not list `resolveGeneIds` in `meta.tools`
- **THEN** its tools and its script tools do not include `resolve_gene_ids`
