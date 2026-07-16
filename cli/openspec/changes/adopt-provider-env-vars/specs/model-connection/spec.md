## MODIFIED Requirements

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

## ADDED Requirements

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
