## ADDED Requirements

### Requirement: The root barrel carries one factory for a chat provider

The root barrel MUST carry `createConfiguredAiSdkProvider` as the only factory for a chat provider. The barrel MUST NOT
carry `createAnthropicProvider` or `AnthropicProviderDeps`. The `anthropic` arm of `AiSdkProviderConfig` makes the same
provider. Thus no embedder needs the wrapper to write its composition root, and the rule of this capability does not
admit it.

The harness MUST NOT keep the module `providers/anthropic.ts`. Thus the deep subpath of that module goes away too. The
removal is a breaking change of the public surface, and the release notes MUST name the two removed names.

#### Scenario: An embedder builds an Anthropic provider from the root

- **WHEN** an embedder calls `createConfiguredAiSdkProvider` from `@inflexa-ai/harness` with `{ kind: "anthropic", baseURL, apiKey, model }`
- **THEN** it receives a `ChatProvider` for that endpoint and that model, with no other factory

#### Scenario: The removed names do not resolve

- **WHEN** an embedder imports `createAnthropicProvider` or `AnthropicProviderDeps` from `@inflexa-ai/harness`
- **THEN** the import fails to compile
