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

The environment that this resolution reads SHALL be the environment of the local server process,
because the server boots the runtime and sends each chat request. A server that a client starts in
the background inherits the environment of that client. A client that runs later with a different
value does not change the key of a running server: a changed variable SHALL take effect only at the
next start of the server. The remedy of a refused key SHALL therefore name the restart of the server.

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

#### Scenario: A key set after the server started does not reach it

- **GIVEN** a direct-mode server that a client started with no key in its environment, and a boot that failed for the missing key
- **WHEN** the user exports `INFLEXA_MODEL_API_KEY` in a new shell and runs a command
- **THEN** the running server keeps its failed boot, and the key takes effect when the server starts again from that shell
