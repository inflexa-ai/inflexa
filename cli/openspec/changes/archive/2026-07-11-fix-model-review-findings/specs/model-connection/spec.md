# model-connection — delta

## MODIFIED Requirements

### Requirement: The chat backend is a user-owned model connection

The user config SHALL carry a top-level `models` block whose `connection` field selects the chat
backend as a mode-discriminated union: `{ mode: "cliproxy", provider? }` (the managed local proxy)
or `{ mode: "direct", provider, baseURL, protocol? }` (any user-supplied endpoint). `provider` is
the vendor slug naming the model's provider — an OPEN string vocabulary (e.g. `anthropic`,
`openai`, `google`), a configured FACT in both modes, never derived from a model id. `protocol`
selects the harness provider kind (`"anthropic" | "openai-compatible"`); when absent it defaults
to `anthropic` for `provider: "anthropic"` and `openai-compatible` otherwise. An absent `models`
block SHALL resolve to `{ mode: "cliproxy", provider: "anthropic" }` — behavior identical to the
pre-change CLI. An invalid block SHALL fail closed to the default with a reported config error
(the existing config-schema pattern), never a silent partial parse.

`baseURL` SHALL be a single value every consumer derives from — one configured URL serves both
the chat wire path and any auxiliary request (model listing). Its convention is the protocol's:
for the `anthropic` protocol it is the `/v1`-terminated API root the wire layer appends
`/messages` to (e.g. `https://api.anthropic.com/v1` — the `@ai-sdk/anthropic` convention); for
`openai-compatible` it is the `/v1`-terminated root the wire layer appends `/chat/completions`
to. No consumer SHALL assume a different form of the same `baseURL` (e.g. re-appending `/v1`),
and setup's endpoint prompt SHALL state the expected form.

#### Scenario: Absent block reproduces today's behavior

- **WHEN** `config.json` has no `models` block
- **THEN** the connection resolves to cliproxy mode with provider `anthropic`, and boot, chat, and
  provenance behave exactly as before the change

#### Scenario: A direct connection reaches a non-proxy endpoint

- **WHEN** `models.connection` is `{ mode: "direct", provider: "openai", baseURL: "https://api.openai.com/v1" }`
- **THEN** chat traffic targets that endpoint over the OpenAI-compatible protocol and CLIProxyAPI
  is neither required nor contacted by the chat path

#### Scenario: Protocol override for a gateway

- **WHEN** the connection is `{ mode: "direct", provider: "anthropic", baseURL: <gateway>, protocol: "openai-compatible" }`
- **THEN** the provider identity records `anthropic` while the wire protocol is OpenAI-compatible

#### Scenario: One anthropic baseURL serves chat and listing

- **WHEN** the connection is `{ mode: "direct", provider: "anthropic", baseURL: "https://api.anthropic.com/v1" }`
- **THEN** chat requests target `{baseURL}/messages` and the model listing targets
  `{baseURL}/models` — the same configured value satisfies both, with no second convention
