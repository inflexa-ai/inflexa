# Design

## Context

The research in `docs/web-search-research.md` fixes the scope: two tools, SearXNG as the only engine, `searxng.ts` / `ssrf-protection.ts` / `extract.ts` of `nicobailon/pi-web-access` as the reference, and no `pi-web-access` dependency (it is a Pi extension, not a library). The harness already holds the pieces around the two tools: `apiFetchValidated` (`src/tools/lib/api-utils.ts`), the tool factory pattern (`src/tools/research/search-github-repos.ts`), the approval contract (`src/tools/approval/contract.ts`), the tool output store (`src/loop/tool-output.ts`), and `pdf-parse` (`src/lib/regulatory-corpus/fetch-ich.ts`).

## Goals / Non-Goals

**Goals:**

- Two conversation-agent tools that hold the house error contract: a refusal, an HTTP error, and an absence are normal results.
- An address guard that checks the address the connection uses, before the TCP connect, with a user approval for the guarded addresses.
- A recorded-response test suite: no test reaches the network.

**Non-Goals:**

- `includeContent` (the agent selects the pages), the GitHub clone, the video extraction, the authenticated fetch, and the other search providers.
- Defuddle as a second extractor; Readability plus one fallback is enough.
- A proxy, cookies, or a page cache.

## Decisions

### `web_search` rides `apiFetchValidated` with `maxRetries: 0`

The tool calls `GET {base}/search?q=…&format=json` through `apiFetchValidated` with a zod schema over the envelope (`results`, `answers`; every field optional, because SearXNG omits what no engine returned; an answer is an object of a changing shape, so the schema accepts it loosely and the mapper keeps the `answer` text and the optional `url`). `maxRetries: 0`, because a body that will not parse is a deterministic failure that a retry cannot fix, and a transient failure is cheap for the model to retry as a new tool call. The tool maps the `ApiError` variants to its own error texts, one bucket per variant: `http_status` → the status and the first 300 characters of the body; `invalid_response` → a schema-mismatch text; `exhausted` whose last error is an `HTTP <status>` form (a retryable status that spent its single attempt, because the helper reports a spent retryable status as `exhausted`, not as `http_status`) → a text that names that status; every other `exhausted` and every `timeout` → "SearXNG did not answer with a valid JSON body" carrying the last error. The last bucket is what a JSON-less 200 body produces (`res.json()` throws inside the helper), and its text never depends on the parse-error message of a runtime. A transport failure shares the bucket, because the helper reports the two through one channel; both are distinct from the HTTP-status texts.

The base URL rules follow the reference: accept only `http:` and `https:`, refuse a user name or a password, strip the query and the fragment. The recency filter maps to `time_range`; the domain filter adds `site:` / `-site:` terms and filters by host again after the response. The input bounds `queries` at 5 and the tool runs the queries in one pass, merges the answers, merges the results in query order, removes duplicates by URL, and cuts the merged list at `numResults` in total, so the tool output stays bounded whatever the count of queries.

### `web_fetch` uses `node:http`/`node:https` with a `lookup` hook, not `fetch`

`fetch` (undici) hides the resolved address, so a separate DNS check reads one answer and the connection uses another — DNS rebinding. The `lookup` option of `node:http`/`node:https` hands the tool the addresses the connection is about to use; the guard classifies EVERY address of a resolution and destroys the request before the TCP connect when ANY of them is guarded and not approved — the connect layer can fall back to a later address after an earlier one fails, so a first-address-only check is a bypass. The connection layer runs no lookup for an IP-literal host (verified on Node 24 and Bun 1.4: the hook runs for a name, never for `127.0.0.1` or `::1`), so the tool classifies a literal host itself — brackets removed, the IPv4-mapped form normalized — before it sends the request. The two checks together cover every address the connection can use, and each redirect hop is a new request through the same pair.

The guarded sequence never asks inside a live socket: the tool first checks the per-call approved-origin set (an `always` or a `once` of this call), then sends; when a check finds a guarded address that is not approved, it destroys the request first, asks with no request open, and on approval records the origin in the per-call set and sends the hop again. The per-hop timeout therefore never races a user who reads the prompt.

### The guarded-address check is a pure function over one address

`isGuardedAddress(ip)` classifies the ranges the spec pins — a subset of the special-purpose address ranges of the IANA registries, chosen so that every range that can route to a private host is guarded (the NAT64 prefixes included). No new dependency: `net.isIP` plus the range table. The IPv4-mapped IPv6 form (`::ffff:10.0.0.1`) normalizes to its IPv4 half before the check.

### The approval is one `ctx.ask` per guarded origin, keyed by origin

