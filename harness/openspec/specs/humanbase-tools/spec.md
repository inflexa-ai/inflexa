# humanbase-tools Specification

## Purpose

Defines the harness tool `humanbase`, which reads the REST API of HumanBase
(`https://hb.flatironinstitute.org/api/`). HumanBase serves the GIANT functional
networks of [Greene and others, Nature Genetics 2015](https://www.nature.com/articles/ng.3259).
Each network is specific to one tissue, one cell type, or one biological
process. The weight of an edge is the posterior probability that the two genes
have a functional relation in that context. The STRING tool
`search_interactions` gives a network with no context. This tool gives the
network of one context, and it ranks the contexts for a gene set.

The tool is one tool with an `action` parameter, not three tools. One database
answers the three questions, and the header of the bio barrel
(`harness/src/tools/bio/index.ts`) gives the rule for that case. The `action` is
`network`, `relevant`, or `contexts`.

The slug of a context gives its GIANT version. Each v3 slug ends in `-v3`, and
no v1 slug does. The network endpoint refuses a `giant_version` that does not
agree with the slug. Thus the client derives the version from the slug, and the
tool has no input for the version.

The tool is a `defineTool` wrapper over the HumanBase client
(`harness/src/tools/lib/humanbase-client.ts`). The client uses the shared
`apiFetchValidated` boundary. An expected outcome is a data variant. `execute`
throws an unexpected failure, and the agent loop records it as
`tool_result { is_error: true }`. The tool never returns a `{ success, error }`
envelope.

HumanBase keys each gene on its NCBI Entrez Gene ID only. Thus the tool takes
Entrez IDs as numbers. Its description tells the agent to map a symbol or an
Ensembl ID with `resolve_gene_ids` first (refer to the mygene-tools capability).
The `entrez` field of each hit of that tool is the input of this tool.

Module detection (`POST /api/integrations/community/`) and NetWAS
(`POST /api/netwas/`) are out of scope. Each is an asynchronous job that answers
first and gives its result to a later poll. One tool call is one durable step,
and such a job does not fit in it.

## Requirements

### Requirement: The humanbase tool takes one input object with an action

The system MUST give one harness tool, `humanbaseTool`
(`harness/src/tools/bio/humanbase.ts`), with the on-wire id `humanbase`, built
with `defineTool`. The input is a flat object with an `action` of `network`,
`relevant`, or `contexts`. The schema MUST refuse a call that does not give the
argument of its action, before `execute` runs. The schema MUST also refuse an
argument that does not apply to the action.

#### Scenario: The input schema is an object

- **WHEN** the tool emits the JSON schema of its input
- **THEN** the schema has a top-level `"type": "object"`

#### Scenario: A network call without a context is refused

- **WHEN** the tool is called with `action: "network"` and no `context`
- **THEN** the input validation refuses the call with a message that names `context`, and `execute` does not run

#### Scenario: A network call with more than 30 genes is refused

- **WHEN** the tool is called with `action: "network"` and 31 Entrez IDs
- **THEN** the input validation refuses the call with a message that names the limit of 30, and `execute` does not run

### Requirement: The network action gives the subnetwork of one context

The `network` action MUST return
`ok({ found: true, context, giantVersion, mincut, genes, edges, totalEdges, notFound })`.
It takes 1 to 30 Entrez IDs (`entrez`), a context slug (`context`), and
`nodeSize`, the count of neighbor genes that HumanBase adds (default 10, max 50).

Each gene carries `entrez`, `symbol`, `description`, `ensembl`, `hgnc`, and
`query`. The value of `query` is false for a neighbor gene. Each edge carries
`geneA`, `geneB`, and `weight`. The edges are in the order of their weight,
highest first, and `limit` (default 50) trims them. `totalEdges` gives the count
before the trim. `notFound` lists each query ID that the answer does not hold.

The client MUST send each Entrez ID as a repeated `entrez` query parameter. The
client MUST send the `giant_version` that it derives from the slug.

#### Scenario: A v1 slug gives a v1 network

- **WHEN** the tool is called with `context: "blood"`
- **THEN** the request carries `giant_version=v1`, and `mincut` is a number

#### Scenario: A v3 slug gives a v3 network

- **WHEN** the tool is called with `context: "blood-v3"`
- **THEN** the request carries `giant_version=v3`, and `mincut` is `null`

#### Scenario: A query gene that the network does not hold

- **WHEN** `entrez` holds an ID that the answer does not hold
- **THEN** `notFound` lists that ID, and the other genes come back

#### Scenario: An HTTP 404 gives an empty data variant

- **WHEN** HumanBase answers HTTP 404 with `{"detail":"Not found."}`, for an unknown slug or for a gene set with no gene in the network
- **THEN** the tool returns `ok({ found: false, context })`, not an error

#### Scenario: An HTTP 400 is an error, not an absence

- **WHEN** HumanBase refuses the request with HTTP 400
- **THEN** `execute` throws, and the error text holds the message of HumanBase

### Requirement: The relevant action ranks the contexts for a gene set

The `relevant` action takes 1 to 200 Entrez IDs. It MUST return
`ok({ contexts, totalFound })`. Each context carries `slug`, `title`,
`giantVersion`, `term`, and `score`. The contexts are in the order of their
score, highest first, and `limit` (default 10) trims them. `totalFound` gives
the count before the trim. HumanBase ranks only the v1 contexts.

The client MUST post each Entrez ID as a JSON string, because HumanBase answers
a JSON number with HTTP 500.

#### Scenario: The request body holds strings

- **WHEN** the tool is called with `action: "relevant"` and `entrez: [3553, 672]`
- **THEN** the client posts `{"entrez":["3553","672"]}` to `/api/integrations/relevant/`

#### Scenario: A gene set that HumanBase does not know

- **WHEN** HumanBase knows none of the genes, and it answers HTTP 200 with `[]`
- **THEN** the tool returns `ok({ contexts: [], totalFound: 0 })`, not an error

### Requirement: The contexts action lists the context slugs

The `contexts` action MUST return `ok({ contexts, totalFound })`. The optional
`query` filters the list by a substring of the slug or the title, and the match
ignores the case. `limit` (default 20) trims the list, and `totalFound` gives
the count of the filtered list.

Each context carries `slug`, `title`, `giantVersion`, and `term`. A v1 tissue
context carries a term of the BRENDA Tissue Ontology. A v1 process context
carries a GO term. A v3 context carries `term: null`.

#### Scenario: A query filters the list

- **WHEN** the tool is called with `action: "contexts"` and `query: "liver"`
- **THEN** the list holds `liver` and `liver-v3`

#### Scenario: A query that matches no context

- **WHEN** no slug and no title holds the query
- **THEN** the tool returns `ok({ contexts: [], totalFound: 0 })`

### Requirement: An unexpected failure is an error tool result

`execute` MUST throw an unexpected failure. An HTTP status that is not 404, a
timeout, an exhausted retry, and a payload that the schema refuses are
unexpected failures.

#### Scenario: A server error surfaces as an error tool result

- **WHEN** HumanBase answers with a 5xx after the retries
- **THEN** `execute` throws, and the agent loop records the call as `tool_result { is_error: true }`

### Requirement: The client obeys the absence policy of HumanBase

The client schema MUST mark `mincut`, `term`, and `version` as `.nullable()`,
because HumanBase keeps the key of an absent value and sends an explicit `null`.
A comment at the top of the client MUST name that policy.

#### Scenario: The null mincut of a v3 network parses

- **WHEN** a v3 network payload carries `"mincut": null`
- **THEN** the schema parses the payload, and the mapped `mincut` is `null`

### Requirement: The call detail names the action and the genes

The `describeCall` hook MUST name the action and its subject. The subject is the
context and the Entrez IDs for `network`, the Entrez IDs for `relevant`, and the
query for `contexts`. For a set of more than 8 IDs, the detail gives the count
and the first 8 IDs.

#### Scenario: The detail of a network call

- **WHEN** the tool is called with `action: "network"`, `context: "blood"`, and `entrez: [672, 3553]`
- **THEN** the call detail is `network blood: 672, 3553`

### Requirement: The tool declares the type of its ok value

The tool MUST declare the schema of the ok value of each action. Thus the
catalog of `run_script` shows the result type in the signature of the tool. The
ok value of each action MUST obey that schema.

#### Scenario: The catalog shows the result type

- **WHEN** the catalog of `run_script` is built over the tool
- **THEN** the signature of `humanbase` shows its result type, not `unknown`

#### Scenario: Each ok value obeys the schema

- **WHEN** each action gives an ok value, the found and the absent network included
- **THEN** the output schema of the tool accepts the value

### Requirement: The conversation agent and the network agent get the humanbase tool

The conversation agent MUST have `humanbase` as a script tool, thus it calls the
tool from `run_script` (refer to the script-tools capability).

`SandboxToolName` MUST have `humanbase`, and the sandbox registry MUST map that
name to the tool. The network agent MUST list `humanbase` in `meta.tools`. A
sandbox script cannot reach the web. Thus the tool on the host is the only path
of the network agent to a network of one tissue. The prompt
of the network agent MUST tell it when to use `humanbase`: for the network of
hub genes in one tissue or cell type, and for the tissues that a module points
to.

#### Scenario: The conversation agent has the tool in a script

- **WHEN** the conversation agent is made
- **THEN** its script tools include `humanbase`, and its tools do not

#### Scenario: The network agent has the tool in a script

- **WHEN** the network agent is made
- **THEN** its script tools include `humanbase`

#### Scenario: A different sandbox agent does not get the tool

- **WHEN** a sandbox agent does not list `humanbase` in `meta.tools`
- **THEN** its tools and its script tools do not include `humanbase`
