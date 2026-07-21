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
This env resolution is the DEFAULT credential source, used when the connection configures no explicit
`auth` block; a configured `auth` block (see "The direct connection may use a refreshing credential
source") takes precedence over it. The resolution order SHALL be: `INFLEXA_MODEL_API_KEY` first (the
explicit override); when it is unset, the provider-conventional variable derived from the
connection's configured `provider` — `ANTHROPIC_API_KEY` for provider `anthropic`, `OPENAI_API_KEY`
for every other provider. The key SHALL never be written to `config.json`, never appear in telemetry
or logs, and never be recorded in provenance — the provider-derived fallback READS an existing
environment secret, it never copies it. In `direct` mode a credential that resolves to nothing — from
neither a configured `auth` source nor the env chain — SHALL fail boot with an actionable error: for
the env path, naming both `INFLEXA_MODEL_API_KEY` and the provider-conventional variable that was
tried; for a configured source, naming that source. In `cliproxy` mode the existing proxy client key
discovery is unchanged and this resolution is not used. Boot SHALL NOT read the endpoint URL from the
environment; the endpoint remains configuration authored (or adopted) at setup — ecosystem endpoint
variables are read only for one-time setup detection (see "Setup detects and adopts ecosystem
provider environment").

#### Scenario: Explicit override wins over the provider variable

- **WHEN** the connection is `direct` with provider `anthropic`, no `auth` block, and BOTH
  `INFLEXA_MODEL_API_KEY` and `ANTHROPIC_API_KEY` are set
- **THEN** `INFLEXA_MODEL_API_KEY` is used and `ANTHROPIC_API_KEY` is ignored

#### Scenario: Provider-derived fallback resolves the key

- **WHEN** the connection is `direct` with provider `anthropic`, no `auth` block,
  `INFLEXA_MODEL_API_KEY` is unset, and `ANTHROPIC_API_KEY` is set (symmetrically: provider `openai`
  with `OPENAI_API_KEY` set)
- **THEN** the provider-conventional variable is used as the key, still read from the environment
  and never written to any persisted surface

#### Scenario: Missing key blocks a direct boot actionably

- **WHEN** the connection is `direct` with no `auth` block and neither `INFLEXA_MODEL_API_KEY` nor
  the provider's conventional variable is set
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
the elected default from the proxy's `/models` list — the deterministic, accessibility-validated
election defined by `default-model-election`, replacing the serving-order first match), guarded
by provider-family agreement — an auto-resolved id whose family does not match the configured
provider SHALL fail boot with a remediation message (this generalizes and replaces the
`model_not_claude` guard; with the default provider it is behavior-identical to it). In `direct`
mode an explicit model id is REQUIRED and no auto-resolve occurs; a missing model SHALL fail
boot actionably. The composition SHALL carry the connection's `provider` slug (the configured
fact) wherever the model's vendor identity is consumed.

#### Scenario: Cliproxy default boot is unchanged

- **WHEN** boot runs with the default connection and an authenticated Claude account
- **THEN** the provider targets the proxy endpoint over the Anthropic protocol with the elected
  Claude model — indistinguishable from the pre-change boot apart from the deterministic,
  validated pick

#### Scenario: Provider-family mismatch replaces model_not_claude

- **WHEN** the connection is cliproxy with provider `anthropic` and the proxy's `/models`
  election yields a non-Claude id
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

