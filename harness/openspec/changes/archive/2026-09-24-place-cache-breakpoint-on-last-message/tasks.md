## 0. Vendors

- [x] 0.1 Add `@ai-sdk/amazon-bedrock` as a dev dependency of the harness
- [x] 0.2 Emit `bedrock.cachePoint` beside `anthropic.cacheControl`, each with the ttl of the policy
- [x] 0.3 Bind the emitted shapes with `satisfies`, thus a renamed key breaks the build

## 1. Placement

- [x] 1.1 Add `withPromptCacheBreakpoint(messages, policy)` to `src/providers/prompt-cache.ts`
- [x] 1.2 Put the directive on the last message that can carry it, and remove it from each other message
- [x] 1.3 Move back past a message that ends with a thinking block, and past an empty content array
- [x] 1.4 Return a copy, thus the transcript of the caller stays unmarked

## 2. Loop

- [x] 2.1 Resolve the policy once per run in `src/loop/run-agent.ts`
- [x] 2.2 Place the breakpoint on each iteration and on the wrap-up call
- [x] 2.3 Stop setting `ChatRequest.providerOptions` for the cache
- [x] 2.4 Export the placement function from `src/index.ts`

## 3. Tests

- [x] 3.1 Unit tests for the placement, the strip, the copy, the walk-back, and the off policy
- [x] 3.2 Loop tests for the per-call placement, the roll-forward, and the unmarked result
- [x] 3.3 A regression test that no call carries a request-level directive
- [x] 3.4 Point the Anthropic caching integration test at the new placement
- [x] 3.5 Render the bedrock marker through the real provider, and assert the `cachePoint` block and its ttl
- [x] 3.6 Assert that the strip covers a stale marker of any vendor namespace

## 4. Verify

- [x] 4.1 `npx tsc -p tsconfig.json --noEmit` clean
- [x] 4.2 `bun test` green (4225 pass, 0 fail)
- [x] 4.3 A live rig with CLIProxyAPI v7.2.148 refuses the old placement and accepts the new one
- [x] 4.4 Real chats through the CLI proxy pass, and they report cache reads
