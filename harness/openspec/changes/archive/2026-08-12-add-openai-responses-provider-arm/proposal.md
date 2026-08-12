# Proposal: add-openai-responses-provider-arm

## Why

A genuine OpenAI key rides the `openai-compatible` arm today, and that chat-completions wire carries a tool result as text only. Thus the loop drops the `examine_page` screenshot with a warn, and the model never sees it (issue #348). The official `@ai-sdk/openai` package maps a tool-result image onto the Responses wire as `input_image`, the same class of support as the Anthropic arm.

## What Changes

- Add a third arm to `AiSdkProviderConfig`: `kind: "openai"`, realized over `@ai-sdk/openai` with an explicit `provider.responses(model)` binding. The config selects the arm. No URL sniff.
- Add the dependency `@ai-sdk/openai` to the harness, at a version that matches the installed provider spec (V4, `ai@7.0.28`).
- Set the capability default of the arm: `imageToolResults: true` only when `baseURL` is absent, with a config override in both directions — the same rule as the Anthropic arm.
- Send an explicit `store` value on every request of the arm, with `false` as the default and a config override. An unset value lets the server keep the response for 30 days, and it makes the package emit stateful `item_reference` entries.
- Add tests that prove the usage and stream path of the arm. The `ai` package normalizes the Responses usage into the neutral fields that `toChatUsage` reads. Thus the arm adds no mapping code, and the tests pin that fact.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `ai-sdk-provider-runtime`: the front-door configuration union gains the `openai` kind. A new requirement fixes the Responses binding, the capability default, and the `store` default of the arm.

## Impact

- `harness/src/providers/ai-sdk.ts`: the config union and the factory gain the third arm.
- `harness/package.json`: the new dependency `@ai-sdk/openai`.
- Tests beside the provider: construction, capability default, usage normalization, stream path.
- No CLI change in this change. The CLI selects the arm in a companion change.
- No change to the loop: the image encoding and the capability gate exist (`loop/run-agent.ts`).
