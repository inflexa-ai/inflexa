# model-connection Specification

## Purpose
The user-owned chat-backend connection: the `models.connection` config block (managed local
proxy or any direct Anthropic/OpenAI-compatible endpoint), the environment-only secret channel
(`INFLEXA_MODEL_API_KEY`), boot resolution of the connection into the harness provider, the
setup-flow connection choice, and the rule that the provider identity is a configured fact —
never derived from a model id. Created by archiving change configure-model-connection.
## Requirements
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

### Requirement: The direct-mode secret comes from the environment only

The CLI SHALL read the direct-connection API key from the `INFLEXA_MODEL_API_KEY` environment
variable, through the central env module (`lib/env.ts`, the sole `process.env` reader). The key
SHALL never be written to `config.json`, never appear in telemetry or logs, and never be recorded
in provenance. In `direct` mode a missing key SHALL fail boot with an actionable error naming the
variable. In `cliproxy` mode the existing proxy client key discovery is unchanged and
`INFLEXA_MODEL_API_KEY` is ignored. No endpoint-URL environment variable SHALL be introduced —
the endpoint is configuration authored at setup.

#### Scenario: Missing key blocks a direct boot actionably

- **WHEN** the connection is `direct` and `INFLEXA_MODEL_API_KEY` is unset
- **THEN** boot fails before any provisioning with an error naming `INFLEXA_MODEL_API_KEY` and
  the config path, and no chat request is attempted

#### Scenario: The key stays out of persisted surfaces

- **WHEN** a direct-mode session runs to completion
- **THEN** `config.json`, the telemetry stream, and the signed provenance document contain no
  API key material

### Requirement: Boot resolves the connection to a chat provider via the harness front door

Boot SHALL resolve `models.connection` into the harness's provider configuration and construct
the chat provider through the harness's exported factory (one construction path for both modes):
`cliproxy` resolves to the Anthropic kind at the proxy endpoint with the proxy client key;
`direct` resolves to the configured protocol kind at the configured `baseURL` with the env key.
Model resolution per mode: in `cliproxy` mode the existing behavior holds (config override, else
the proxy `/models` default ranking), guarded by provider-family agreement — an auto-resolved id
whose family does not match the configured provider SHALL fail boot with a remediation message
(this generalizes and replaces the `model_not_claude` guard; with the default provider it is
behavior-identical to it). In `direct` mode an explicit model id is REQUIRED and no auto-resolve
occurs; a missing model SHALL fail boot actionably. The composition SHALL carry the connection's
`provider` slug (the configured fact) wherever the model's vendor identity is consumed.

#### Scenario: Cliproxy default boot is unchanged

- **WHEN** boot runs with the default connection and an authenticated Claude account
- **THEN** the provider targets the proxy endpoint over the Anthropic protocol with the
  auto-resolved Claude model — indistinguishable from the pre-change boot

#### Scenario: Provider-family mismatch replaces model_not_claude

- **WHEN** the connection is cliproxy with provider `anthropic` and the proxy's `/models`
  auto-resolve yields a non-Claude id
- **THEN** boot fails with a mismatch error naming the configured provider, the resolved id, and
  the remedies (authenticate the matching account via setup, or set the model/provider in config)

#### Scenario: Direct mode requires an explicit model

- **WHEN** the connection is `direct` and no model id is configured
- **THEN** boot fails with an actionable error pointing at the model config — no auto-resolve is
  attempted against the direct endpoint

### Requirement: Setup offers the connection choice and records the provider fact

`inflexa setup` SHALL let the user choose the connection mode. The CLIProxy path keeps the
current provisioning flow (container, config generation, provider OAuth login) and SHALL record
the connection provider slug in config from the authenticated account kind at login time (the
account-kind→slug mapping lives only in setup, where the kind is a known fact); re-authentication
SHALL rewrite it. The direct path SHALL collect the endpoint (and provider, and optional
protocol), write the `models.connection` block, instruct the user to export
`INFLEXA_MODEL_API_KEY`, and SHALL NOT provision the proxy container. Postgres provisioning is
mode-independent and unchanged.

#### Scenario: CLIProxy setup records the provider from the login

- **WHEN** the user runs setup and authenticates the `claude` account kind
- **THEN** config records connection mode cliproxy with provider `anthropic`, written by setup —
  not derived from any model id

#### Scenario: Direct setup skips the proxy entirely

- **WHEN** the user chooses the direct path with an endpoint and provider
- **THEN** the `models.connection` block is written, no proxy container is provisioned or
  required for chat, and setup still provisions Postgres

### Requirement: No provider identity is ever derived from a model id

The CLI SHALL contain no mapping from model-id substrings or families to provider slugs. The
`modelProvider()` derivation and its `unknown/` fallback SHALL be removed; every consumer of the
model's vendor identity (provenance, telemetry) SHALL read the connection's configured `provider`.
The family-preference ranking used to pick a cliproxy default model MAY remain as a ranking
heuristic only — its output is a model id, never a provider identity.

#### Scenario: Provenance records the configured provider

- **WHEN** a run executes over a direct connection `{ provider: "deepseek", baseURL: … }` with
  model `some-alias-v2`
- **THEN** the provenance model identity is `deepseek/some-alias-v2` — taken from config, with no
  family sniffing and no `unknown/` fallback in the codebase