Before a guarded connection, the tool calls `ctx.ask` with the concrete URL as `command`, `grantKey = web_fetch:<scheme>://<host>:<port>`, and a `detail` that names the origin an `always` answer approves — the tool-approval spec makes that breadth visible in the request content. An `always` answer therefore covers the origin, and a different origin asks again. The tool catches `AskRejectedError` (a denial, or `UnavailableAsk` on a host with no surface) and returns the refusal as a normal result with the user feedback when the reply carried one — the issue text decides this: "A refused URL, a denied approval, or an HTTP error is a normal result, not a failure of the turn."

### Redirects are followed in the tool, bounded at 5

Node follows no redirect on its own. On a 3xx with a `location`, the tool resolves the target against the current URL and repeats the whole per-hop sequence: scheme check, guarded-address check with approval, byte limits. A chain that needs a sixth redirect is refused as a normal result that names the limit. Cross-origin redirect headers are not carried forward; the tool sends a fixed minimal header set per hop (the harness user agent, an `Accept` for HTML/PDF/text, `Accept-Encoding: identity`).

### Byte limits are enforced before and during the read, on the decoded body

Per hop: a `Content-Length` over the limit refuses the body at once; the reader also counts decoded bytes and destroys the request when the count passes the limit. `node:http` decodes no content encoding, so the tool asks for `identity` and decodes gzip, deflate, and brotli itself with `node:zlib` when a server sends them anyway — the limits and the extraction read the decoded bytes, and a compressed bomb stops at the decoded limit. The limit comes from the content type: 5 MB for HTML and text and for an unknown type, 20 MB for `application/pdf`. The content type governs; the tool sniffs no magic bytes, so a PDF sent as `application/octet-stream` ends as the unextractable result. A single timeout per hop (120 s) plus the loop `signal` aborts a stuck read.

### Extraction: Readability over `linkedom`, then Turndown; `pdf-parse` for PDF

HTML: `parseHTML` of `linkedom` → `Readability` article → Turndown Markdown; a null article falls back to the text content of the `body` element. PDF: the existing `pdf-parse` path, with the page cap of the library options set to 100, and the result names the cut when the PDF holds more pages. `text/*` and JSON bodies pass through. A content type the tool cannot extract is a normal result that names the type.

### The output is a status union; the text cut obeys the serialized cap

Both tools report each condition as an ok data variant with a `status` field and a text — no `error` field and no `success` boolean, the harness-tools contract — because the issue makes a refusal, a denied approval, and an HTTP error normal results that do not fail the turn. `web_fetch` returns at most 30,000 characters of the extracted text with the final URL, the content type, the total length, and a cut flag; when the serialized result would cross the loop cap (JSON escaping grows the text), the tool shrinks its own cut the way `read_tool_output` does, so the loop itself never re-cuts it. When the deps hold a tool output store, the tool puts `keptTextOf(text)` — the store keeps at most 1 MB, half head and half tail, the same rule the loop applies to a cut result — under `toolOutputRef(`${analysisId}:${invocationId}`)` with the `totalLength` and the `threadId` of the session, and returns the reference in the result. With no store, the result says that the remainder is not kept.

Both tools run in the default step mode: a replay returns the cached result and never re-runs the body, so a replayed `web_fetch` never asks again. The catch around `ctx.ask` takes only `AskRejectedError`; an abort of the turn propagates.

### Attach: one optional dep, one unconditional tool

`ConversationAgentDeps.searxngBaseUrl?: string` enables `web_search` (spread-conditional, the `toolOutputStore` pattern); `web_fetch` attaches always. Both sit in the roster directly after `searchArxivTool`. The barrel adds nothing: the conversation agent attaches both tools itself, and an embedder writes its composition root with the URL string alone, so the front-door rule of `harness-embedder-exports` admits no new name.

### The factory takes test doubles, and the tests use a real local server

`createWebFetchTool(deps)` accepts an optional `lookup` and an optional hop `request` beside the tool output store; the defaults are the real `dns.lookup` and the real `node:http`/`node:https` hop, so the shipped path is the tested path. The guarded-address tests run real requests against a local server on `127.0.0.1` (a guarded literal) and on `localhost` (a guarded name through the real lookup), and the DNS-rebinding case injects a `lookup` that answers a public address for the first request and a private address for the second — the second must ask. The unguarded-path and redirect tests use the injected hop with recorded responses, because every address a test machine owns is guarded.

## Risks / Trade-offs

- [The `lookup` hook covers TCP connects of `node:http`/`node:https` only, and a literal host runs no lookup] → The tool classifies a literal host itself before the request. A reviewer checks that every address the connection can use crosses one of the two checks.
- [Readability without a browser can mis-read a heavy page] → The fallback keeps raw text; the model still gets content, and `read_tool_output` pages through it.
- [A PDF above 100 pages is cut] → The result says so; the agent can name a page range in a later call if that is added. Accepting the cut is the scope decision of the issue.
- [SearXNG answer shapes drift between engine sets] → The schema keeps every field optional and the mapper drops a result that misses `url` or `title`, the `search_github_repos` absence policy.