Interactive direct setup SHALL also collect the model id — direct mode has no auto-resolve, so a
connection without one cannot boot. The prompt SHALL pre-fill from a three-tier precedence: the
endpoint's ranked `/models` listing when it answered 2xx; else a provider-conventional default from
a small declared table keyed by the provider SLUG (not the protocol — an openai-compatible endpoint
routinely serves models outside the slug's family) covering only the major providers; else plain
free text with no guess. The conventional default SHALL be an editable pre-fill only — never
silently written — and the confirmed id SHALL be validated with the same protocol-shaped
`max_tokens: 1` request the credential probe uses whenever a credential is at hand (the probe's
minted token, else the static env key; absent both the pick persists unvalidated — boot and first
chat remain the gate): a definite model-not-found re-prompts with the
endpoint's error body shown (endpoints often name their served ids there), an ambiguous outcome
offers to save anyway, and a pass persists the id to `models.agents.<agent>` for BOTH user-facing
agents. On a non-TTY the direct path SHALL write no model, and boot's actionable `model_required`
failure remains the contract.

After the CLIProxy login, once the provisioned proxy is answering (setup runs no credential
probe — that is the launch gate's; the step skips gracefully, writing nothing, when the proxy
or its listing is not available), interactive setup SHALL present a default-model
selection: a preselected **Auto** row labeled with the currently elected model
(`default-model-election`), followed by the connection-family models from the proxy's `/models`
list, accessibility-checked via bounded-concurrency `count_tokens` requests — only a definite
`not_found_error` excludes a model from the list; an inconclusive check keeps it listed.
Accepting Auto SHALL write nothing (the default stays adaptive `model: null` resolution).
Explicitly choosing a model SHALL persist it to `models.agents.<agent>` for BOTH user-facing
agents (a deliberate pin). The flow SHALL contain no hardcoded model ids, with ONE declared
exception: the provider-conventional default table above, which exists solely as a pre-fill for
direct setups whose endpoint serves no listing, is confirmed by the user and validated before any
write, and carries a comment naming its rot risk (a stale entry costs one failed validation and
one edit at setup — never a persisted broken config). On a non-TTY, setup
SHALL skip the selection (Auto semantics).

#### Scenario: CLIProxy setup records the provider from the login

- **WHEN** the user runs setup and authenticates the `claude` account kind
- **THEN** config records connection mode cliproxy with provider `anthropic`, written by setup —
  not derived from any model id

#### Scenario: Direct setup skips the proxy entirely

- **WHEN** the user chooses the direct path with an endpoint and provider
- **THEN** the `models.connection` block is written, no proxy container is provisioned or
  required for chat, and setup still provisions Postgres

#### Scenario: Direct setup collects and validates the model id

- **WHEN** the user completes the interactive direct path against an endpoint whose `/models`
  answered 2xx
- **THEN** the model prompt pre-fills from the ranked listing, the confirmed id is validated with a
  `max_tokens: 1` request, and on a pass `models.agents.conversation` and `models.agents.sandbox`
  are both written to it

#### Scenario: A conventional default pre-fills when the listing is unavailable

- **WHEN** the direct endpoint 404s `/models` and the configured provider slug has a
  conventional-default entry
- **THEN** the model prompt pre-fills with that default as editable text, nothing is written until
  the user confirms, and a provider slug without an entry yields an empty free-text prompt instead

#### Scenario: A definite model-not-found re-prompts with the endpoint's error

- **WHEN** the confirmed model id draws a definite model-not-found from the validation request
- **THEN** setup re-prompts for the id showing the endpoint's error body (which may name the served
  ids), and nothing is persisted for the rejected id

#### Scenario: Accepting Auto keeps the default adaptive

- **WHEN** the user accepts the preselected Auto row (labeled with the elected model)
- **THEN** no model key is written to config and later launches keep electing the default from
  the live list

#### Scenario: An explicit setup pick pins both agents

- **WHEN** the user selects a specific model instead of Auto
- **THEN** `models.agents.conversation` and `models.agents.sandbox` are both written to that id

#### Scenario: The selection list hides only definitely inaccessible models

- **WHEN** one listed model answers the accessibility check with `not_found_error` and another's
  check times out
- **THEN** the 404ing model is excluded from the list and the timed-out one remains listed

#### Scenario: Non-interactive setup skips the model step

- **WHEN** setup runs without a TTY
- **THEN** no model prompt is shown, nothing is written to `models.agents`, and the default
  remains adaptive in cliproxy mode — while a non-TTY direct setup boots to the actionable
  `model_required` failure until a model is configured

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

### Requirement: The direct connection may use a refreshing credential source

