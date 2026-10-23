# Spec Delta

## Purpose

Give the conversation agent the two steps of web research: a search that names pages through SearXNG, and a page fetch that reads a selected page under an address guard, size limits, and extraction to text.

## ADDED Requirements

### Requirement: `web_search` searches SearXNG through the validated HTTP helper

The harness SHALL provide a `web_search` tool that calls the SearXNG instance of the embedder (`GET {base}/search` with `format=json`) through `apiFetchValidated` with a zod schema over the response. The input SHALL accept `query` or `queries` (at most 5), `numResults` from 1 to 20 with a default of 5, `recencyFilter` with the values `day`, `week`, `month`, and `year`, and `domainFilter` where a `-` prefix excludes a domain. The tool SHALL map each result to `title`, `url`, and `snippet` and SHALL return the `answers` of SearXNG, each answer mapped to its `answer` text and its optional `url`, and an answer that carries neither SHALL be dropped. With more than one query, the tool SHALL run each query, merge the answers, and merge the results in query order with duplicates by URL removed; the merged list SHALL hold at most `numResults` results in total, whatever the count of queries. The domain filter SHALL add `site:` and `-site:` terms to the query and SHALL filter the results by host again, because an engine can ignore `site:`; a domain SHALL match the host of a result and each subdomain of the domain. The recency filter SHALL map to the SearXNG `time_range` parameter.

An empty result list SHALL be a normal result, and the tool description SHALL say so. An HTTP error, a retryable status that spends its attempt, a schema mismatch, and a body that is not JSON SHALL each be a normal result with its own error text: the HTTP error names the status and a bounded excerpt of the body; the retryable status names the status; the schema mismatch names the schema; the not-JSON bucket names that the body was not valid JSON (with the transport failure in the same bucket, because the HTTP helper reports the two through one channel). None is a failure of the turn. Each condition SHALL ride the ok channel as a data variant with a status field and a text — never an `err`, never a throw, and never an `error` field or a `success` boolean on the ok output (the harness-tools contract).

#### Scenario: A search returns answers and results

- **WHEN** the model calls `web_search` with a query and the SearXNG instance answers with results
- **THEN** the tool returns the answers and a list of results with `title`, `url`, and `snippet`, at most `numResults` of them

#### Scenario: An empty result is normal

- **WHEN** SearXNG answers with no result for a query
- **THEN** the tool returns an empty result list as a normal result

#### Scenario: The domain filter excludes a domain

- **WHEN** the model calls `web_search` with a `domainFilter` of `-example.com`
- **THEN** the query gains a `-site:example.com` term and no result of `example.com` is returned

#### Scenario: Several queries merge into one bounded list

- **WHEN** the model calls `web_search` with two queries and `numResults` of 5
- **THEN** the answers of both queries merge, the results merge in query order with duplicates by URL removed, and the merged list holds at most 5 results in total

#### Scenario: An HTTP error is a normal result

- **WHEN** SearXNG answers with an HTTP error status
- **THEN** the tool returns the status and a bounded excerpt of the body as a normal result, and the turn does not fail

#### Scenario: A body that is not JSON is a normal result

- **WHEN** SearXNG answers with a body that is not JSON
- **THEN** the tool returns an error text that names that the body was not valid JSON, as a normal result, distinct from the HTTP error text

### Requirement: `web_search` attaches only when the embedder gives a base URL

The conversation agent deps SHALL accept an optional SearXNG base URL. When the embedder gives no URL, `web_search` SHALL NOT attach to any roster, and its description SHALL never enter a model context. When the embedder gives a URL, `web_search` SHALL attach to the conversation agent only.

#### Scenario: No URL, no tool

- **WHEN** the composition runs with no SearXNG base URL
- **THEN** the conversation agent roster holds no `web_search`

#### Scenario: A URL attaches the tool

- **WHEN** the composition runs with a SearXNG base URL
- **THEN** the conversation agent roster holds `web_search`

### Requirement: `web_fetch` reads one URL under a guarded-address approval

The harness SHALL provide a `web_fetch` tool that reads one URL. The tool SHALL accept only the `http:` and `https:` schemes and SHALL refuse any other scheme as a normal result.

