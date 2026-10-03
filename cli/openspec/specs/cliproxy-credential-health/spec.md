# cliproxy-credential-health Specification

## Purpose
Detecting a dead provider OAuth credential behind the managed CLIProxyAPI container before it fails work mid-flight: the structural presence check (what counts as a credential on disk), the launch-time live probe that is the sole authority on validity (a dead refresh token leaves no trace in the credential file), and setup's truthful reporting of what it can actually know statically.

## Requirements

### Requirement: Credential presence is decided structurally, never by expiry

The cliproxy authenticated-state check SHALL consider only `*.json` entries in the credential dir (`env.cliproxyAuthDir`), SHALL treat a credential whose JSON carries `disabled: true` as not authenticated, and SHALL treat an unreadable or unparseable `*.json` entry as present (the live probe, not the static check, is the authority on validity). The check SHALL NOT gate on the credential's `expired` timestamp: the access token expires every 8 hours by design and the running proxy refreshes it, so a stale `expired` is normal.

#### Scenario: A logs-only auth dir is unauthenticated

- **WHEN** the credential dir contains only a `logs/` subdirectory (the credential JSON was deleted)
- **THEN** the check reports not authenticated: `inflexa setup` offers the interactive login, and the boot of the local server fails with the `inflexa setup` remedy

#### Scenario: An operator-disabled credential is unauthenticated

- **WHEN** the only credential JSON carries `disabled: true`
- **THEN** the check reports not authenticated

#### Scenario: A past expired timestamp does not fail the static check

- **WHEN** a credential JSON has `disabled: false` and an `expired` timestamp in the past
- **THEN** the static check still reports authenticated (the proxy refreshes access tokens; only the live probe may judge validity)

### Requirement: Setup reports credential state truthfully

`inflexa setup`'s already-authenticated branch SHALL state only what it can know statically — that a credential exists — and SHALL name the forced re-login path (`--provider <name>`) as the remedy when provider calls fail authentication. It SHALL NOT assert that the credential is valid.

#### Scenario: Setup after a refresh death does not claim health

- **GIVEN** a present credential whose refresh token has been revoked (statically indistinguishable from a healthy one)
- **WHEN** `inflexa setup` runs without `--provider`
- **THEN** the message says a credential exists and names `--provider <name>` re-login as the fix for failing authentication, without claiming the credential works

### Requirement: The boot of the local server probes the live credential in cliproxy mode

The launch gate SHALL run in the boot of the local server, before the harness runtime boots, and never in a client. In `cliproxy` connection mode, `ensureProxyReady` SHALL send one minimal model request through the running proxy (bounded `max_tokens`, bounded timeout on every round-trip the probe makes) after the compose stack is up, using the proxy client key and the ELECTED default model (`default-model-election`): the election's validation walk runs inside default-model resolution, so a top-ranked candidate the credential cannot serve advances the walk instead of feeding the probe a model that is known to 404. In `direct` connection mode no probe SHALL run.

Only a definite provider-side rejection SHALL gate the boot: an HTTP 401 answered by the completion probe, which the proxy forwards from the provider. An empty model list SHALL NOT be a rejection verdict, and a 401 from the model-listing route SHALL NOT be one either — the proxy gates that route with its client-API-key middleware alone, so it proves a client-key mismatch between the config on disk and the running container, which a provider re-login cannot fix; the boot SHALL warn naming that condition and `inflexa setup` as the remedy, and proceed.

Because starting a container does not make its server *readable* — the engine returns when the container is started, not when the proxy has bound its port, and the proxy's listener answers before its asynchronous auth-file registration completes — a probe that gets no answer at all AND a probe that reads an empty model list from an answering proxy SHALL both be retried within one bounded budget rather than read as a verdict. A model list still empty when the budget expires is ambiguous, not dead: the proxy may have loaded nothing from the credential file, or the provider side may have temporarily suspended the credential's models (the proxy excludes suspended models from the list for a bounded window while the on-disk credential stays valid). The boot SHALL surface a notice naming both causes and the `inflexa setup --provider <name>` remedy, and proceed without driving any login.

A served 503 whose body carries the proxy's `auth_unavailable` cooldown marker SHALL be classified as a cooldown, not an unverifiable login: the boot SHALL report that the provider credential is cooling down after upstream errors and recovers on its own, and proceed. A 503 whose body carries no recognized marker SHALL fall through to the generic warn-and-proceed path.

The boot SHALL NOT offer or drive a provider login, even when the terminal of `inflexa serve` is interactive, because a prompt there would hold the boot until someone answers it, and a server in the background has no terminal. A definite rejection SHALL fail the boot with an error naming the forced re-login command (`inflexa setup --provider <kind>`). The server then answers in the `failed` phase with that remedy, and a client shows it. The boot starts again at `POST /api/v1/server/boot` or at the next start of the server. Any other probe failure (non-401 served status, missing client key) SHALL log a warning with the observed status and proceed — the probe must never add a new way for the boot to fail, and the election SHALL NOT add one either (an all-404 election yields its top candidate and this warn-and-proceed path reports it). Each notice and warning of the gate SHALL go to the output of the server: the terminal of a foreground `inflexa serve`, or the server log of a background server.

#### Scenario: Healthy credential boots without interruption

- **WHEN** the server boots in cliproxy mode and the probe request succeeds
- **THEN** the boot proceeds with no prompt and no additional output beyond normal progress

#### Scenario: An inaccessible top candidate no longer fails verification