When configured, `models.connection.auth` SHALL supply the `direct` connection's wire credential as a
refreshing source that takes precedence over the environment key resolution. A `direct` connection MAY
omit it (the environment resolution then applies). The `auth` block SHALL be one of: `{ kind: "env"; var; scheme }` (read a token from a
named environment variable — e.g. a short-lived `ANTHROPIC_AUTH_TOKEN` bearer), or
`{ kind: "command"; command; scheme; format?; ttlMs? }` (run a command to mint a token). The CLI
SHALL resolve either into a cached credential source — an async supplier that yields the token, its
scheme, and an optional expiry — evaluated at the provider-construction site so the token is obtained
lazily and refreshed, never read once at boot. A command's stdout SHALL be parsed as either a raw
token (`format: "raw"`, the default — byte-for-byte Claude Code `apiKeyHelper` parity) or a
Kubernetes `ExecCredential` JSON (`format: "exec-credential"` — `apiVersion:
client.authentication.k8s.io/v1`, reading `status.token` and `status.expirationTimestamp`). A raw
command token that parses as a JWT (a decodable base64url payload carrying a numeric `exp` claim)
SHALL age off its self-described expiry: `expiresAt` is the EARLIER of the `exp` claim and
`now + ttlMs` when `ttlMs` is set, the `exp` claim alone when it is not — the earliest-wins rule
exists because `exp` is a hard fact while `ttlMs` is only a refresh cadence, and a helper that
serves cached tokens may hand out a token with far less remaining lifetime than any fixed TTL
assumes. The raw-token default TTL SHALL apply only when no `exp` claim is readable; a payload that
fails to decode or carries no numeric `exp` SHALL degrade to "no self-described expiry" (never an
error), and an `exp` already in the past SHALL still yield the credential (marked expired, so the
next resolution re-mints — a helper serving nearly-dead cached tokens degrades to per-request
minting, never a failure loop). This decode applies to `command`-kind raw tokens only; `env`-kind
tokens remain expiry-less (a fixed process environment cannot yield a fresh token, so expiry-driven
re-reads gain nothing). Refresh
SHALL honor the parsed expiry (minus a safety buffer), fall back to `ttlMs` for a raw token with no
expiry, and force-refresh reactively on an HTTP `401` followed by a single retry. The token SHALL be
sent on the wire as `x-api-key` (scheme `x-api-key`) or `Authorization: Bearer` (scheme `bearer`),
injected through the harness provider's `fetch` seam. The token value SHALL never be written to
`config.json`, telemetry, logs, or provenance — the `auth` block persists only the variable name /
command string / scheme. The command invocation SHALL be wrapped so a spawn or parse failure surfaces
as an actionable error, never an uncaught throw.

#### Scenario: An env bearer token is sent as Authorization: Bearer

- **WHEN** `auth` is `{ kind: "env", var: "ANTHROPIC_AUTH_TOKEN", scheme: "bearer" }` over the
  anthropic protocol and the variable holds a token
- **THEN** the request to `{baseURL}/messages` carries `Authorization: Bearer <token>` and no
  `x-api-key` header, and the token appears in no persisted surface

#### Scenario: A credential command mints and caches a token

- **WHEN** `auth` is `{ kind: "command", command, scheme: "bearer" }` and the command prints a raw
  token
- **THEN** the command is run to obtain the token, the token is cached and reused across requests,
  and the command is re-run only on refresh — not per request

#### Scenario: ExecCredential expiry drives refresh

- **WHEN** the command emits `ExecCredential` JSON with a `status.expirationTimestamp` in the near
  future
- **THEN** the token is reused until the expiry (minus buffer), after which the command is re-run to
  obtain a fresh token

#### Scenario: A raw JWT ages off its own exp claim

- **WHEN** the command prints a raw JWT whose payload carries `exp` 90 seconds from now, and no
  `ttlMs` is configured
- **THEN** the credential's expiry is the `exp` claim (not the raw-token default TTL), so the token
  is re-minted before the JWT actually dies rather than being held for the full default window

#### Scenario: Earliest of exp and ttlMs wins

- **WHEN** the command prints a raw JWT with `exp` an hour away and `ttlMs` is configured to five
  minutes
- **THEN** the credential expires by `ttlMs` (the earlier bound) — and were `exp` the nearer one,
  it would win instead; the configured cadence can only shorten the hold, never extend it past `exp`

#### Scenario: An undecodable payload degrades to the default TTL

- **WHEN** the command prints a raw token that starts like a JWT but whose payload does not decode
  to JSON with a numeric `exp`
- **THEN** the token is treated exactly as an opaque raw token (the default TTL applies) and no
  error is raised

#### Scenario: A 401 forces a refresh and one retry

