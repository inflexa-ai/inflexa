# literature-search Specification

## Purpose

Defines the PubMed/PMC literature tool `pubmed`, which lets agents discover,
inspect, and read scientific articles via the NCBI E-utilities. Its `action` is
`search`, `details`, or `fulltext`. The tool is a `defineTool` factory closure
(`createPubMedTool`) over the shared pure-async PubMed client
(`harness/src/tools/lib/pubmed-client.ts`); XML parsing lives in
`harness/src/tools/lib/ncbi-utils.ts`. The factory is assembled by
`createNcbiTools(keys)` in `harness/src/tools/bio/keys.ts`.

There is no `config/env.ts` and no `NCBI_API_KEY` env read inside the harness.
The optional NCBI key is threaded in as `BioToolKeys.ncbi` from the embedder's
composition root, captured by the factory as `deps.ncbiApiKey`, and appended as
the `api_key` query parameter by `ncbiUrl(apiKey, …)` only when present —
absent, the tool still functions at NCBI's lower anonymous rate limit.

The tools follow the harness tool-error contract: expected outcomes are returned
as data variants (an empty `results` array, a `notFound` list of unmatched
PMIDs, or `{ available: false }` for a non-open-access article), and unexpected
upstream failures are thrown out of `execute` so the agent loop wraps them as
`tool_result { is_error: true }`. No tool returns a self-authored
`{ success, error }` envelope.

## Requirements

### Requirement: The search action of the pubmed tool

The system MUST give `createPubMedTool({ ncbiApiKey })` (`harness/src/tools/bio/pubmed.ts`), with the on-wire id `pubmed`, built with `defineTool`. `createNcbiTools(keys)` in `harness/src/tools/bio/keys.ts` builds it. The input is a flat object with an `action` of `search`, `details`, or `fulltext`. The schema refuses a call that does not give the argument of its action, before `execute` runs.

The `search` action searches PubMed through the E-utilities `esearch` and `esummary` endpoints. It takes `query` (PubMed syntax: MeSH terms, field tags, and Boolean operators), `maxResults` (default 10, max 50), `sort` (`relevance` or `date`, default `relevance`), and an optional `dateRange` of `{ from, to }` in the YYYY/MM/DD form. It MUST return `ok({ totalFound, results })`, where each result carries `pmid`, `title`, `journal`, `year`, and `authors`. The description of `query` MUST teach the PubMed query syntax (MeSH, `[Title/Abstract]`, `[Author]`, `[Gene]`, and the Boolean operators), thus the model writes an effective query.

#### Scenario: Basic keyword search

- **WHEN** the tool is called with `action: "search"`, `query: "BRCA1 breast cancer"`, and `maxResults: 5`
- **THEN** it returns `ok({ totalFound, results })` with up to 5 results, each having `pmid`, `title`, `journal`, `year`, and `authors`

#### Scenario: MeSH-qualified search with date range

- **WHEN** the tool is called with `action: "search"`, a MeSH query, `sort: "date"`, and `dateRange: { from: "2023/01/01", to: "2024/12/31" }`
- **THEN** it returns date-sorted results within the range, each with the standard fields

#### Scenario: No results found

- **WHEN** the query of a `search` matches no articles
- **THEN** it returns `ok({ totalFound: 0, results: [] })`

#### Scenario: Upstream error surfaces as an error tool result

- **WHEN** the NCBI API fails (5xx, timeout, or retry exhaustion)
- **THEN** `execute` throws and the agent loop records the call as `tool_result { is_error: true }`

#### Scenario: A call without the argument of its action is refused

- **WHEN** the tool is called with `action: "fulltext"` and no `pmcId`
- **THEN** the input validation refuses the call with a message that names `pmcId`, and `execute` does not run

### Requirement: The details action of the pubmed tool