- **GIVEN** a healthy credential whose account cannot serve the top-ranked advertised model
- **WHEN** the server boots and the election walks to an accessible candidate
- **THEN** the probe verifies the login against the elected model and the boot proceeds with no
  warning — the pre-election "Provider login not verifiable (HTTP 404)" outcome does not occur
  for a healthy credential

#### Scenario: Dead credential fails the boot with the remedy

- **GIVEN** a credential whose refresh has died (every provider call answers 401)
- **WHEN** the server boots, in the foreground on a TTY or in the background
- **THEN** no login prompt appears, the boot fails with an error naming `inflexa setup --provider <kind>`, and the TUI shows that error when it opens

#### Scenario: The cold-boot registration window is waited out, not misread

- **GIVEN** a proxy container that is answering but whose auth-file registration has not landed yet (its model list is still empty)
- **WHEN** the probe reads the empty list within the readiness budget
- **THEN** it retries until the list populates and reads the verdict from the populated proxy

#### Scenario: A list still empty at the deadline warns with both causes and proceeds

- **GIVEN** a proxy that answers with an empty model list for the whole readiness budget (an unloadable credential file, or a provider-side suspension window)
- **WHEN** the budget expires
- **THEN** the boot writes a notice naming both possible causes and `inflexa setup --provider <name>` as the remedy, drives no login, and proceeds

#### Scenario: A cooldown answers with its own notice, never a login prompt

- **WHEN** the probe receives a served 503 whose body carries the proxy's `auth_unavailable` marker
- **THEN** the boot reports the credential is cooling down after upstream errors and recovers on its own, and proceeds without any login prompt

#### Scenario: A model-listing 401 names the client-key mismatch, not the provider login

- **WHEN** the model-listing route answers 401 while resolving the probe's inputs
- **THEN** the boot warns that the client key on disk does not match the running proxy, names `inflexa setup` as the remedy, drives no provider login, and proceeds

#### Scenario: Direct mode is never probed

- **WHEN** the server boots in `direct` connection mode
- **THEN** no probe request is sent (the user's own endpoint and key are not spent on validation)

#### Scenario: A provider outage does not block the boot

- **WHEN** the probe fails with a served 5xx carrying no recognized cooldown marker
- **THEN** the boot logs a warning carrying the observed failure and proceeds

#### Scenario: A cold proxy is waited for, not misread

- **GIVEN** a proxy container that has started but not yet bound its port
- **WHEN** the probe finds nothing answering
- **THEN** it retries within its budget and reads the verdict once the proxy answers, rather than reporting an unverifiable login

#### Scenario: A proxy that never answers does not block the boot

- **WHEN** nothing answers for the whole retry budget
- **THEN** the boot logs a warning carrying the observed failure and proceeds

### Requirement: A login of setup is made observable to an already-running proxy

The proxy loads credentials only at container start — host-side writes to the mounted auth dir do not reach the running binary's file watcher, and compose-up leaves a running container untouched. Therefore any interactive provider login that completes while a proxy container is already running — setup's authentication step — SHALL restart the proxy service so it serves the credential the user just created. When no proxy container is running, no restart SHALL be attempted: the next container start reads the auth dir at boot. A restart failure after a successful login SHALL surface as an actionable error naming the remedy, never proceed silently with a proxy that cannot serve the new credential. The boot of the local server drives no login: with no credential on disk, it SHALL fail with the `inflexa setup` remedy.

#### Scenario: Forced re-login reaches the running proxy

- **GIVEN** the compose stack is up and the proxy is serving a dead credential
- **WHEN** `inflexa setup --provider <name>` completes a sign-in
- **THEN** the proxy service is restarted before setup exits, and the next chat uses the fresh credential without a relaunch

#### Scenario: A boot with no credential refuses instead of a login

- **GIVEN** a proxy auth dir with no usable credential
- **WHEN** the local server boots in cliproxy mode
- **THEN** the boot fails with an error that names `inflexa setup`, and no login runs

#### Scenario: No running proxy, no restart

- **WHEN** a login completes while no proxy container is running
- **THEN** no restart is attempted and the container reads the credential when it next starts

### Requirement: The boot of the local server warns when an explicit model pin has gone stale

The launch gate in the boot of the local server SHALL check each distinct explicitly-pinned model's
accessibility — when it runs in cliproxy mode on an anthropic-family connection and a pin exists
(`models.agents.*` or `harness.model`) — with the unbilled `count_tokens` request (bounded like
every probe round-trip). A definite `not_found_error` SHALL produce a warning in the output of the
server, naming the pinned model, the agent(s) resolving to it, and the repick remedy (the palette's
model-switch commands or setup) — it SHALL NOT block the boot and SHALL NOT rewrite config. Any
inconclusive outcome SHALL stay silent (only a definite verdict is worth interrupting the boot
output for). Auto-resolved sessions are outside this requirement — election already validated the
default.

#### Scenario: A pin the account can no longer serve is named at boot

- **GIVEN** `models.agents.conversation` pinned to a model the upstream account no longer serves
- **WHEN** the local server boots
- **THEN** a warning in the output of the server names the pinned model, the conversation agent,
  and how to repick — and the boot proceeds (the real failure remains observable in chat)

#### Scenario: A healthy pin adds no boot output

- **WHEN** every pinned model's accessibility check answers 200
- **THEN** the boot output is unchanged from the pre-change flow

#### Scenario: A flaky check never interrupts the boot

- **WHEN** a pinned model's accessibility check times out
- **THEN** no warning is shown and the boot proceeds
