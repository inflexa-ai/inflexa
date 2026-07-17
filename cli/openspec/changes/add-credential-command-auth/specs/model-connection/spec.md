## MODIFIED Requirements

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

## ADDED Requirements

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
client.authentication.k8s.io/v1`, reading `status.token` and `status.expirationTimestamp`). Refresh
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
resolved source once and perform a cheap authentication probe against the configured endpoint (e.g.
`GET {baseURL}/models`), failing with an actionable message that names the likely cause (command,
scheme, or endpoint) when the probe does not succeed. Only the source name/command and scheme SHALL
be written to `models.connection.auth`.

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

- **WHEN** the supplied command, scheme, or endpoint is wrong and the setup probe fails
- **THEN** setup reports an actionable error naming the likely cause and does not write the broken
  `auth` block

#### Scenario: The org managed-settings helper is not auto-executed

- **WHEN** only an org-managed `managed-settings.json` `apiKeyHelper` is present (no user-level entry)
- **THEN** setup surfaces that a helper was detected but requires the user to confirm the command
  before Inflexa will run it — it does not auto-execute the managed helper
