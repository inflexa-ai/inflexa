# literature-search Specification

## Purpose

Defines the three PubMed/PMC literature tools — `search_pubmed`,
`get_article_details`, and `get_article_full_text` — that let agents discover,
inspect, and read scientific articles via the NCBI E-utilities. Each tool is a
`defineTool` factory closure (`createSearchPubMedTool`,
`createGetArticleDetailsTool`, `createGetArticleFullTextTool`) over the shared
pure-async PubMed client (`harness/src/tools/lib/pubmed-client.ts`); XML parsing
lives in `harness/src/tools/lib/ncbi-utils.ts`. The factories are assembled by
`createNcbiTools(keys)` in `harness/src/tools/bio/keys.ts`.

There is no `config/env.ts` and no `NCBI_API_KEY` env read inside the harness.
The optional NCBI key is threaded in as `BioToolKeys.ncbi` from the embedder's
composition root, captured by each factory as `deps.ncbiApiKey`, and appended as
the `api_key` query parameter by `ncbiUrl(apiKey, …)` only when present —
absent, the tools still function at NCBI's lower anonymous rate limit.

The tools follow the harness tool-error contract: expected outcomes are returned
as data variants (an empty `results` array, a `notFound` list of unmatched
PMIDs, or `{ available: false }` for a non-open-access article), and unexpected
upstream failures are thrown out of `execute` so the agent loop wraps them as
`tool_result { is_error: true }`. No tool returns a self-authored
`{ success, error }` envelope.

## Requirements

### Requirement: search_pubmed tool

The system SHALL provide `createSearchPubMedTool({ ncbiApiKey })` (on-wire id
`search_pubmed`, built with `defineTool`) that searches PubMed via the
E-utilities `esearch` + `esummary` endpoints. It accepts `query` (PubMed syntax —
MeSH terms, field tags, Boolean operators), `maxResults` (default 10, max 50),
`sort` (`relevance` | `date`, default `relevance`), and an optional `dateRange`
of `{ from, to }` in YYYY/MM/DD form. It SHALL return `ok({ totalFound, results })`
where each result carries `pmid`, `title`, `journal`, `year`, and `authors`. The
description SHALL teach PubMed query syntax (MeSH, `[Title/Abstract]`,
`[Author]`, `[Gene]`, Boolean operators) so the model builds effective queries.

#### Scenario: Basic keyword search

- **WHEN** the tool is called with `query: "BRCA1 breast cancer"` and `maxResults: 5`
- **THEN** it returns `ok({ totalFound, results })` with up to 5 results, each having `pmid`, `title`, `journal`, `year`, and `authors`

#### Scenario: MeSH-qualified search with date range

- **WHEN** the tool is called with a MeSH query, `sort: "date"`, and `dateRange: { from: "2023/01/01", to: "2024/12/31" }`
- **THEN** it returns date-sorted results within the range, each with the standard fields

#### Scenario: No results found

- **WHEN** the query matches no articles
- **THEN** it returns `ok({ totalFound: 0, results: [] })`

#### Scenario: Upstream error surfaces as an error tool result

- **WHEN** the NCBI API fails (5xx, timeout, or retry exhaustion)
- **THEN** `execute` throws and the agent loop records the call as `tool_result { is_error: true }`

### Requirement: get_article_details tool

The system SHALL provide `createGetArticleDetailsTool({ ncbiApiKey })` (on-wire
id `get_article_details`, built with `defineTool`) that fetches metadata for a
batch of PMIDs via `efetch` (XML). It accepts `pmids` (string array, min 1, max
20) and SHALL return `ok({ articles, notFound })` where each article carries
`pmid`, `title`, `abstract`, `authors`, `journal`, `year`, `doi`, `meshTerms`,
and `pmcId` (string or null). `pmcId` SHALL be resolved via the NCBI ID Converter
(`idconv`), called in parallel with `efetch`. PMIDs with no returned article
SHALL be listed in `notFound`.

#### Scenario: Batch detail retrieval

- **WHEN** the tool is called with three valid PMIDs
- **THEN** it returns `ok({ articles, notFound })` with details for all three, each including `abstract`, `authors`, `meshTerms`, `doi`, and `pmcId`

#### Scenario: Mixed PMC availability

- **WHEN** some PMIDs have PMC full text and others do not
- **THEN** articles in PMC have a non-null `pmcId` (e.g. `"PMC1234567"`) and the rest have `pmcId: null`

#### Scenario: Invalid PMID in batch

- **WHEN** the tool is called with a mix of valid and invalid PMIDs
- **THEN** valid articles are returned in `articles` and unmatched PMIDs appear in `notFound`

#### Scenario: Batch size exceeded

- **WHEN** the tool is called with more than 20 PMIDs
- **THEN** Zod input validation rejects the request before `execute` runs

### Requirement: get_article_full_text tool

The system SHALL provide `createGetArticleFullTextTool({ ncbiApiKey })` (on-wire
id `get_article_full_text`, built with `defineTool`) that fetches open-access
full text from PMC via `efetch` with `db=pmc`. It accepts a single `pmcId`. When
the article is open-access it SHALL return
`ok({ pmcId, available: true, fullText, sections })`, where `sections` is an
array of `{ heading, text }`; when it is not available it SHALL return
`ok({ pmcId, available: false })`. Figure/table markup SHALL be omitted from the
plain-text body.

#### Scenario: Successful full text retrieval

- **WHEN** the tool is called with a valid `pmcId` for an open-access article
- **THEN** it returns `ok({ pmcId, available: true, fullText, sections })`

#### Scenario: Article not available in PMC

- **WHEN** the `pmcId` does not resolve to an open-access article
- **THEN** it returns `ok({ pmcId, available: false })`

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

The three literature tools SHALL be wired into the conversation agent
(`harness/src/agents/conversation-agent.ts`, via `createNcbiTools`), the
literature-reviewer sub-agent (`harness/src/tools/research/literature-reviewer.ts`),
and the analogical-reasoner sub-agent
(`harness/src/tools/research/generate-analogy-report.ts`); sandbox agents receive
them via the central tool registry when their `meta.tools` allowlist names them.
The in-process report builder does not wire literature tools — it reports on
existing analysis artifacts only.

#### Scenario: Conversation agent can search literature

- **WHEN** the conversation agent's tool array is inspected
- **THEN** it includes `search_pubmed`, `get_article_details`, and `get_article_full_text`

#### Scenario: Sandbox agents get literature tools via the allowlist

- **WHEN** a sandbox agent declares the literature tool names in `meta.tools`
- **THEN** `createSandboxAgent` resolves and adds them to that agent's tool array

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
