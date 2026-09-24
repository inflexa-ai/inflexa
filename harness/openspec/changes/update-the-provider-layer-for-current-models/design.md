## Context

The provider layer turns a `ChatRequest` into an AI SDK call. A host builds one provider for each role: the conversation, the sandbox agents, and the utility calls. The CLI selects a model for each role in `models.agents`. Cortex does the same in its cloud configuration.

This change is the first of three. The second change makes each agent conversation append-only. The third change adds compaction to the chat thread. This change prepares the provider layer, and it adds the metrics that measure the next two changes.

## Goals / Non-Goals

**Goals:**

- Run Claude Opus 5.5 and Claude Fable 5.1 correctly.
- Let a host set the effort of each role.
- Keep the calls of one conversation on one account of the gateway.
- Split the harness metrics by model and by provider.
- Continue without a thinking block when its prefix changed, and report each drop.

**Non-Goals:**

- The cache lifetime of each role. A later change sets it.
- The history budget. The third change adds it.
- The removal of the prefix changes in the loop. The second change removes them.

## Decisions

### The effort sits on the provider configuration

Each role already has its own provider and its own model. Thus the effort sits next to the model, and a host sets both from the same settings.

The provider selects the effort in this order:

1. `ChatRequest.reasoning`, if the request sets it.
2. The `reasoning` of the provider configuration.
3. `DEFAULT_REASONING`.

`runAgent` no longer applies `DEFAULT_REASONING`. If it did, the default of the loop would hide the configuration. A direct `provider.chat` call without a value now runs at the configured effort, not at the default of the model.

The effort stays the same for each call of one conversation. Anthropic discards its message cache when the top-level effort changes.

This design rejects a map from agent identifier to effort in the runtime dependencies. The agent identifiers are internal names of the harness, and a host must not know them.

### The session key comes from the session

Each provider call gets a `Session`. Its scope holds `analysisId` and an optional `threadId`. Its run frame holds `runId` and an optional `stepId`.

The provider makes an identifier string from the first rule that applies:

1. A run frame with a step gives `<analysisId>:<runId>:<stepId>`.
2. A run frame without a step gives `<analysisId>:<runId>`.
3. A scope with a thread gives `<analysisId>:<threadId>`.
4. Else, the string is `<analysisId>`.

The run frame comes first, because a run that a chat starts can carry the thread of that chat in its scope. The steps of that run must not share the key of the chat.

The string holds only identifiers. It must not hold a name or an address.

The key that goes to the vendor is the base64url SHA-256 digest of that string, with 43 characters. The string of a step holds three identifiers, and it has more than 64 characters. OpenAI and Azure refuse a `prompt_cache_key` longer than 64 characters with HTTP 400, and no retry passes that error. Anthropic recommends a hash or another opaque value for `metadata.user_id`. One string always gives one digest, thus the gateway still keeps the calls of one session on one account.

The Anthropic arm sends the key through `providerOptions.anthropic.metadata.userId`. The OpenAI Responses arm sends it through `providerOptions.openai.promptCacheKey`. The OpenAI-compatible arm has no standard field, thus it sends no key.

The step key spreads the parallel steps of one run across the accounts of the gateway. Each step keeps its later calls on its account, for example the step summary.

This design rejects a request header, such as `X-Session-ID`, in the harness. The header is a convention of one gateway. A host can add it through `resolveRequestHeaders`, which gets the session.

### The Anthropic arm sends a thinking-binding mode

The configuration takes `thinkingBinding`, with the values `drop_block`, `error`, and `off`. The default is `drop_block`.

- `drop_block`: the API drops the thinking block that does not match, and each later thinking block of that request. The request continues. The response reports each drop in `input_transformations`.
- `error`: the API refuses the request with HTTP 400. A test against the real API uses this mode, thus a prefix change fails the test.
- `off`: the provider sends no binding. A gateway that refuses the beta header needs this mode.

Any `providerOptions.anthropic.thinking` stops the thinking selection of the package. A binding without a `type` turns thinking off on a model that can run without thinking. Thus the provider sends the binding only to a model that always thinks. The capability table of the package reports such a model with `rejectsThinkingDisabled`.

Claude Opus 5.5 and Claude Fable 5.1 are such models, and they are the models that bind a block to its prefix. For them, the provider sends the `type` and the `display` that the package selects, plus the binding. Thus the binding does not change whether a request thinks, or what it shows.

The provider logs each reported drop as a warning, with the path and the reason. The reason `prefix_binding_mismatch` shows a prefix change in the harness. The reason `model_binding_mismatch` shows a change of the model, for example a model switch of the CLI.

### The system prompt carries a cache breakpoint

The system prompt of an agent depends only on its type. Thus each call of that agent sends the same tools and the same system prompt. A breakpoint at the end of the system prompt caches them as one entry. A new thread, and the first request after a compaction, read that entry.

The breakpoint uses the same vendor namespaces and the same lifetime as the breakpoint on the last message. The CLIProxyAPI path adds up to four markers, and it trims the total to four by count. A marker on a block stays countable, thus the proxy trims it correctly.

### The loop records each call

The metric labels are `agent_id`, `model`, and `provider`. `model` is the served model of the response. The counters grow in the path that accounts for each call, not at the end of a run. Thus a run that throws keeps the count of its completed calls. A new counter holds the reasoning tokens.

The ad hoc router and the analogy conversion call `provider.chat` directly. They use the same accounting path as the loop.

### The packages move together

`@ai-sdk/anthropic` 4.0.60 adds the capability rows of `claude-opus-5-5` and `claude-fable-5-1`: adaptive thinking at all times, and no forced tool choice. The API default effort of Claude Opus 5.5 is `medium`. The forced tool choice left the harness in commit `4c29d52f`.

The eight packages move in one step, because each one pins `@ai-sdk/provider` and `@ai-sdk/provider-utils` exactly.

### Removals

- `ChatRequest.providerOptions`: `runAgent` stopped its use in the change `place-cache-breakpoint-on-last-message`. Only tests set it.
- `createAnthropicProvider`: the configuration path of the root barrel covers the Anthropic arm. No production code calls it, and Cortex does not use it. The one CLI test that uses it moves to `createConfiguredAiSdkProvider`.

## Risks / Trade-offs

- [A gateway drops or refuses the beta header] → The mode `off`. The user does a test of Bifrost and cliproxy on staging.
- [A host takes this version without an effort for its utility role] → The ad hoc router runs at `xhigh` under a deadline of 10 seconds. Thus it can fall back more often. The CLI and Cortex set the effort when they bump the pin.
- [The two new labels increase the metric series] → Each host serves a small set of models. Thus the increase is small.
- [An embedder imports a removed name] → No production import exists in this repository or in Cortex. The release notes name the removed exports.

## Migration Plan

No data migration is necessary. The new configuration fields are optional. A host sets the effort of each role when it takes the version.

## Open Questions

None.
