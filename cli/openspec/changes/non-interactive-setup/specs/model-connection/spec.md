# model-connection Specification (delta)

## MODIFIED Requirements

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
agents. Under batch resolution (`--yes`, or any non-TTY run), the direct path SHALL instead
REQUIRE a model answer (`--model` / `connection.model`): setup SHALL fail during upfront
validation — before any mutation — when it is absent, so a provisioned client never boots into
`model_required`. An answered id SHALL be validated with the same request when validation is
enabled, and must PASS: a definite model-not-found, an auth rejection, an unreachable endpoint,
or an outcome the validation cannot classify all FAIL the run with the endpoint's answer shown —
batch has no save-anyway confirm, so ambiguity fails hard, and `--no-validate` (which persists
the id unvalidated) is the deliberate escape. A persisted answer lands on BOTH user-facing
agents.

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
one edit at setup — never a persisted broken config). Under batch resolution, setup SHALL NOT
present the selection: without a model answer it writes nothing (Auto semantics); with one, the
id persists to BOTH agents without any prompt, checked via the accessibility route when the
provisioned proxy answers — only a definite not-found fails the run; an inconclusive check
proceeds, because the accessibility check is opportunistic (a pre-staged proxy has no credential
loaded, so inconclusive must not fail a legitimate pre-stage) — the strict pass-or-fail contract
applies to the direct-endpoint validation above.

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

#### Scenario: Batch cliproxy without a model answer stays adaptive

- **WHEN** `setup --yes` runs in cliproxy mode with no model answer
- **THEN** no model prompt is shown, nothing is written to `models.agents`, and the default
  remains adaptive

#### Scenario: Batch direct without a model answer fails upfront

- **WHEN** `setup --yes --connection direct` runs with the endpoint and provider answered but no
  model answer
- **THEN** setup fails before any mutation with an error naming `--model` and `connection.model`

#### Scenario: A batch model answer pins both agents

- **WHEN** `setup --yes` runs with `--model <id>` in either connection mode
- **THEN** `models.agents.conversation` and `models.agents.sandbox` are both written to it without
  any prompt

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
only"). When both ecosystem sets are present, interactive setup SHALL prompt which to adopt.
Adoption is an INTERACTIVE affordance only: under batch resolution (`--yes` or any non-TTY run)
setup SHALL NOT adopt from the environment — the connection facts must be explicit answers, and a
batch direct run without them SHALL fail during upfront validation naming the missing flags and
file keys. Declining the offer SHALL fall through to the existing manual
endpoint/provider/protocol prompts. The CLI SHALL NOT adopt `ANTHROPIC_AUTH_TOKEN` (Anthropic-wire
Bearer auth is out of scope pending a harness capability) nor Bedrock/Vertex environment (no
direct-mode signer).

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

#### Scenario: Batch direct setup requires explicit answers

- **WHEN** `setup --yes --connection direct` runs with `ANTHROPIC_API_KEY` set but no
  `--base-url`/`--provider` answers
- **THEN** nothing is adopted and setup fails upfront naming the missing answers — the env key
  remains only the runtime secret, never a source of connection facts

#### Scenario: The adopted key is never copied to config

- **WHEN** any ecosystem environment is adopted at setup
- **THEN** `config.models.connection` contains `provider`/`baseURL`/`protocol` only, and
  `config.json` contains no API key material

#### Scenario: Declining the offer falls through to manual entry

- **WHEN** a provider environment is detected but the user declines the pre-filled offer
- **THEN** setup runs the existing manual endpoint, provider, and protocol prompts

## ADDED Requirements

### Requirement: A direct credential source is declarable as answers

The direct connection's refreshing credential source SHALL be answerable without the interactive
detection/offer flow: `--auth-env <VAR> --auth-scheme x-api-key|bearer` declares the env-variable
source, and `--auth-command <cmd> --auth-scheme x-api-key|bearer [--auth-format raw|exec-credential]`
declares the command source (file: `connection.auth.{kind,var,command,scheme,format,ttlMs}`). The
answers are token-free by construction — only the variable name, command string, scheme, format,
and ttl are ever accepted or persisted, mirroring the existing `models.connection.auth` block.
When validation is enabled, an answered source SHALL be validated with the existing probe ladder
before it is persisted, and must PASS: any outcome short of a pass — a definite rejection, an
unreachable endpoint, or an ambiguous non-standard answer — FAILS the run with the probe's
response shown (batch has no save-anyway confirm; `--no-validate` skips the probe and persists
the token-free source unvalidated — the deliberate escape for gateways that cannot pass a
standards-shaped probe).
Credential-helper DETECTION remains an interactive affordance: batch runs never read the Claude
settings files or offer detected helpers.

#### Scenario: An answered command source is probed then persisted

- **WHEN** `setup --yes --connection direct --base-url <url> --provider anthropic --model <id> --auth-command "my-helper" --auth-scheme bearer` runs with validation on and the probe ladder passes
- **THEN** `models.connection.auth` persists `{kind: "command", command: "my-helper", scheme: "bearer"}` with no token material anywhere in config

#### Scenario: A failing answered source fails the provision

- **WHEN** the same run's probe draws a definite auth rejection
- **THEN** setup exits non-zero with the probe's actionable message and the auth block is not persisted

#### Scenario: An ambiguous probe answer fails hard in batch

- **WHEN** the same run's probe draws a non-standard status (e.g. a gateway's 500-for-bad-token)
- **THEN** setup exits non-zero showing the status and body excerpt, names `--no-validate` as the escape, and persists nothing
