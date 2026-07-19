## MODIFIED Requirements

### Requirement: The launch gate probes the live credential in cliproxy mode

In `cliproxy` connection mode, `ensureProxyReady` SHALL send one minimal model request through the running proxy (bounded `max_tokens`, bounded timeout on every round-trip the probe makes) after the compose stack is up, using the proxy client key and the ELECTED default model (`default-model-election`): the election's validation walk runs inside default-model resolution, so a top-ranked candidate the credential cannot serve advances the walk instead of feeding the probe a model that is known to 404. In `direct` connection mode no probe SHALL run.

Only a definite provider-side rejection SHALL gate the launch: an HTTP 401 answered by the completion probe, which the proxy forwards from the provider. An empty model list SHALL NOT be a rejection verdict, and a 401 from the model-listing route SHALL NOT be one either — the proxy gates that route with its client-API-key middleware alone, so it proves a client-key mismatch between the config on disk and the running container, which a provider re-login cannot fix; the launch SHALL warn naming that condition and `inflexa setup` as the remedy, and proceed.

Because starting a container does not make its server *readable* — the engine returns when the container is started, not when the proxy has bound its port, and the proxy's listener answers before its asynchronous auth-file registration completes — a probe that gets no answer at all AND a probe that reads an empty model list from an answering proxy SHALL both be retried within one bounded budget rather than read as a verdict. This wait SHALL apply to every probe, including the re-probe that follows a proxy restart, whose container is always cold and whose registration window the restart itself just opened. A model list still empty when the budget expires is ambiguous, not dead: the proxy may have loaded nothing from the credential file, or the provider side may have temporarily suspended the credential's models (the proxy excludes suspended models from the list for a bounded window while the on-disk credential stays valid). The launch SHALL surface a notice naming both causes and the `inflexa setup --provider <name>` remedy, and proceed without driving any login.

A served 503 whose body carries the proxy's `auth_unavailable` cooldown marker SHALL be classified as a cooldown, not an unverifiable login: the launch SHALL report that the provider credential is cooling down after upstream errors and recovers on its own, and proceed. A 503 whose body carries no recognized marker SHALL fall through to the generic warn-and-proceed path.

On a TTY a definite rejection SHALL OFFER the interactive provider login as a confirmable prompt — it SHALL NOT enter the OAuth flow without consent. Declining SHALL warn and proceed (the chat surface's auth mapping is the backstop). Accepting SHALL run the existing login, make the refreshed credential observable to the running proxy (restarting the proxy service or equivalent), and re-probe once under the same readiness wait — a second definite rejection fails the launch with an error naming both remaining causes (provider re-login did not take; proxy client key mismatch). On a non-TTY a definite rejection SHALL fail with an error naming the forced re-login command (`inflexa setup --provider <kind>`). Any other probe failure (non-401 served status, missing client key) SHALL log a warning with the observed status and proceed — the probe must never add a new way for launch to block, and the election SHALL NOT add one either (an all-404 election yields its top candidate and this warn-and-proceed path reports it).

#### Scenario: Healthy credential launches without interruption

- **WHEN** the TUI launches in cliproxy mode and the probe request succeeds
- **THEN** launch proceeds with no prompt and no additional output beyond normal progress

#### Scenario: An inaccessible top candidate no longer fails verification

- **GIVEN** a healthy credential whose account cannot serve the top-ranked advertised model
- **WHEN** the TUI launches and the election walks to an accessible candidate
- **THEN** the probe verifies the login against the elected model and launch proceeds with no
  warning — the pre-election "Provider login not verifiable (HTTP 404)" outcome does not occur
  for a healthy credential

#### Scenario: Dead credential is caught at launch and login is offered, not imposed

- **GIVEN** a credential whose refresh has died (every provider call answers 401)
- **WHEN** the TUI launches on a TTY and the user accepts the offered re-login
- **THEN** the interactive provider login runs before the TUI takes the terminal, the proxy observes the fresh credential, the re-probe passes under the readiness wait, and launch proceeds

#### Scenario: Declining the offered re-login proceeds to launch

- **GIVEN** a completion probe that answered 401
- **WHEN** the user declines the re-login prompt
- **THEN** launch warns that provider calls will fail until a re-login and proceeds to the TUI, where the chat auth banner names the remedy on first failure

#### Scenario: The cold-boot registration window is waited out, not misread

- **GIVEN** a proxy container that is answering but whose auth-file registration has not landed yet (its model list is still empty)
- **WHEN** the probe reads the empty list within the readiness budget
- **THEN** it retries until the list populates and reads the verdict from the populated proxy, and no login is offered for the boot window

#### Scenario: The post-re-login re-probe does not race the bounce it caused

- **GIVEN** a re-login that restarted the proxy
- **WHEN** the confirmation re-probe runs against the freshly bounced container
- **THEN** the same readiness wait applies before any verdict, and a launch is never failed on the restart's own registration window

#### Scenario: A list still empty at the deadline warns with both causes and proceeds

- **GIVEN** a proxy that answers with an empty model list for the whole readiness budget (an unloadable credential file, or a provider-side suspension window)
- **WHEN** the budget expires
- **THEN** launch surfaces a notice naming both possible causes and `inflexa setup --provider <name>` as the remedy, drives no login, and proceeds

#### Scenario: A cooldown answers with its own notice, never a login prompt

- **WHEN** the probe receives a served 503 whose body carries the proxy's `auth_unavailable` marker
- **THEN** launch reports the credential is cooling down after upstream errors and recovers on its own, and proceeds without any login prompt

#### Scenario: A model-listing 401 names the client-key mismatch, not the provider login

- **WHEN** the model-listing route answers 401 while resolving the probe's inputs
- **THEN** launch warns that the client key on disk does not match the running proxy, names `inflexa setup` as the remedy, drives no provider login, and proceeds

#### Scenario: Non-interactive launch fails actionably on a dead credential

- **WHEN** the probe receives a 401 and stdin is not a TTY
- **THEN** launch fails with an error naming `inflexa setup --provider <kind>` as the remedy

#### Scenario: Direct mode is never probed

- **WHEN** the TUI launches in `direct` connection mode
- **THEN** no probe request is sent (the user's own endpoint and key are not spent on validation)

#### Scenario: A provider outage does not block launch

- **WHEN** the probe fails with a served 5xx carrying no recognized cooldown marker
- **THEN** launch logs a warning carrying the observed failure and proceeds

#### Scenario: A cold proxy is waited for, not misread

- **GIVEN** a proxy container that has started but not yet bound its port
- **WHEN** the probe finds nothing answering
- **THEN** it retries within its budget and reads the verdict once the proxy answers, rather than reporting an unverifiable login

#### Scenario: A proxy that never answers does not block launch

- **WHEN** nothing answers for the whole retry budget
- **THEN** launch logs a warning carrying the observed failure and proceeds
