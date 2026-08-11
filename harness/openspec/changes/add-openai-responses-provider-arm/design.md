# Design: add-openai-responses-provider-arm

## Context

`createConfiguredAiSdkProvider` (`src/providers/ai-sdk.ts:751`) realizes a two-arm config union: `anthropic` builds `createAnthropic`, and each other config builds `createOpenAICompatible`. The loop already encodes a tool picture as a `file` part inside a `content` tool result (`src/loop/run-agent.ts:683`). The `imageToolResults` capability gates that path (`src/loop/run-agent.ts:161`), and the drop path warns (`src/loop/run-agent.ts:680`).

The official `@ai-sdk/openai` package, on its Responses path, maps that `file` part to `input_image` on the wire. The compatible package stringifies it, and its relocation proposal (`vercel/ai#12621`) sits unmerged. Thus the harness gains a third arm over the official package.

## Goals / Non-Goals

**Goals:**

- A config-selected `kind: "openai"` arm that binds `provider.responses(model)`.
- The capability default of the arm, with the same rule as the Anthropic arm.
- A deliberate `store` default on the Responses wire.
- Tests that pin the usage and stream path of the arm at the package boundary.

**Non-Goals:**

- No CLI change. The CLI selects the arm in a companion change.
- No fallback that moves a picture into a user message on the compatible arm. That arm keeps its drop path until the upstream relocation lands.
- No use of the chat-completions path of the official package. A chat-completions endpoint stays on the compatible arm.
- No change to the loop, the encoding, or the capability gate.

## Decisions

### D1: The arm is a third member of the config union

`AiSdkProviderConfig` gains `{ kind: "openai"; baseURL?; apiKey; model; fetch?; capabilities?; maxOutputTokens?; requestTimeoutMs?; maxRetries? }`. The shape mirrors the `anthropic` arm: `baseURL` is optional, and an absent value means the default endpoint. The config alone selects the arm. A URL sniff on the compatible arm was rejected, because the issue rules it out and a sniff makes a private detail load-bearing.

### D2: The binding is `provider.responses(model)`, explicit

The default factory of the package resolves to the Responses path today. The arm binds `provider.responses(config.model)` all the same, because an explicit binding pins the wire in our code. The package itself raises a mismatch error when a chat-completions body answers on this path, thus a misconfigured endpoint fails loud, not silent.

### D3: The capability default mirrors the Anthropic arm

`imageToolResults: true` applies only when `baseURL` is absent, the same rule as `src/providers/ai-sdk.ts:770`. A custom `baseURL` can front a backend that stringifies the block, thus such a config must declare the capability itself. A config value overrides the default in both directions.

### D4: The arm adds no usage or stream mapping

The issue asked for an arm-owned mapping. That premise is stale. The provider emits spec-V4 usage, and the `ai` package normalizes it into `inputTokenDetails.cacheReadTokens` and `outputTokenDetails.reasoningTokens` — the exact fields that `toChatUsage` reads (`src/providers/ai-sdk.ts:351`). The stream pull of the harness reads only neutral parts: `text-delta`, `abort`, and `response-metadata` (`src/providers/ai-sdk.ts:406,497`). Thus the arm reuses `createAiSdkProvider` unchanged, and tests pin the normalization instead of new code.

### D5: The dependency is `@ai-sdk/openai@^4.0.38`

The version targets provider spec V4 (`@ai-sdk/provider@4.0.7`), inside the `^4.0.3` range of the harness. The package carries its own `@ai-sdk/provider-utils`, and the harness keeps its pinned `5.0.10` for its own imports. The two nest without conflict.

### D6: The arm sends an explicit `store` value on every request, `false` by default

When the caller gives no value, the package omits the field, and the server keeps the response for 30 days. An unset value is also not neutral inside the package. The input converter then assumes storage (`@ai-sdk/openai` `src/responses/openai-responses-language-model.ts:355`), and it compresses round-tripped items into `item_reference` entries. Such a reference fails with a 404 under Zero Data Retention, and it fails after the 30-day expiry (`vercel/ai#10060`).

Thus the arm merges `providerOptions.openai.store` into every call, through a `wrapLanguageModel` middleware with `transformParams`. The default is `false`, so an analysis payload does not persist at OpenAI. A config field `store?: boolean` overrides the default, for an operator who wants the dashboard trail. The loop stays vendor-blind, and `providers/prompt-cache.ts` stays the only cache-naming site.

An explicit `false` engages the stateless reasoning path of the package itself:

- It adds `include: ["reasoning.encrypted_content"]` for a reasoning-family model id (`openai-responses-language-model.ts:421`).
- It captures the blob on `providerMetadata` (`:700`), and it replays the blob from history on a later turn (`convert-to-openai-responses-input.ts:801`).
- It strips a reasoning part that lost its blob, and it warns (`convert-to-openai-responses-input.ts:1284`). The warning reaches the harness logger through `routeSdkWarningsTo` (`src/providers/ai-sdk.ts:60`).

Two caveats ride in the docs of the arm. A custom `baseURL` with a nonstandard model id misses the reasoning-family regex, and the auto-include then stays off. And one thread must keep one `store` mode, because history captured under `false` and replayed under storage emits references onto unstored items. A `NOTICE` comment on the `store` field carries this whole account, per the delta spec.

### D7: Prompt cache needs no work for the arm

`providerOptions` is a namespaced bag, and each provider reads only its own key. Thus the `anthropic` cache namespace is inert on this arm. The OpenAI family caches the prefix server-side without a directive, and the cache reads come back on the neutral usage fields.

## Risks / Trade-offs

- [The Responses wire rejects a request shape the loop emits] → the boundary tests drive `runAgent` against the arm with a stubbed wire. `harness:verify` drives the built package before release.
- [A stored thread drops `providerMetadata` on a reasoning part, and reasoning strips in silence] → the metadata-preservation requirement pins the round-trip, with an openai scenario. The SDK warning reaches the logger through `routeSdkWarningsTo`.
- [The default endpoint assumption behind D3 is wrong for a proxy that fronts the official wire] → the config override carries the escape: such an embedder declares `imageToolResults` itself.
- [Version drift between the package's nested `provider-utils` and the pinned harness copy] → the harness imports only its own copy, and the package resolves its own. A future bump reviews both pins together.

## Open Questions

None. The `store` research landed on 2026-08-11, and D6 records the outcome. The features that `store: true` carries — `previous_response_id`, `conversation`, the dashboard trail, hosted-tool continuity — are features the loop does not use.