The `details` action of the `pubmed` tool fetches the metadata of a batch of PMIDs through `efetch` (XML). It takes `pmids` (a string array, min 1, max 20), `maxAuthors` (default 5), and `maxMeshTerms` (default 10). It MUST return `ok({ articles, notFound })`, where each article carries `pmid`, `title`, `abstract`, `authors`, `authorCount`, `journal`, `year`, `doi`, `meshTerms`, `meshTermCount`, and `pmcId` (a string or null).

`authors` and `meshTerms` keep the leading entries up to `maxAuthors` and `maxMeshTerms`. `authorCount` and `meshTermCount` give the full counts. `pmcId` MUST come from the NCBI ID Converter (`idconv`), which the action calls in parallel with `efetch`. Each PMID with no returned article MUST be in `notFound`.

#### Scenario: Batch detail retrieval

- **WHEN** the tool is called with `action: "details"` and three valid PMIDs
- **THEN** it returns `ok({ articles, notFound })` with details for all three, each including `abstract`, `authors`, `meshTerms`, `doi`, and `pmcId`

#### Scenario: Mixed PMC availability

- **WHEN** some PMIDs have PMC full text and others do not
- **THEN** articles in PMC have a non-null `pmcId` (for example `"PMC1234567"`) and the rest have `pmcId: null`

#### Scenario: Invalid PMID in batch

- **WHEN** the tool is called with `action: "details"` and a mix of valid and invalid PMIDs
- **THEN** valid articles are returned in `articles` and unmatched PMIDs appear in `notFound`

#### Scenario: Batch size exceeded

- **WHEN** the tool is called with `action: "details"` and more than 20 PMIDs
- **THEN** Zod input validation rejects the request before `execute` runs

#### Scenario: A long author list is cut to the cap

- **WHEN** an article has 40 authors, and the call gives no `maxAuthors`
- **THEN** the article carries the first 5 authors, and `authorCount` is 40

### Requirement: The fulltext action of the pubmed tool

The `fulltext` action of the `pubmed` tool fetches the open-access full text from PMC through `efetch` with `db=pmc`. It takes one `pmcId`, an optional `sections` filter, and an optional `maxChars` (default 12,000, min 500, max 200,000). The `sections` filter holds case-insensitive substrings of the section headings.

When the article is open-access, the action MUST return `ok({ pmcId, available: true, fullText, outline, totalChars, returnedChars, truncated })`. `fullText` holds each admitted section under its heading. A section that the filter matches is admitted whole, in document order, when it fits in the rest of `maxChars`. The first matched section is admitted also when it alone is larger than `maxChars`. `outline` lists each section of the article with its size and whether it came back. `truncated` is true when `returnedChars` is less than `totalChars`.

When the article is not available, the action MUST return `ok({ pmcId, available: false })`. Figure and table markup MUST stay out of the plain-text body.

#### Scenario: Successful full text retrieval

- **WHEN** the tool is called with `action: "fulltext"` and a valid `pmcId` of an open-access article
- **THEN** it returns `ok({ pmcId, available: true, fullText, outline, totalChars, returnedChars, truncated })`

#### Scenario: Article not available in PMC

- **WHEN** the `pmcId` does not resolve to an open-access article
- **THEN** it returns `ok({ pmcId, available: false })`

#### Scenario: A section filter narrows the body

- **WHEN** the tool is called with `action: "fulltext"` and `sections: ["methods"]`
- **THEN** `fullText` holds only the sections whose heading contains "methods"
- **AND** `outline` lists each section of the article, with `included: false` for each other section

### Requirement: NCBI API key is threaded from the embedder

The harness SHALL NOT read `NCBI_API_KEY` from the environment. The optional key
SHALL be supplied by the embedder as `BioToolKeys.ncbi`, captured by each tool
factory as `deps.ncbiApiKey`, and applied as the `api_key` query parameter by
`ncbiUrl` only when present.

#### Scenario: API key present

- **WHEN** the embedder supplies `BioToolKeys.ncbi`
- **THEN** every E-utilities request includes `api_key={value}`

#### Scenario: API key absent

