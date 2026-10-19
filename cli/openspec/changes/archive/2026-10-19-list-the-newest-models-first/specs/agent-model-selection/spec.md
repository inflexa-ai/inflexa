## MODIFIED Requirements

### Requirement: Palette commands switch an agent's model through a listing picker

The command palette MUST offer `Switch chat model`, `Switch sandbox model`, and `Switch utility model` under the `Provider` category. Each command MUST be enabled only when the runtime of the local server is booted. Each command MUST open a picker that lists the models of the shared connection, which the local server reads (`GET /api/v1/models`). In cliproxy mode the source is the `/models` route of the proxy. In direct mode the source is `{baseURL}/models` for both protocols. That `baseURL` MUST be the configured one that the chat path uses, never a variant. The picker MUST mark the current model of the role (`GET /api/v1/agents`).

The server MUST stop one listing after 10 s, the headers and the body together, because the route lifts the idle timeout of the connection. A listing that failed MUST give `models: null` with `reason`, one clause for a person. When the listing fails, the picker MUST degrade to free-text model entry, pre-filled with the current model of the role. It MUST show the reason under the field. The picker MUST also offer a manual-entry row when the listing succeeds. That row MUST stay offered for each filter text. Back from the manual field MUST return to the listing.

Each listed model MUST carry `releasedAt`: the release date of its source, as an ISO 8601 string, or `null`. A source gives the date as `created_at` (RFC 3339) or as `created` (Unix seconds). An absent or invalid value, the epoch, or an earlier time MUST give `null`, because a source can give the epoch for an unknown date. The server MUST give the date of the source with no correction.

The listing MUST come newest first. A model with no date MUST come after each dated model. The id, in ascending order, MUST break a tie, thus the order does not depend on the serving order. The picker MUST show the models in this order.

On the Anthropic protocol in direct mode, the listing MUST ask for 1000 models for each page, the maximum of the Anthropic List Models route. It MUST read the next page after the `last_id` of each page that reports `has_more: true`. The read MUST stop after 10 pages, or when a page gives no new `last_id`, and the listing then gives the models that it read. The listing MUST give each id one time. A failed page MUST fail the listing with the same reasons as a failed first page. The 10 s bound MUST cover all pages together.

In direct mode, the listing and the validation MUST authenticate as the chat does. A configured `auth` resolves its credential source and applies only its named scheme. Only an absent `auth` uses the static env-key resolution. A credential-source failure MUST degrade through the listing and validation paths, and it MUST NOT crash.

For the Anthropic protocol, a committed listed or free-text selection MUST pass the bounded `count_tokens` check of accessibility, which has no cost. A definite `not_found_error` MUST keep the dialog open and persist nothing. A 200, or an inconclusive timeout, network, or other-status outcome, MUST commit. An OpenAI-compatible connection MUST commit with no validation request.

The picker MUST commit through `PUT /api/v1/agents/:role`. The server runs the validation, and it refuses a definite `not_found_error` with 400 `validation_error`. Otherwise it writes the model and the effort of `models.agents.<role>` in ONE config write, at once, apart from when the runtime can apply it. With one write, a failure cannot change the model and leave the effort.

#### Scenario: Picker lists live models and marks the current one

- **WHEN** the user runs `Switch utility model` on a booted cliproxy runtime
- **THEN** the picker shows the proxy's current model ids with utility's active model marked, and choosing one writes `models.agents.utility`

#### Scenario: An unlisted id is reachable from a successful listing

- **WHEN** the picker lists models and the user filters by an id the connection does not enumerate
- **THEN** the manual-entry row remains offered, selecting it opens an empty free-text field, and escape returns to the listing

#### Scenario: Listing failure degrades to free text

- **WHEN** the direct endpoint's model listing request fails
- **THEN** the picker offers free-text entry, the entered id persists exactly as typed after the same commit-time validation, and no switch capability is lost

#### Scenario: The anthropic listing derives from the chat baseURL

- **WHEN** the connection is direct-anthropic with the `/v1`-terminated `baseURL` chat requires
- **THEN** the listing request targets `{baseURL}/models` and succeeds under the exact configuration where chat works

#### Scenario: The picker authenticates with the configured credential source

- **WHEN** the connection is direct-anthropic with a `bearer` command `auth` block and the user opens a role's picker
- **THEN** listing carries `Authorization: Bearer <minted token>` and no `x-api-key`, and commit-time validation authenticates identically

#### Scenario: An inaccessible pick is rejected in-dialog, not persisted

- **WHEN** the user commits a model whose `count_tokens` check answers `not_found_error`
- **THEN** the dialog stays open with an account-accessibility error and `models.agents` is not written

#### Scenario: A flaky validation does not block a switch

- **WHEN** the user commits a model and `count_tokens` times out
- **THEN** the selection persists through the existing inconclusive-accept rule

#### Scenario: A hung endpoint gives a reason

- **GIVEN** a model endpoint that accepts the connection and sends no answer
- **WHEN** the user opens the picker
- **THEN** the server ends the listing after 10 s, and the picker shows the free-text field with the timeout as the cause

#### Scenario: The listing gives the release date of each model

- **WHEN** the endpoint lists one model with `created_at` `2026-09-21T00:00:00Z` and one model with `created` `1760000000`
- **THEN** `GET /api/v1/models` gives each model with `releasedAt` as the ISO 8601 form of its date

#### Scenario: An epoch date counts as no date

- **WHEN** the endpoint lists a model with `created_at` `1970-01-01T00:00:00Z`, or a model with no date field
- **THEN** that model has `releasedAt: null`, and it comes after each dated model

#### Scenario: The listing comes newest first

- **WHEN** the endpoint serves an older dated model, then an undated model, then a newer dated model
- **THEN** the listing gives the newer dated model, then the older dated model, then the undated model

#### Scenario: The direct Anthropic listing reads each page

- **GIVEN** a direct connection on the Anthropic protocol whose first page reports `has_more: true` with a `last_id`
- **WHEN** the user opens a role's picker
- **THEN** the server asks for the next page after that `last_id`, and the picker lists the models of each page

#### Scenario: A gateway that ignores the cursor keeps its listing

- **GIVEN** a direct connection on the Anthropic protocol whose next page reports `has_more: true` with the same `last_id` as the page before
- **WHEN** the user opens a role's picker
- **THEN** the server stops the read, and the picker lists each model of the pages that it read one time
