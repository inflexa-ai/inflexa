# Tasks

## 1. The engine type and the realization

- [x] 1.1 Split `src/tools/research/web-search.ts`: define `WebSearchEngine` (one `search` call: final query terms plus optional recency in, `Result` out with the four error statuses of today's union) and `createWebSearchTool({ engine })` keeping the input contract, the domain-filter terms and host re-filter, the queries merge, and the output union. Move the schema, the base-URL rules, the row mapping, and the `ApiError`-to-status texts to a new `src/tools/research/searxng-engine.ts` with `createSearxngEngine({ baseUrl })`. Verify the tool-level tests stub the engine and the realization tests (fetch stub) carry the request, parse, and error-text cases; the golden-fixture suite imports the schema from the realization; `bun test src/tools/research src/tools/lib/__fixtures__/searxng` passes

## 2. The roster and the barrel

- [x] 2.1 Replace `ConversationAgentDeps.searxngBaseUrl` with `webSearch?: WebSearchEngine`, attach `web_search` iff an engine is injected, and update the roster tests (no engine: no `web_search`, still `web_fetch`; engine: both). Verify `bun test src/agents/conversation-agent.test.ts` passes
- [x] 2.2 Export `createSearxngEngine` and the `WebSearchEngine` type from `src/index.ts` (the front-door rule: an embedder cannot build its composition root without them). Verify `tsc -p tsconfig.build.json` and the barrel export test, if one pins the surface, pass

## 3. The CLI hand-off

- [x] 3.1 Build the engine from `env.searxngBaseUrl` at the composition root of `cli/src/modules/harness/runtime.ts` and inject it as `webSearch`; update the wiring test to assert the injected engine. Amend `cli/openspec/specs/searxng-provisioning/spec.md` through a small cli change with one MODIFIED requirement (the hand-off wording) and archive it. Verify `bun test src/modules/harness/runtime.test.ts`, `bun run typecheck`, and `bun run format:file` on changed cli files

## 4. Verification

- [x] 4.1 Run the full harness suite and `tsc -p tsconfig.build.json` one time, then `bun run lint`, and record the results