The tool SHALL classify each address that the connection uses — loopback, private, link-local, shared, multicast, and reserved ranges, IPv4 and IPv6 — as a guarded address. The check SHALL run on the address that the connection uses, not on a separate name resolution, so a name that resolves differently between the check and the connection (DNS rebinding) cannot bypass the guard. For a host that is an IP literal, the tool SHALL classify the literal itself before it sends the request, because the connection layer runs no name lookup for a literal. For a host name, the check SHALL run in the lookup of the connection, and a name SHALL be guarded when ANY address of its resolution is guarded: the check SHALL classify every address the resolver returns before the connect, because the connect layer can fall back to a later address of the list after an earlier one fails. Before the tool connects to a guarded address, it SHALL ask the user through the tool approval contract; an `always` approval SHALL apply to the origin of the URL through the grant key, and an origin that was never approved SHALL ask again. The request content SHALL make that breadth visible: the detail of the ask SHALL name the origin that an `always` answer approves. When the host has no interactive surface (`UnavailableAsk`), the tool SHALL refuse the guarded address as a normal result.

A refused URL, a denied approval, and an HTTP error SHALL be normal results, never a failure of the turn.

#### Scenario: A public URL is fetched without a prompt

- **WHEN** the model calls `web_fetch` on a public `https:` URL
- **THEN** the tool fetches it with no approval prompt

#### Scenario: A guarded address asks first

- **WHEN** the model calls `web_fetch` on `127.0.0.1`, `169.254.169.254`, `10.0.0.1`, `[::1]`, or `[::ffff:169.254.169.254]` (each an IP literal, the mapped form normalized to its IPv4 half), or on a name that resolves to a guarded address
- **THEN** the tool asks the user before it fetches, and it fetches only after an approval

#### Scenario: A resolution with one guarded address is guarded

- **WHEN** a host name resolves to a public address and a guarded address, and the connect falls back to the guarded address
- **THEN** the tool asked the user before any connect of that hop, because the check classified both addresses of the resolution

#### Scenario: The ask names the breadth of an always answer

- **WHEN** the tool asks for a guarded origin
- **THEN** the detail of the ask names the origin that an `always` answer approves

#### Scenario: A denied approval is a normal result

- **WHEN** the user denies the approval of a guarded address
- **THEN** the tool returns a refusal as a normal result, and the turn does not fail

#### Scenario: `UnavailableAsk` refuses the guarded address

- **WHEN** the host wires no interactive surface and the model calls `web_fetch` on a guarded address
- **THEN** the tool refuses the address as a normal result

#### Scenario: An `always` approval is scoped to the origin

- **WHEN** the user answers `always` for one origin
- **THEN** a later fetch of that origin asks nothing, and a fetch of a different origin asks again

#### Scenario: The scheme is checked

- **WHEN** the model calls `web_fetch` on a `file:` or `ftp:` URL
- **THEN** the tool refuses the URL as a normal result

### Requirement: `web_fetch` follows redirects under the same guard

The tool SHALL follow at most 5 redirects, in the tool code. For each redirect target, the tool SHALL repeat the whole per-hop sequence: scheme check, guarded-address check (the literal itself for a literal host, the lookup of the connection for a name), and the approval of the target origin. A chain that needs a sixth redirect SHALL end as a normal result that names the redirect limit.

#### Scenario: A redirect to a guarded address asks first

- **WHEN** a public URL redirects to `127.0.0.1` or another guarded address
- **THEN** the tool asks the user before it follows the redirect, and it follows only after an approval

#### Scenario: Five redirects succeed, the sixth is refused

- **WHEN** a URL redirects 5 times to a public address, or 6 times
- **THEN** the tool follows at most 5 redirects, and a chain that needs a sixth ends as a normal result that names the redirect limit

### Requirement: `web_fetch` bounds the body and extracts text

The tool SHALL refuse a body larger than 5 MB for HTML and text, larger than 20 MB for a PDF, and larger than 5 MB for an unknown content type. A body of at most the limit succeeds; the byte that passes the limit stops the read and refuses the body. The limits SHALL apply to the decoded body: the tool asks for no compression, and it decodes gzip, deflate, and brotli when a server sends them anyway. The tool SHALL read at most the first 100 pages of a PDF, and the result of a cut PDF SHALL name the cut. HTML SHALL become Markdown through a readability extraction and a Markdown conversion over a DOM that needs no browser. A PDF SHALL be read with the PDF parser the harness already holds. A plain-text or JSON body SHALL pass through. A body type the tool cannot extract SHALL end as a normal result that names the content type.

