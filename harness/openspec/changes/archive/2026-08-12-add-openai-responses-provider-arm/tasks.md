# Tasks: add-openai-responses-provider-arm

## 1. The dependency

- [x] 1.1 Add `@ai-sdk/openai@^4.0.38` to `harness/package.json` and install it.

## 2. The arm

- [x] 2.1 Add the `openai` member to `AiSdkProviderConfig` in `src/providers/ai-sdk.ts`. The fields mirror the `anthropic` arm, and the JSDoc of the union names the three kinds.
- [x] 2.2 Add the factory branch in `createConfiguredAiSdkProvider`: `createOpenAI` with the effective fetch, an explicit `provider.responses(config.model)` binding, and the shared bounds spread.
- [x] 2.3 Set the capability default of the branch: `imageToolResults: true` only when `baseURL` is absent, with the config spread over it.

## 3. Tests at the provider boundary

- [x] 3.1 A front-door test: the factory with `{ kind: "openai", apiKey, model }` gives a `ChatProvider`, imported from the package barrel only.
- [x] 3.2 Capability-default tests: absent `baseURL` gives `true`, present `baseURL` gives absence, and a config value overrides in both directions.
- [x] 3.3 A usage test over a stubbed Responses wire: `cached_tokens` arrives on `cacheReadInputTokens`, and `reasoning_tokens` arrives on `reasoningTokens`.
- [x] 3.4 A stream test over a stubbed Responses stream: text deltas, then one `done` event whose response carries the usage.
- [x] 3.5 A mismatch test: a chat-completions body behind the arm surfaces a classified provider error.

## 4. The store directive

- [x] 4.1 Add the optional `store` field to the `openai` arm. Merge an explicit `providerOptions.openai.store` into every call, through a `transformParams` middleware, with `false` as the default.
- [x] 4.1b Write the `NOTICE` comment on the `store` field: the retention meaning, the reference hazard of an unset value, the stateless reasoning path, and the one-mode-per-thread rule.
- [x] 4.2 Tests: the default call carries `store: false`, a config `store: true` carries through, and the merge keeps the other request options intact.
- [x] 4.3 A test that pins the encrypted-reasoning round-trip: a stored reasoning part with its encrypted content replays onto the next request.

## 5. Closure

- [x] 5.1 Run `bun run format:file` on the changed source files, then `tsc -p tsconfig.json`.
- [x] 5.2 Run the targeted test files of the arm only, per the test-resource discipline.
