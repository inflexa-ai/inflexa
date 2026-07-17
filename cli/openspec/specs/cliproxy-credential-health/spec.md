# cliproxy-credential-health Specification

## Purpose
Detecting a dead provider OAuth credential behind the managed CLIProxyAPI container before it fails work mid-flight: the structural presence check (what counts as a credential on disk), the launch-time live probe that is the sole authority on validity (a dead refresh token leaves no trace in the credential file), and setup's truthful reporting of what it can actually know statically.
## Requirements
### Requirement: Credential presence is decided structurally, never by expiry

The cliproxy authenticated-state check SHALL consider only `*.json` entries in the credential dir (`env.cliproxyAuthDir`), SHALL treat a credential whose JSON carries `disabled: true` as not authenticated, and SHALL treat an unreadable or unparseable `*.json` entry as present (the live probe, not the static check, is the authority on validity). The check SHALL NOT gate on the credential's `expired` timestamp: the access token expires every 8 hours by design and the running proxy refreshes it, so a stale `expired` is normal.

#### Scenario: A logs-only auth dir is unauthenticated

- **WHEN** the credential dir contains only a `logs/` subdirectory (the credential JSON was deleted)
- **THEN** the check reports not authenticated and the interactive login path is offered

#### Scenario: An operator-disabled credential is unauthenticated

- **WHEN** the only credential JSON carries `disabled: true`
- **THEN** the check reports not authenticated

#### Scenario: A past expired timestamp does not fail the static check

- **WHEN** a credential JSON has `disabled: false` and an `expired` timestamp in the past
- **THEN** the static check still reports authenticated (the proxy refreshes access tokens; only the live probe may judge validity)

### Requirement: The launch gate probes the live credential in cliproxy mode

In `cliproxy` connection mode, `ensureProxyReady` SHALL send one minimal model request through the running proxy (bounded `max_tokens`, bounded timeout on every round-trip the probe makes) after the compose stack is up, using the proxy client key and the resolved default model. In `direct` connection mode no probe SHALL run.

Only a definite credential rejection SHALL gate the launch — an HTTP 401, or an empty model list from a proxy that is answering (it serves that list from its own registry and answers with the full list even behind a dead credential, so an empty one means it loaded no credential at all, contradicting the presence check that just passed). On a TTY a rejection SHALL drive the existing interactive provider login inline, make the refreshed credential observable to the running proxy (restarting the proxy service or equivalent), and re-probe once — a second rejection fails the launch with an error naming both remaining causes (provider re-login did not take; proxy client key mismatch). On a non-TTY a rejection SHALL fail with an error naming the forced re-login command (`inflexa setup --provider <kind>`). Any other probe failure (non-401 served status, missing client key) SHALL log a warning with the observed status and proceed — the probe must never add a new way for launch to block.

Because starting a container does not make its server reachable — the engine returns when the container is started, not when the proxy has bound its port — a probe that gets no answer at all SHALL be retried within a bounded budget rather than read as a verdict or as an outage. A proxy still silent at the budget SHALL warn and proceed like any other unreadable failure. This wait SHALL apply to every probe, including the re-probe that follows a proxy restart, whose container is always cold.

#### Scenario: Healthy credential launches without interruption

- **WHEN** the TUI launches in cliproxy mode and the probe request succeeds
- **THEN** launch proceeds with no prompt and no additional output beyond normal progress

#### Scenario: Dead credential is caught at launch, not mid-work

- **GIVEN** a credential whose refresh has died (every provider call answers 401)
- **WHEN** the TUI launches on a TTY
- **THEN** the interactive provider login runs before the TUI takes the terminal, the proxy observes the fresh credential, the re-probe passes, and launch proceeds

#### Scenario: A credential the proxy cannot load is caught, not warned past

- **GIVEN** a credential file that passes the presence check but the proxy loads nothing from (e.g. its contents are corrupt)
- **WHEN** the TUI launches on a TTY and the answering proxy serves an empty model list
- **THEN** the launch treats it as a credential rejection and drives the interactive login, rather than warning and launching a chat that cannot work

#### Scenario: Non-interactive launch fails actionably on a dead credential

- **WHEN** the probe receives a 401 and stdin is not a TTY
- **THEN** launch fails with an error naming `inflexa setup --provider <kind>` as the remedy

#### Scenario: Direct mode is never probed

- **WHEN** the TUI launches in `direct` connection mode
- **THEN** no probe request is sent (the user's own endpoint and key are not spent on validation)

#### Scenario: A provider outage does not block launch

- **WHEN** the probe fails with a served 5xx
- **THEN** launch logs a warning carrying the observed failure and proceeds

#### Scenario: A cold proxy is waited for, not misread

- **GIVEN** a proxy container that has started but not yet bound its port
- **WHEN** the probe finds nothing answering
- **THEN** it retries within its budget and reads the verdict once the proxy answers, rather than reporting an unverifiable login

#### Scenario: A proxy that never answers does not block launch

- **WHEN** nothing answers for the whole retry budget
- **THEN** launch logs a warning carrying the observed failure and proceeds

### Requirement: A fresh login is made observable to an already-running proxy

The proxy loads credentials only at container start — host-side writes to the mounted auth dir do not reach the running binary's file watcher, and compose-up leaves a running container untouched. Therefore any interactive provider login that completes while a proxy container is already running — setup's authentication step, or the launch gate's missing-credential login — SHALL restart the proxy service so it serves the credential the user just created. When no proxy container is running, no restart SHALL be attempted: the next container start reads the auth dir at boot. A restart failure after a successful login SHALL surface as an actionable error naming the remedy, never proceed silently with a proxy that cannot serve the new credential. (The launch probe's own re-login path already restarts before its re-probe; this requirement extends the same guarantee to logins that run before any probe.)

#### Scenario: Forced re-login reaches the running proxy

- **GIVEN** the compose stack is up and the proxy is serving a dead credential
- **WHEN** `inflexa setup --provider <name>` completes a sign-in
- **THEN** the proxy service is restarted before setup exits, and the next chat uses the fresh credential without a relaunch

#### Scenario: Launch-gate login does not demand a second login

- **GIVEN** a proxy container left running with no usable credential (the login was previously skipped)
- **WHEN** the TUI launches and the missing-credential login completes
- **THEN** the proxy is restarted before the credential probe runs, the probe reads the fresh credential, and no second login is driven

#### Scenario: No running proxy, no restart

- **WHEN** a login completes while no proxy container is running
- **THEN** no restart is attempted and the container reads the credential when it next starts

### Requirement: Setup reports credential state truthfully

`inflexa setup`'s already-authenticated branch SHALL state only what it can know statically — that a credential exists — and SHALL name the forced re-login path (`--provider <name>`) as the remedy when provider calls fail authentication. It SHALL NOT assert that the credential is valid.

#### Scenario: Setup after a refresh death does not claim health

- **GIVEN** a present credential whose refresh token has been revoked (statically indistinguishable from a healthy one)
- **WHEN** `inflexa setup` runs without `--provider`
- **THEN** the message says a credential exists and names `--provider <name>` re-login as the fix for failing authentication, without claiming the credential works
