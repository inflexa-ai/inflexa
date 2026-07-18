# model-connection Specification (delta)

## MODIFIED Requirements

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

After the CLIProxy login, once the provisioned proxy is answering (setup runs no credential
probe — that is the launch gate's; the step skips gracefully, writing nothing, when the proxy
or its listing is not available), interactive setup SHALL present a default-model
selection: a preselected **Auto** row labeled with the currently elected model
(`default-model-election`), followed by the connection-family models from the proxy's `/models`
list, accessibility-checked via bounded-concurrency `count_tokens` requests — only a definite
`not_found_error` excludes a model from the list; an inconclusive check keeps it listed.
Accepting Auto SHALL write nothing (the default stays adaptive `model: null` resolution).
Explicitly choosing a model SHALL persist it to `models.agents.<agent>` for BOTH user-facing
agents (a deliberate pin). The flow SHALL contain no hardcoded model ids. On a non-TTY, setup
SHALL skip the selection (Auto semantics).

#### Scenario: CLIProxy setup records the provider from the login

- **WHEN** the user runs setup and authenticates the `claude` account kind
- **THEN** config records connection mode cliproxy with provider `anthropic`, written by setup —
  not derived from any model id

#### Scenario: Direct setup skips the proxy entirely

- **WHEN** the user chooses the direct path with an endpoint and provider
- **THEN** the `models.connection` block is written, no proxy container is provisioned or
  required for chat, and setup still provisions Postgres

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
  remains adaptive
