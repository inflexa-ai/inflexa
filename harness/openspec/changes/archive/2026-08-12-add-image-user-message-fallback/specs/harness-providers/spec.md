# harness-providers Delta

## ADDED Requirements

### Requirement: The provider capability set names the picture placement

The `ProviderCapabilities` set MUST carry two optional picture flags: `imageToolResults` and `imageUserMessages`. `imageToolResults` says that the wire renders an image block inside a tool result. `imageUserMessages` says that the wire renders an image inside a user message. An absent flag means "cannot carry", never "unknown". The provider factory MUST copy a stated flag onto the built provider, and it MUST NOT invent a value for an absent one.

#### Scenario: The embedder states the fallback flag

- **WHEN** a provider is constructed with `capabilities: { imageUserMessages: true }`
- **THEN** the built provider advertises `imageUserMessages: true`

#### Scenario: An absent flag stays absent

- **WHEN** a provider is constructed with no picture flag in its capability config
- **THEN** the built provider advertises neither picture flag
