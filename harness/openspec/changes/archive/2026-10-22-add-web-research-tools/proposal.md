# Add the web research tools: `web_search` and `web_fetch`

## Why

The conversation agent has no tool that searches the web and no tool that reads a web page. A method question outside PubMed, a release note, or a hosted dataset page is a dead end. A search alone gives titles, URLs, and short snippets, thus the agent must also read the pages it selects. SearXNG is the only search engine: the harness cannot use `nicobailon/pi-web-access` (it exports only a Pi extension, it ships TypeScript source that Node.js refuses under `node_modules`, and its configuration is global), and the research in `docs/web-search-research.md` selects two tools built in the harness with its SearXNG client, its redirect rules, and its HTML extraction as the reference.

## What Changes

- `web_search` (`src/tools/research/web-search.ts`, factory `createWebSearchTool`): a SearXNG `GET /search?format=json` call through `apiFetchValidated` with a zod schema over the response. Input: `query` or `queries`, `numResults` (1 to 20, default 5), `recencyFilter` (`day`, `week`, `month`, `year`), `domainFilter` (a `-` prefix excludes). Output: the SearXNG `answers` and results with `title`, `url`, `snippet`. The domain filter adds `site:` / `-site:` terms and filters the results by host again, because some engines ignore `site:`. An empty result list and a refused search are normal results.
- `web_fetch` (`src/tools/research/web-fetch.ts`, factory `createWebFetchTool`): reads one `http:` or `https:` URL. It finds each loopback, private, link-local, shared, multicast, and reserved address, IPv4 and IPv6, on the address the connection uses (a `lookup` option of `node:http`/`node:https`, so a second DNS answer cannot rebind), and it asks the user with `ctx.ask` before it fetches such an address. It obeys at most 5 redirects in the tool code, with the address check and the approval repeated for each redirect target. A refused URL, a denied approval, and an HTTP error are normal results.
- Body limits: HTML and text 5 MB, PDF 20 MB and the first 100 pages. A body of at most the limit succeeds, and the byte that passes the limit stops the read and refuses the body. HTML becomes Markdown through Readability and Turndown over a `linkedom` DOM; a PDF is read with `pdf-parse`. The tool returns 30,000 characters and keeps the remainder for `read_tool_output` through the tool output store, within the 1 MB bound of the store.
- Attach conditions: `ConversationAgentDeps.searxngBaseUrl` (optional) enables `web_search`; `web_fetch` attaches always and needs no URL. The two tools go to the conversation agent only.
- `@mozilla/readability`, `turndown`, and `linkedom` join the harness dependencies. `pdf-parse` is already present.

## Capabilities

### New Capabilities

- `web-research-tools`: the two tools, their input and output contracts, the attach conditions, the guarded-address approval, the redirect and size limits, and the extraction rules.

### Modified Capabilities

## Impact

Harness source:

- `src/tools/research/web-search.ts`, `src/tools/research/web-fetch.ts` (new), plus the guarded-address helper.
- `src/agents/conversation-agent.ts`: `ConversationAgentDeps.searxngBaseUrl` and the roster lines.
- `harness/package.json`: the three new dependencies.

Consumers: the CLI runs SearXNG in its compose stack and gives the URL at its composition root, in its own change. A host that gives no URL sees only `web_fetch`.
