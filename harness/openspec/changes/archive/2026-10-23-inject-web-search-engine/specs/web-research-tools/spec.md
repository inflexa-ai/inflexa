# Spec Delta

## RENAMED Requirements

- FROM: `### Requirement: `web_search` attaches only when the embedder gives a base URL`
- TO: `### Requirement: `web_search` attaches only when the embedder injects a web-search engine`

## MODIFIED Requirements

### Requirement: `web_search` searches SearXNG through the validated HTTP helper

The harness SHALL provide a `web_search` tool that queries a web-search engine the embedder injects. The harness SHALL ship one realization of the engine, over the SearXNG instance of the embedder (`GET {base}/search` with `format=json` through the validated HTTP helper of the harness, with a zod schema over the response); an embedder can bind another realization. The input SHALL accept `query` or `queries` (at most 5), `numResults` from 1 to 20 with a default of 5, `recencyFilter` with the values `day`, `week`, `month`, and `year`, and `domainFilter` where a `-` prefix excludes a domain. The tool SHALL map each result to `title`, `url`, and `snippet` and SHALL return the `answers` of the engine, each answer mapped to its `answer` text and its optional `url`, and an answer that carries neither SHALL be dropped. With more than one query, the tool SHALL run each query, merge the answers, and merge the results in query order with duplicates by URL removed; the merged list SHALL hold at most `numResults` results in total, whatever the count of queries. The domain filter SHALL add `site:` and `-site:` terms to the query and SHALL filter the results by host again, because an engine can ignore `site:`; a domain SHALL match the host of a result and each subdomain of the domain. The recency filter SHALL pass through to the engine as the SearXNG `time_range` parameter in the shipped realization.

An empty result list SHALL be a normal result, and the tool description SHALL say so. An HTTP error, a retryable status that spends its attempt, a schema mismatch, and a body that is not JSON SHALL each be a normal result with its own error text: the HTTP error names the status and a bounded excerpt of the body; the retryable status names the status; the schema mismatch names the schema; the not-JSON bucket names that the body was not valid JSON (with the transport failure in the same bucket, because the HTTP helper reports the two through one channel). None is a failure of the turn. Each condition SHALL ride the ok channel as a data variant with a status field and a text — never an `err`, never a throw, and never an `error` field or a `success` boolean on the ok output (the harness-tools contract).

#### Scenario: A search returns answers and results

- **WHEN** the model calls `web_search` with a query and the engine answers with results
- **THEN** the tool returns the answers and a list of results with `title`, `url`, and `snippet`, at most `numResults` of them

#### Scenario: An empty result is normal

- **WHEN** the engine answers with no result for a query
- **THEN** the tool returns an empty result list as a normal result

#### Scenario: The domain filter excludes a domain

- **WHEN** the model calls `web_search` with a `domainFilter` of `-example.com`
- **THEN** the query gains a `-site:example.com` term and no result of `example.com` is returned

#### Scenario: Several queries merge into one bounded list

- **WHEN** the model calls `web_search` with two queries and `numResults` of 5
- **THEN** the answers of both queries merge, the results merge in query order with duplicates by URL removed, and the merged list holds at most 5 results in total

#### Scenario: An HTTP error is a normal result

- **WHEN** the engine's HTTP call answers with an HTTP error status
- **THEN** the tool returns the status and a bounded excerpt of the body as a normal result, and the turn does not fail

#### Scenario: A body that is not JSON is a normal result

- **WHEN** the engine's HTTP call answers with a body that is not JSON
- **THEN** the tool returns an error text that names that the body was not valid JSON, as a normal result, distinct from the HTTP error text

### Requirement: `web_search` attaches only when the embedder injects a web-search engine

The conversation agent deps SHALL accept an optional web-search engine. When the embedder injects no engine, `web_search` SHALL NOT attach to any roster, and its description SHALL never enter a model context. When the embedder injects an engine, `web_search` SHALL attach to the conversation agent only.

#### Scenario: No URL, no tool

- **WHEN** the composition runs with no web-search engine
- **THEN** the conversation agent roster holds no `web_search`

#### Scenario: A URL attaches the tool

- **WHEN** the composition runs with a web-search engine
- **THEN** the conversation agent roster holds `web_search`

### Requirement: `web_fetch` attaches without a SearXNG URL

`web_fetch` SHALL attach to the conversation agent roster regardless of the web-search engine, because it reads a URL the model or the user selects, not a search result.

#### Scenario: `web_fetch` works without SearXNG

- **WHEN** the composition runs with no web-search engine
- **THEN** the conversation agent roster holds `web_fetch`
