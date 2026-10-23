# Inject the web-search engine as a capability

## Why

A design review of PR #702 questioned `ConversationAgentDeps.searxngBaseUrl`: a raw URL is a transport detail in a deps bag of capabilities, and it names one engine in a host-agnostic interface. The harness already answers this shape elsewhere — an embedder injects a capability (`citationResolver`, `knowledge`) rather than a wire address. The approved redesign moves the search behind the `WebSearchEngine` capability: the tool queries an engine, the harness ships the SearXNG realization, and the embedder picks what to inject.

## What Changes

- A `WebSearchEngine` interface beside the citation resolver: one `search` call, query in, `Result` out — the error side carries the same four data statuses (`http_error`, `retryable_status`, `schema_mismatch`, `not_json`) the tool reports today.
- `createSearxngEngine({ baseUrl })` — the SearXNG realization. The HTTP call, the base-URL rules, the response schema, the row mapping, and the `ApiError`-to-status texts move out of `createWebSearchTool` into it.
- `createWebSearchTool({ engine })` — the tool keeps the input contract, the domain-filter semantics (`site:` terms and the host re-filter), the queries merge, the bound, and the output union. No store dep: `web_search` output is bounded by `numResults` today and stays so.
- `ConversationAgentDeps` replaces `searxngBaseUrl?: string` with `webSearch?: WebSearchEngine`. With no engine injected, `web_search` does not attach and its description never enters a model context; with one injected, it attaches to the conversation agent only. `web_fetch` attaches regardless, unchanged.
- The barrel exports `createSearxngEngine` and the `WebSearchEngine` type: an embedder cannot write its composition root without them, so the front-door rule of `harness-embedder-exports` now admits the two names (the earlier no-export decision held only while a URL string was all an embedder passed).
- The CLI builds the engine from its derived `env.searxngBaseUrl` and injects it; the variable, the port, and the compose service are unchanged.

## Capabilities

### New Capabilities

### Modified Capabilities

- `web-research-tools`: the `web_search` requirements name the injected engine instead of a base URL — the attachment condition, the search call, and the `web_fetch` attachment wording. One requirement is renamed to say what it now means.

## Impact

Harness source:

- `src/tools/research/web-search.ts`: the engine type, the tool over `{ engine }`.
- `src/tools/research/searxng-engine.ts` (new): the realization, the schema, the base-URL rules, the error texts.
- `src/agents/conversation-agent.ts`: the deps field and the roster line.
- `src/index.ts`: the two barrel names.
- Tests: tool-level tests stub the engine; the SearXNG request, parse, and error tests move to the realization; the golden-fixture suite imports the schema from the realization.

CLI: `src/modules/harness/runtime.ts` builds and injects the engine; its spec delta for the hand-off wording lands in the cli tree in its own small change. Consumers that passed no URL see no change.
