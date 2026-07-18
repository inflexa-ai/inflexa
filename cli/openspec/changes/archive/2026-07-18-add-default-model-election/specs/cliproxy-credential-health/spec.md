# cliproxy-credential-health Specification (delta)

## MODIFIED Requirements

### Requirement: The launch gate probes the live credential in cliproxy mode

In `cliproxy` connection mode, `ensureProxyReady` SHALL send one minimal model request through the running proxy (bounded `max_tokens`, bounded timeout on every round-trip the probe makes) after the compose stack is up, using the proxy client key and the ELECTED default model (`default-model-election`): the election's validation walk runs inside default-model resolution, so a top-ranked candidate the credential cannot serve advances the walk instead of feeding the probe a model that is known to 404. In `direct` connection mode no probe SHALL run.

Only a definite credential rejection SHALL gate the launch — an HTTP 401, or an empty model list from a proxy that is answering (it serves that list from its own registry and answers with the full list even behind a dead credential, so an empty one means it loaded no credential at all, contradicting the presence check that just passed). On a TTY a rejection SHALL drive the existing interactive provider login inline, make the refreshed credential observable to the running proxy (restarting the proxy service or equivalent), and re-probe once — a second rejection fails the launch with an error naming both remaining causes (provider re-login did not take; proxy client key mismatch). On a non-TTY a rejection SHALL fail with an error naming the forced re-login command (`inflexa setup --provider <kind>`). Any other probe failure (non-401 served status, missing client key) SHALL log a warning with the observed status and proceed — the probe must never add a new way for launch to block, and the election SHALL NOT add one either (an all-404 election yields its top candidate and this warn-and-proceed path reports it).

Because starting a container does not make its server reachable — the engine returns when the container is started, not when the proxy has bound its port — a probe that gets no answer at all SHALL be retried within a bounded budget rather than read as a verdict or as an outage. A proxy still silent at the budget SHALL warn and proceed like any other unreadable failure. This wait SHALL apply to every probe, including the re-probe that follows a proxy restart, whose container is always cold.

#### Scenario: Healthy credential launches without interruption

- **WHEN** the TUI launches in cliproxy mode and the probe request succeeds
- **THEN** launch proceeds with no prompt and no additional output beyond normal progress

#### Scenario: An inaccessible top candidate no longer fails verification

- **GIVEN** a healthy credential whose account cannot serve the top-ranked advertised model
- **WHEN** the TUI launches and the election walks to an accessible candidate
- **THEN** the probe verifies the login against the elected model and launch proceeds with no
  warning — the pre-election "Provider login not verifiable (HTTP 404)" outcome does not occur
  for a healthy credential

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

## ADDED Requirements

### Requirement: Launch warns when an explicit model pin has gone stale

The launch gate SHALL check each distinct explicitly-pinned model's accessibility — when it
runs in cliproxy mode on an anthropic-family connection and a pin exists (`models.agents.*` or
`harness.model`) — with the unbilled `count_tokens` request (bounded like every probe
round-trip). A definite `not_found_error` SHALL produce a warning naming the pinned model, the
agent(s) resolving to it, and the repick remedy (the palette's model-switch commands or setup) —
it SHALL NOT block the launch and SHALL NOT rewrite config. Any inconclusive outcome SHALL stay
silent (only a definite verdict is worth interrupting the launch output for). Auto-resolved
sessions are outside this requirement — election already validated the default.

#### Scenario: A pin the account can no longer serve is named at launch

- **GIVEN** `models.agents.conversation` pinned to a model the upstream account no longer serves
- **WHEN** the TUI launches
- **THEN** a warning names the pinned model, the conversation agent, and how to repick — and
  launch proceeds to chat (where the real failure remains observable)

#### Scenario: A healthy pin adds no launch output

- **WHEN** every pinned model's accessibility check answers 200
- **THEN** launch output is unchanged from the pre-change flow

#### Scenario: A flaky check never interrupts launch

- **WHEN** a pinned model's accessibility check times out
- **THEN** no warning is shown and launch proceeds
