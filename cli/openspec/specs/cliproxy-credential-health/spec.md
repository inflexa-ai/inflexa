# cliproxy-credential-health Specification

## Purpose
Detecting a dead provider OAuth credential behind the managed CLIProxyAPI container before it fails work mid-flight: the structural presence check (what counts as a credential on disk), the launch-time live probe that is the sole authority on validity (a dead refresh token leaves no trace in the credential file), and setup's truthful reporting of what it can actually know statically.

## Requirements

### Requirement: Credential presence is decided structurally, never by expiry

The authenticated-state check of cliproxy MUST read only the `*.json` entries in the credential folder (`env.cliproxyAuthDir`). A credential whose JSON carries `disabled: true` MUST count as not authenticated. An unreadable or unparseable `*.json` entry MUST count as present, because the live probe decides validity, not the static check. The check MUST NOT use the `expired` timestamp of the credential. The access token expires each 8 hours by design, and the running proxy refreshes it. Thus a stale `expired` is normal.

#### Scenario: A logs-only auth dir is unauthenticated

- **WHEN** the credential dir contains only a `logs/` subdirectory (the credential JSON was deleted)
- **THEN** the check reports not authenticated, and `inflexa setup` and `inflexa up` offer the interactive login on a terminal
- **AND** the boot of the local server fails with the reason `sign_in_required` and the `inflexa up` remedy

#### Scenario: An operator-disabled credential is unauthenticated

- **WHEN** the only credential JSON carries `disabled: true`
- **THEN** the check reports not authenticated

#### Scenario: A past expired timestamp does not fail the static check

- **WHEN** a credential JSON has `disabled: false` and an `expired` timestamp in the past
- **THEN** the static check still reports authenticated, because the proxy refreshes the access token and only the live probe judges validity

### Requirement: Setup reports credential state truthfully

`inflexa setup`'s already-authenticated branch SHALL state only what it can know statically — that a credential exists — and SHALL name the forced re-login path (`--provider <name>`) as the remedy when provider calls fail authentication. It SHALL NOT assert that the credential is valid.

#### Scenario: Setup after a refresh death does not claim health

- **GIVEN** a present credential whose refresh token has been revoked (statically indistinguishable from a healthy one)
- **WHEN** `inflexa setup` runs without `--provider`
- **THEN** the message says a credential exists and names `--provider <name>` re-login as the fix for failing authentication, without claiming the credential works

### Requirement: The boot of the local server probes the live credential in cliproxy mode

The gate of the credential MUST run in the boot of the local server, before the harness runtime boots, and in `inflexa up`. It MUST never run in a client. In `cliproxy` mode, `ensureProxyReady` MUST send one minimal model request through the running proxy after the compose stack is up. The request has a bounded `max_tokens`, and each round-trip of the probe has a bounded timeout. It uses the proxy client key and the ELECTED default model (`default-model-election`). The walk of the election runs inside the resolution of the default model. Thus a top candidate that the credential cannot serve moves the walk forward, and the probe never gets a model that is known to 404. In `direct` mode, no probe MUST run.

Only a definite rejection of the provider MUST stop the gate: an HTTP 401 that the completion probe gets, which the proxy forwards from the provider. An empty model list MUST NOT be a verdict of rejection. A 401 from the model-listing route MUST NOT be one either. The proxy guards that route with its client-key middleware alone, thus the 401 proves a client-key mismatch, which a provider re-login cannot fix. The gate MUST then warn, name that condition and `inflexa setup` as the remedy, and continue.

The engine returns when the container starts, not when the proxy binds its port. The listener of the proxy also answers before its registration of the auth file completes. Thus a probe that gets no answer, and a probe that reads an empty model list, MUST both try again within one bounded budget. A model list that is still empty when the budget expires is ambiguous, not dead. The proxy possibly loaded nothing from the credential file, or the provider suspended the models of the credential for a bounded window. The gate MUST then give a notice that names the two causes and the remedy `inflexa setup --provider <name>`, and continue with no login.

A served 503 whose body carries the `auth_unavailable` cooldown marker of the proxy MUST count as a cooldown, not as a login that cannot be verified. The gate MUST report that the provider credential cools down after upstream errors and recovers on its own, and continue. A 503 with no known marker MUST go to the generic warn-and-continue path.

The boot MUST NOT offer or drive a provider login, also when the terminal of `inflexa serve` is interactive. A prompt there would hold the boot until someone answers it, and a background server has no terminal. A definite rejection MUST fail the boot with the reason `sign_in_required` and an error that names `inflexa up` in a terminal. The server then answers in the `failed` phase with that remedy, and a client shows it. On a terminal, `inflexa up` MUST offer the re-login, restart the proxy after it, and probe again. Then it asks the server to boot again, per `local-server`.

Each other failure of the probe MUST log a warning with the observed status and continue: a served status that is not 401, or a missing client key. The probe MUST never add a new way for the boot to fail, and the election MUST NOT add one either. Each notice and warning of the gate MUST go to the output of the process: the terminal, or the server log of a background server.

#### Scenario: Healthy credential boots without interruption

- **WHEN** the server boots in cliproxy mode and the probe request succeeds
- **THEN** the boot proceeds with no prompt and no additional output beyond normal progress

#### Scenario: An inaccessible top candidate no longer fails verification

- **GIVEN** a healthy credential whose account cannot serve the top-ranked advertised model
- **WHEN** the server boots and the election walks to an accessible candidate
- **THEN** the probe verifies the login against the elected model, and the boot continues with no warning
- **AND** the outcome "Provider login not verifiable (HTTP 404)" does not occur for a healthy credential

#### Scenario: Dead credential fails the boot with the remedy

- **GIVEN** a credential whose refresh has died (every provider call answers 401)
- **WHEN** the server boots, in the foreground on a TTY or in the background
- **THEN** no login prompt appears, and the boot fails with the reason `sign_in_required` and an error that names `inflexa up`
- **AND** the TUI offers the sign-in when it opens

#### Scenario: A sign-in through inflexa up

- **GIVEN** a credential whose refresh has died, and a server whose boot failed
- **WHEN** the person runs `inflexa up` in a terminal and accepts the re-login
- **THEN** the login runs, the proxy restarts, the probe passes, and the server boots again

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
- **THEN** the boot warns that the client key on disk does not match the running proxy, and it names `inflexa setup` as the remedy
- **AND** the boot drives no provider login, and it continues

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

The proxy loads credentials only at the start of its container. A write of the host to the mounted auth folder does not reach the file watcher of the running binary. Compose-up leaves a running container as it is. Thus an interactive provider login that completes while a proxy container runs MUST restart the proxy service. These logins are the authentication step of setup and the login of `inflexa up`. When no proxy container runs, no restart MUST occur: the next start of the container reads the auth folder. A restart that fails after a successful login MUST give an error that names the remedy.

The boot of the local server drives no login. With no credential on disk, it MUST fail with the reason `sign_in_required` and the `inflexa up` remedy.

#### Scenario: Forced re-login reaches the running proxy

- **GIVEN** the compose stack is up and the proxy is serving a dead credential
- **WHEN** `inflexa setup --provider <name>` completes a sign-in
- **THEN** the proxy service is restarted before setup exits, and the next chat uses the fresh credential without a relaunch

#### Scenario: A boot with no credential refuses instead of a login

- **GIVEN** a proxy auth dir with no usable credential
- **WHEN** the local server boots in cliproxy mode
- **THEN** the boot fails with the reason `sign_in_required` and an error that names `inflexa up`, and no login runs

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