- **WHEN** a request returns HTTP 401 with a cached credential
- **THEN** the source force-refreshes the token and the request is retried once with the new token

#### Scenario: A configured source overrides the environment key

- **WHEN** an `auth` block is configured AND `INFLEXA_MODEL_API_KEY` is also set
- **THEN** the `auth` source supplies the credential and the env key is not consulted

### Requirement: Setup detects a credential-helper setup and offers the credential-source path

`inflexa setup` SHALL detect a credential-helper Anthropic setup and offer the credential-source
path, writing only the source's variable name / command and scheme — never a token — and validating
the source before it is saved. Detection SHALL use read-only signals: `claude auth status` reporting
an api-key-helper auth method, an `apiKeyHelper` entry in the user's `~/.claude/settings.json` (or the
managed settings file), or `ANTHROPIC_AUTH_TOKEN` present in the environment. The offer SHALL be
opt-in: the user SHALL supply or confirm the command (which MAY be pre-filled from the user's OWN
user-level settings), and setup SHALL NOT silently lift and execute the organization's
managed-settings helper without the user's confirmation. Before writing config, setup SHALL run the
resolved source once and validate it against the configured endpoint with a PROBE LADDER in which
`GET {baseURL}/models` is opportunistic and a protocol-shaped message request is authoritative:

- A 2xx from `{baseURL}/models` passes the probe (and its ids MAY seed the model prompt's pre-fill
  list).
- An HTTP 401 or 403 from ANY rung fails the probe with an actionable message naming the likely
  cause (command, scheme, or endpoint).
- Any other `/models` outcome (404, 405, 5xx, network failure) SHALL NOT fail the probe; setup
  escalates to the authoritative rung: a `max_tokens: 1` message POST shaped by the connection's
  protocol (`{baseURL}/messages` with the `anthropic-version` header for `anthropic`;
  `{baseURL}/chat/completions` for `openai-compatible`) — the one request that tests a NECESSARY
  condition of the connection. The interactive progress line SHALL name this one-time 1-token spend.
- On the message rung, a 2xx OR a definite model-not-found error body passes (the request cleared
  authentication and routing — everything a credential probe asserts).
- Any other message-rung outcome is AMBIGUOUS (enterprise gateways signal auth failures with
  non-standard statuses, e.g. 500): setup SHALL show the status and a body excerpt and offer to
  save the auth block anyway, rather than silently discarding a possibly-working credential source.

Only the source name/command and scheme SHALL be written to `models.connection.auth`.

#### Scenario: A detected helper setup offers the credential-source path

- **WHEN** setup's direct path runs and `claude auth status` reports an api-key-helper method (or an
  `apiKeyHelper` is present in the user's Claude settings)
- **THEN** setup offers the credential-source path (credential command or env bearer token) instead
  of only prompting for a static key

#### Scenario: The user confirms the command and no token is written

- **WHEN** the user chooses the credential-command path and supplies/confirms a command
- **THEN** `models.connection.auth` records `{ kind: "command", command, scheme, ... }` and
  `config.json` contains no token material

#### Scenario: The validation probe catches a bad configuration

- **WHEN** the supplied command, scheme, or endpoint is wrong and a probe rung answers 401 or 403
- **THEN** setup reports an actionable error naming the likely cause and does not write the broken
  `auth` block

#### Scenario: A missing /models route does not fail the probe

- **WHEN** the gateway 404s `GET {baseURL}/models` under a valid bearer but answers the
  `max_tokens: 1` message POST with 2xx
- **THEN** the probe passes and the auth block is written — the optional listing route's absence is
  not treated as a credential failure

#### Scenario: An ambiguous probe outcome offers save-anyway

- **WHEN** the message rung answers a non-2xx, non-401/403 status (e.g. a gateway that responds 500
  `invalid token` for every rejection)
- **THEN** setup shows the status and a body excerpt and asks whether to save the auth block anyway;
  declining discards it, accepting writes it unchanged

#### Scenario: The org managed-settings helper is not auto-executed

- **WHEN** only an org-managed `managed-settings.json` `apiKeyHelper` is present (no user-level entry)
- **THEN** setup surfaces that a helper was detected but requires the user to confirm the command
  before Inflexa will run it — it does not auto-execute the managed helper

