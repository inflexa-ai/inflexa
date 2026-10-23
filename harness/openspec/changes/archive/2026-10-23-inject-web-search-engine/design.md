# Design

## Context

PR #702 review: `searxngBaseUrl?: string` puts a transport address into `ConversationAgentDeps`, a bag of capabilities (`citationResolver`, `knowledge`, `hostTools`). The approved redesign follows the house capability shape instead. Behavior is unchanged end to end: same input contract, same output union, same attach conditions, same roster.

## Goals / Non-Goals

**Goals:**

- `web_search` depends on an injected engine; the harness stays engine-agnostic at the deps level.
- The SearXNG wire contract (URL rules, schema, mapping, error texts) stays in one tested realization.
- A lean diff: no behavior change, moved code, updated tests.

**Non-Goals:**

- A second engine realization, engine selection config, or per-call engine choice.
- Any change to `web_fetch`, to the CLI stack, or to the tool's input/output contract.

## Decisions

### The engine is one method, and the error side is the tool's own union

`WebSearchEngine.search(request)` takes the final query terms and the optional recency filter, and returns `Result<WebSearchPage, WebSearchEngineError>` where the error side is exactly the non-ok half of `WebSearchOutput` — the four data statuses the tool already reports. The tool keeps the spec-level semantics (domain-filter terms and the host re-filter, the queries merge, the bound, the ok-channel rule); the engine owns transport, schema, and the error texts. Nothing new is invented on either side of the boundary.

### The domain-filter terms are composed by the tool, not the engine

`site:` / `-site:` terms are the tool's observable contract (the spec pins them), so the tool composes the query string and the engine executes it verbatim. The host re-filter also stays in the tool. An engine implementation cannot weaken the filter by reinterpreting it.

### `createSearxngEngine` and `WebSearchEngine` go on the barrel

The front-door rule of `harness-embedder-exports` admits a name an embedder cannot avoid: the CLI must construct an engine and type the `webSearch` field, so both names are necessary at the package root. This reverses the earlier no-export decision, which held only because a URL string was all an embedder passed. `createWebSearchTool` and `createWebFetchTool` stay off the barrel — the conversation agent still constructs them itself.

### One deps field replaces the other in place

`ConversationAgentDeps.searxngBaseUrl` is removed, not deprecated: `ConversationAgentDeps` is a composition-root interface the embedder fills in one place, and the CLI is the only in-repo embedder; a release of this change carries the harness and the CLI pin together (the cli typecheck fails against a stale pin, by design of the release order). The roster line keeps the spread-conditional of `toolOutputStore`.

## Risks / Trade-offs

- [A hand-rolled engine could ignore the recency pass-through or the verbatim query] → The interface doc pins both; the shipped realization tests cover them, and an embedder that swaps the engine owns its own conformance.
- [The rename of the deps field breaks out-of-tree embedders at compile time] → Deliberate and loud: a silent URL fallback would keep the raw-address shape the review rejected.
