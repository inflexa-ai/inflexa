# cliproxy-credential-health — delta

## ADDED Requirements

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

In `cliproxy` connection mode, `ensureProxyReady` SHALL send one minimal model request through the running proxy (bounded `max_tokens`, bounded timeout) after the compose stack is up, using the proxy client key and the resolved default model. In `direct` connection mode no probe SHALL run. Only a definite HTTP 401 SHALL gate the launch: on a TTY it SHALL drive the existing interactive provider login inline, make the refreshed credential observable to the running proxy (restarting the proxy service or equivalent), and re-probe once — a second 401 fails the launch with an error naming both remaining causes (provider re-login did not take; proxy client key mismatch). On a non-TTY a 401 SHALL fail with an error naming the forced re-login command (`inflexa setup --provider <kind>`). Any other probe failure (non-401 status, timeout, connection failure) SHALL log a warning with the observed status and proceed — the probe must never add a new way for launch to block.

#### Scenario: Healthy credential launches without interruption

- **WHEN** the TUI launches in cliproxy mode and the probe request succeeds
- **THEN** launch proceeds with no prompt and no additional output beyond normal progress

#### Scenario: Dead credential is caught at launch, not mid-work

- **GIVEN** a credential whose refresh has died (every provider call answers 401)
- **WHEN** the TUI launches on a TTY
- **THEN** the interactive provider login runs before the TUI takes the terminal, the proxy observes the fresh credential, the re-probe passes, and launch proceeds

#### Scenario: Non-interactive launch fails actionably on a dead credential

- **WHEN** the probe receives a 401 and stdin is not a TTY
- **THEN** launch fails with an error naming `inflexa setup --provider <kind>` as the remedy

#### Scenario: Direct mode is never probed

- **WHEN** the TUI launches in `direct` connection mode
- **THEN** no probe request is sent (the user's own endpoint and key are not spent on validation)

#### Scenario: A provider outage does not block launch

- **WHEN** the probe fails with a 5xx, a timeout, or a connection failure
- **THEN** launch logs a warning carrying the observed failure and proceeds

### Requirement: Setup reports credential state truthfully

`inflexa setup`'s already-authenticated branch SHALL state only what it can know statically — that a credential exists — and SHALL name the forced re-login path (`--provider <name>`) as the remedy when provider calls fail authentication. It SHALL NOT assert that the credential is valid.

#### Scenario: Setup after a refresh death does not claim health

- **GIVEN** a present credential whose refresh token has been revoked (statically indistinguishable from a healthy one)
- **WHEN** `inflexa setup` runs without `--provider`
- **THEN** the message says a credential exists and names `--provider <name>` re-login as the fix for failing authentication, without claiming the credential works