The tool SHALL return at most 30,000 characters of the extracted text, with the final URL, the content type, the total length of the text, whether the text was cut, and, when the tool output store is present, a reference through which `read_tool_output` reads the kept remainder. The store keeps at most 1 MB of a text, its first half and its last half, the bound that `read_tool_output` already documents. When no store is present, the result SHALL say that the remainder is not kept.

#### Scenario: An oversized HTML body is refused

- **WHEN** a page answers with an HTML body larger than 5 MB
- **THEN** the tool refuses the body as a normal result and reads no further

#### Scenario: A body at the limit succeeds

- **WHEN** a page answers with a body of exactly the limit
- **THEN** the tool reads the body and extracts its text

#### Scenario: A compressed body counts after decoding

- **WHEN** a page answers with a gzip body that decodes past the limit
- **THEN** the tool stops the read and refuses the body as a normal result

#### Scenario: An oversized PDF body is refused

- **WHEN** a page answers with a PDF body larger than 20 MB
- **THEN** the tool refuses the body as a normal result

#### Scenario: HTML becomes Markdown

- **WHEN** a page answers with HTML
- **THEN** the tool returns Markdown of the readable article

#### Scenario: A PDF becomes text

- **WHEN** a page answers with a PDF
- **THEN** the tool returns text of at most the first 100 pages, and the result names the cut when the PDF holds more pages

#### Scenario: The kept text is readable

- **WHEN** the extracted text is longer than 30,000 characters and the tool output store is present
- **THEN** the tool returns the first 30,000 characters and a reference, and `read_tool_output` reads what the store kept of the remainder, within the 1 MB bound of the store

#### Scenario: No store, no remainder

- **WHEN** the extracted text is longer than 30,000 characters and no tool output store is present
- **THEN** the tool returns the first 30,000 characters and says that the remainder is not kept

#### Scenario: An HTTP error is a normal result

- **WHEN** the URL answers with an HTTP error status
- **THEN** the tool returns the status as a normal result, and the turn does not fail

### Requirement: `web_fetch` attaches without a SearXNG URL

`web_fetch` SHALL attach to the conversation agent roster regardless of the SearXNG base URL, because it reads a URL the model or the user selects, not a search result.

#### Scenario: `web_fetch` works without SearXNG

- **WHEN** the composition runs with no SearXNG base URL
- **THEN** the conversation agent roster holds `web_fetch`

### Requirement: The guarded-address ranges are pinned

The guarded-address classification SHALL cover exactly these ranges — a pinned subset of the special-purpose address ranges of the IANA registries. IPv4: `0.0.0.0/8`, `10.0.0.0/8`, `100.64.0.0/10`, `127.0.0.0/8`, `169.254.0.0/16`, `172.16.0.0/12`, `192.0.0.0/24`, `192.0.2.0/24`, `192.88.99.0/24`, `192.168.0.0/16`, `198.18.0.0/15`, `198.51.100.0/24`, `203.0.113.0/24`, `224.0.0.0/4`, `240.0.0.0/4`. IPv6: `::/128`, `::1/128`, `::ffff:0:0/96` (normalized to its IPv4 half first), `64:ff9b::/96`, `64:ff9b:1::/48`, `100::/64`, `2001::/32`, `2001:db8::/32`, `2002::/16`, `fc00::/7`, `fe80::/10`, `ff00::/8`. A public unicast address SHALL NOT be guarded.

#### Scenario: The ranges classify

- **WHEN** the classifier reads one address of each range, for example `127.0.0.1`, `10.0.0.1`, `192.168.1.1`, `172.16.0.1`, `169.254.169.254`, `100.64.0.1`, `0.0.0.0`, `224.0.0.1`, `240.0.0.1`, `::1`, `fc00::1`, `fe80::1`, `ff02::1`, and `::`
- **THEN** each address is guarded

#### Scenario: The boundary addresses classify

- **WHEN** the classifier reads the first and the last address of each range of the table, for example `9.255.255.255` and `10.0.0.0`, or `100.63.255.255` and `100.64.0.0`
- **THEN** each address inside a range is guarded and each address outside every range is not guarded

#### Scenario: A public address is not guarded

- **WHEN** the classifier reads `93.184.216.34` or `2606:2800:220:1:248:1893:25c8:1946`
- **THEN** the address is not guarded
