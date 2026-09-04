## Why

The loop put the cache directive on the request. The Anthropic provider then
emits a top-level `cache_control` field, and the server places the breakpoint.
That field is invisible to an intermediary, because an intermediary counts
blocks.

CLIProxyAPI is the intermediary that the CLI uses on the Claude OAuth path. It
adds up to four block markers of its own, and it trims them to the Anthropic
limit of four by that blind count. The top-level field made the total five. The
endpoint refused the request:

```
HTTP 400 A maximum of 4 blocks with cache_control may be provided. Found 5.
```

The refusal is not retryable, and the next turn makes the same shape again. Thus
the thread stops. The first turn of a thread passes, because the proxy adds only
three markers to it. Each turn after the first fails.

## What Changes

- `withPromptCacheBreakpoint(messages, policy)` places the directive on the last
  message that can carry it. A block marker is countable, thus each hop trims
  correctly.
- The function removes the directive from each other message. One request holds
  one breakpoint.
- The function returns a copy. The caller keeps the transcript, and a host writes
  that transcript to a store. A directive in the store comes back on each later
  turn.
- The placement moves back past a message that ends with a thinking block. Such a
  block cannot carry a directive, and the provider drops it without an error.
- `runAgent` places the breakpoint on each call, and no longer sets
  `ChatRequest.providerOptions`. The breakpoint rides the last message, and the
  transcript grows with each iteration.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `harness-providers`: the placement of the cache directive moves from the
  request to the last message, and the module gains the placement function.
- `harness-agent-loop`: the loop places the breakpoint per call instead of
  sending one options object per run.

## Impact

- `src/providers/prompt-cache.ts` — adds `withPromptCacheBreakpoint`.
- `src/loop/run-agent.ts` — both chat call sites place the breakpoint.
- `src/index.ts` — the barrel exports the placement function.
- `src/loop/prompt-cache.test.ts` — covers the placement and its edge cases.
- `src/providers/integration/anthropic-caching.integration.test.ts` — builds the
  request the loop now builds.
- An embedder that calls `promptCacheProviderOptions` and attaches the result to
  a `ChatRequest` keeps the defect. The doc comment names the correct site.
