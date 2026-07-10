## ADDED Requirements

### Requirement: The provider configuration path is a front-door export

The package's curated barrel SHALL export the provider configuration surface: the configuration
union (`AiSdkProviderConfig`, discriminated over the `anthropic` and `openai-compatible` kinds,
carrying endpoint/key/model) and the factory that realizes it into a `ChatProvider`
(`createConfiguredAiSdkProvider`). An embedder SHALL be able to construct a provider of either
kind without importing package-internal subpaths. The existing `createAnthropicProvider`
convenience wrapper SHALL remain exported and behaviorally unchanged.

The exported surface SHALL document the construction contract: the wire model is bound at
construction (`ChatRequest` carries no model field), so an embedder that runs distinct models on
distinct seats builds one provider instance per model, over one shared connection configuration.

#### Scenario: An embedder constructs an openai-compatible provider via the front door

- **WHEN** an embedder imports the configuration union and factory from the package root and
  calls the factory with `{ kind: "openai-compatible", name, baseURL, apiKey, model }`
- **THEN** it receives a `ChatProvider` for that endpoint and model, with no deep-subpath import
  required

#### Scenario: An embedder constructs an anthropic provider via the front door

- **WHEN** an embedder calls the factory with `{ kind: "anthropic", baseURL, apiKey, model }`
- **THEN** it receives a `ChatProvider` equivalent to one built through `createAnthropicProvider`
  with the same endpoint, key, and model

#### Scenario: Existing embedder imports keep working

- **WHEN** an embedder built against the prior barrel imports `createAnthropicProvider` from the
  package root
- **THEN** the import resolves and behaves exactly as before

#### Scenario: Two seat models over one connection are two provider instances

- **WHEN** an embedder needs a conversation seat on model A and a sandbox seat on model B against
  the same endpoint and key
- **THEN** it constructs two providers from the same connection configuration differing only in
  `model`, and each seat's requests carry its own bound model
