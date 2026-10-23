# Bind the web-search engine at the composition root

## Why

The harness moved `web_search` behind the `WebSearchEngine` capability (`inject-web-search-engine` in the harness tree): the conversation deps take an injected engine, not a base URL. The CLI is the embedder, so it builds the realization over its stack URL and injects it. The URL, the port, and the compose service do not change.

## What Changes

- `bootHarnessRuntime` builds `createSearxngEngine({ baseUrl: env.searxngBaseUrl })` and injects it as `webSearch` in the conversation deps bag, beside the knowledge binding. `web_search` attaches through the engine.
- The hand-off requirement of `searxng-provisioning` is reworded: the boot injects a web-search engine built from the URL, not the URL itself.

## Capabilities

### New Capabilities

### Modified Capabilities

- `searxng-provisioning`: the hand-off requirement names the injected engine.

## Impact

- `src/modules/harness/runtime.ts`: the engine construction and the deps field.
- `src/modules/harness/runtime.test.ts`: the wiring assertion.
