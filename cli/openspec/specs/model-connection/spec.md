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

### Requirement: The direct-mode secret comes from the environment only

The CLI SHALL resolve the direct-connection API key from the environment only, through the central
env module (`lib/env.ts`, the sole `process.env` reader), via a provider-parameterized resolver.
The resolution order SHALL be: `INFLEXA_MODEL_API_KEY` first (the explicit override); when it is
unset, the provider-conventional variable derived from the connection's configured `provider` —
`ANTHROPIC_API_KEY` for provider `anthropic`, `OPENAI_API_KEY` for every other provider. The key
SHALL never be written to `config.json`, never appear in telemetry or logs, and never be recorded
in provenance — the provider-derived fallback READS an existing environment secret, it never copies
it. In `direct` mode a key that resolves to nothing from the whole chain SHALL fail boot with an
actionable error naming both `INFLEXA_MODEL_API_KEY` and the provider-conventional variable that
was tried. In `cliproxy` mode the existing proxy client key discovery is unchanged and this
resolution is not used. Boot SHALL NOT read the endpoint URL from the environment; the endpoint
remains configuration authored (or adopted) at setup — ecosystem endpoint variables are read only
for one-time setup detection (see "Setup detects and adopts ecosystem provider environment").

#### Scenario: Explicit override wins over the provider variable

- **WHEN** the connection is `direct` with provider `anthropic`, and BOTH `INFLEXA_MODEL_API_KEY`
  and `ANTHROPIC_API_KEY` are set
- **THEN** `INFLEXA_MODEL_API_KEY` is used and `ANTHROPIC_API_KEY` is ignored

#### Scenario: Provider-derived fallback resolves the key

- **WHEN** the connection is `direct` with provider `anthropic`, `INFLEXA_MODEL_API_KEY` is unset,
  and `ANTHROPIC_API_KEY` is set (and symmetrically: provider `openai` with `OPENAI_API_KEY` set)
- **THEN** the provider-conventional variable is used as the key, still read from the environment
  and never written to any persisted surface

#### Scenario: Missing key blocks a direct boot actionably

- **WHEN** the connection is `direct` and neither `INFLEXA_MODEL_API_KEY` nor the provider's
  conventional variable is set
- **THEN** boot fails before any provisioning with an error naming both variables and the config
  path, and no chat request is attempted

#### Scenario: The key stays out of persisted surfaces

- **WHEN** a direct-mode session runs to completion, resolving its key from either variable
- **THEN** `config.json`, the telemetry stream, and the signed provenance document contain no API
  key material

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

### Requirement: Setup detects and adopts ecosystem provider environment

`inflexa setup`'s direct path SHALL detect the conventional provider environment variables and
offer a pre-filled connection the user confirms, copying only the non-secret fields into
`config.models.connection`. The detection set SHALL be: `ANTHROPIC_API_KEY` / `ANTHROPIC_BASE_URL`
(⇒ provider `anthropic`, protocol `anthropic`) and `OPENAI_API_KEY` / `OPENAI_BASE_URL` (⇒ provider
`openai`, protocol `openai-compatible`). The adopted `baseURL` SHALL be normalized to the
`/v1`-terminated form the wire layer requires — appending `/v1` when the path carries no version
segment, and defaulting to the provider's public API root when no `*_BASE_URL` is set — and the
normalized value SHALL be shown as an editable pre-fill the user confirms before it is written.
Only `provider`, `baseURL`, and `protocol` SHALL be written to config; the API key SHALL NOT be
copied (it remains an environment read per "The direct-mode secret comes from the environment
only"). When both ecosystem sets are present, interactive setup SHALL prompt which to adopt and a
non-interactive setup SHALL apply a deterministic precedence (anthropic before openai). Declining
the offer SHALL fall through to the existing manual endpoint/provider/protocol prompts. The CLI
SHALL NOT adopt `ANTHROPIC_AUTH_TOKEN` (Anthropic-wire Bearer auth is out of scope pending a
harness capability) nor Bedrock/Vertex environment (no direct-mode signer).

#### Scenario: Anthropic environment adopted with a normalized baseURL

- **WHEN** the user takes the direct path with `ANTHROPIC_API_KEY` set and
  `ANTHROPIC_BASE_URL=https://api.anthropic.com`
- **THEN** setup offers provider `anthropic`, protocol `anthropic`, and baseURL
  `https://api.anthropic.com/v1` (normalized) as an editable pre-fill; on confirmation
  `config.models.connection` carries exactly those three fields and no key

#### Scenario: Key present but base URL absent defaults to the provider root

- **WHEN** `ANTHROPIC_API_KEY` is set and `ANTHROPIC_BASE_URL` is unset
- **THEN** the offered baseURL defaults to `https://api.anthropic.com/v1` (and symmetrically
  `https://api.openai.com/v1` for the OpenAI set)

#### Scenario: OpenAI-compatible environment adopted verbatim

- **WHEN** `OPENAI_API_KEY` is set and `OPENAI_BASE_URL=https://gw.corp/v1`
- **THEN** setup offers provider `openai`, protocol `openai-compatible`, baseURL
  `https://gw.corp/v1` (already `/v1`-terminated, unchanged), copied to config on confirmation

#### Scenario: Both ecosystems present prompts the user

- **WHEN** both `ANTHROPIC_API_KEY` and `OPENAI_API_KEY` are set in an interactive setup
- **THEN** setup prompts which provider to adopt before pre-filling the connection

#### Scenario: Non-interactive direct setup self-configures

- **WHEN** `setup --connection direct` runs on a non-TTY terminal with `ANTHROPIC_API_KEY` set
- **THEN** the normalized connection is written to config with no prompts; with no detectable
  provider environment it instead fails with the existing "needs an interactive terminal" guidance

#### Scenario: The adopted key is never copied to config

- **WHEN** any ecosystem environment is adopted at setup
- **THEN** `config.models.connection` contains `provider`/`baseURL`/`protocol` only, and
  `config.json` contains no API key material

#### Scenario: Declining the offer falls through to manual entry

- **WHEN** a provider environment is detected but the user declines the pre-filled offer
- **THEN** setup runs the existing manual endpoint, provider, and protocol prompts

