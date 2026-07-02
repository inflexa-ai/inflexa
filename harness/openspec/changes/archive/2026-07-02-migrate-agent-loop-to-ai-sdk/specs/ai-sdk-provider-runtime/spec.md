## ADDED Requirements

### Requirement: Embedders provide AI SDK-compatible language models dynamically

The harness SHALL accept AI SDK-compatible language model instances or endpoint/key/model configuration from the embedder at runtime assembly. The harness SHALL NOT hard-code a single provider family as the only model path.

#### Scenario: CLI supplies a remote endpoint

- **WHEN** the CLI constructs the harness runtime with an allowed remote endpoint, key, and model id
- **THEN** the harness uses the supplied AI SDK-compatible language model for agent execution

#### Scenario: Embedder supplies a self-hosted endpoint

- **WHEN** an embedder supplies an allowed self-hosted endpoint through the provider configuration
- **THEN** the harness can run agents through that endpoint if its model capabilities satisfy the agent requirements

### Requirement: Tool-required agents enforce tool-call capable providers

An agent that requires tools SHALL run only with a provider/model configuration whose capabilities indicate mature tool-call support. The harness SHALL fail before execution when a selected provider cannot perform required tool calls.

#### Scenario: Tool-incompatible model is rejected

- **WHEN** an agent with tools is started with a model configuration that does not support tool calling
- **THEN** the harness rejects the run before the first model call

### Requirement: Provider metadata is preserved through the AI SDK boundary

The provider runtime SHALL preserve provider-specific metadata that is required for continuation correctness, including signed Anthropic thinking/cache metadata when AI SDK exposes it. Provider metadata SHALL remain provider-scoped; the harness SHALL NOT reinterpret it as generic Cortex message fields.

#### Scenario: Signed Anthropic metadata is stored provider-scoped

- **WHEN** an Anthropic-backed AI SDK response includes signed reasoning/cache metadata required for continuation
- **THEN** the stored AI SDK model message envelope retains that metadata in provider-scoped fields

### Requirement: Provider failures remain classified values

AI SDK provider calls SHALL map provider failures into the harness `ProviderError` union in the same semantic categories used by existing callers: budget, tenant-blocked, provider, and client abort. Client abort SHALL continue to propagate as abort control flow rather than as a classified provider error.

#### Scenario: Budget failure stays non-retryable

- **WHEN** the configured AI SDK provider reports an upstream budget or payment failure
- **THEN** the harness maps it to a non-retryable `ProviderError` with `type: "budget"`

#### Scenario: Client abort escapes classification

- **WHEN** an `AbortSignal` aborts an AI SDK model call
- **THEN** the abort propagates rather than being returned as a `ProviderError`