- **WHEN** `BioToolKeys.ncbi` is undefined
- **THEN** requests omit `api_key` and the tools function at the lower anonymous rate limit

### Requirement: Literature tools available to the conversation agent, sub-agents, and sandbox agents

The literature tool `pubmed` (`createNcbiTools`) MUST be a script tool of the
conversation agent (`harness/src/agents/conversation-agent.ts`), which calls it
from `run_script` (refer to the script-tools capability). It MUST be a declared
tool of the lookups of the run synthesizer
(`harness/src/tools/research/synthesis-lookups.ts`) and of the
analogical-reasoner sub-agent
(`harness/src/tools/research/generate-analogy-report.ts`). Sandbox agents
receive it through the central tool registry when their `meta.tools` allowlist
names it. The in-process report builder does not wire literature tools — it
reports on existing analysis artifacts only.

#### Scenario: Conversation agent can search literature

- **WHEN** the script tools of the conversation agent are inspected
- **THEN** they include `pubmed`, and the tools of the agent do not

#### Scenario: Sandbox agents get literature tools via the allowlist

- **WHEN** a sandbox agent declares `pubmed` in `meta.tools`
- **THEN** `createSandboxAgent` resolves it and adds it to the tool array of that agent

### Requirement: XML parsing for PubMed and PMC responses

The system SHALL parse PubMed `esummary`/`efetch` XML and PMC full-text XML in
`harness/src/tools/lib/ncbi-utils.ts`, handling the PubMed DTD structures
(MedlineCitation, Article, Abstract, MeshHeadingList) and the PMC DTD structures
(body, sec, p).

#### Scenario: PubMed XML parsed to article details

- **WHEN** an `efetch` response contains a `PubmedArticleSet` document
- **THEN** the parser extracts `title`, `abstract`, `authors`, `journal`, `year`, `doi`, and `meshTerms` per article

#### Scenario: PMC XML parsed to full text

- **WHEN** an `efetch` PMC response contains a `pmc-articleset` document
- **THEN** the parser extracts section `heading`/`text` and the body, omitting figure/table markup

### Requirement: Citation verification is distinct from literature discovery

The literature surface SHALL expose a `resolve_citation` tool backed by the shared `CitationResolver`. The tool SHALL accept one evidence-preserving citation input and SHALL return structured source outcomes, records, field comparisons, coverage, conflicts, and verdict without flattening them into an unsupported binary existence claim. Existing search, article-detail, and full-text tool contracts SHALL remain unchanged.

#### Scenario: Conversation agent verifies a supplied citation

- **WHEN** the conversation agent calls `resolve_citation` with a user-supplied reference
- **THEN** the tool returns the shared resolver's structured result for that reference
- **AND** the result distinguishes `not_found` from `inconclusive`

#### Scenario: Search behavior is unchanged

- **WHEN** an agent needs papers about a topic rather than verification of one supplied reference
- **THEN** the existing literature-search tools remain available with their existing inputs and outputs

### Requirement: Literature consumers share one wire client per authority

The harness SHALL implement arXiv, Semantic Scholar, and PubMed endpoint
construction, wire validation/parsing, injected HTTP transport, timeout
handling, and caller cancellation once per authority in a source client that is
independent of agent tools and citation-resolution policy. Existing discovery
tools and citation adapters SHALL delegate those operations to the shared source
client while retaining their distinct public contracts. Neither consumer SHALL
import the other.

#### Scenario: An authority response contract changes

- **WHEN** an arXiv, Semantic Scholar, or PubMed wire schema or parser is updated
- **THEN** the change is made in that authority's shared source client
- **AND** both discovery and citation verification consume the same updated interpretation

#### Scenario: Discovery and verification expose different contracts

- **WHEN** an agent searches for papers and a workflow verifies a supplied citation
- **THEN** the discovery tool retains its existing input and output envelope
- **AND** the citation adapter retains source applicability, evidence status, and citation-record mapping
- **AND** both operations use the same authority transport and parser without invoking each other
