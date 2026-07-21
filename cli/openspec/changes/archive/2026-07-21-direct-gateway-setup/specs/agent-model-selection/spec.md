## MODIFIED Requirements

### Requirement: Palette commands switch an agent's model through a listing picker

The command palette SHALL offer `Switch chat model` and `Switch sandbox model` commands under a
dedicated `Provider` palette category, enabled only when the harness runtime is booted (the
existing boot-gated command pattern). Each SHALL
open a picker listing the connection's models dynamically — the proxy's `/models` in cliproxy
mode; in direct mode, `{baseURL}/models` for BOTH protocols, derived from the SAME configured
`baseURL` the chat path uses (the `/v1`-terminated protocol root — see `model-connection`), never
a re-derived variant of it —
marking each agent's current model. When listing fails (endpoint down, unsupported), the picker
SHALL degrade to free-text model entry rather than blocking the switch.

In direct mode the listing and validation requests SHALL authenticate the way the chat path does:
when the connection carries an `auth` block, the credential is resolved through the configured
credential source and sent under its configured scheme (`bearer` sends `Authorization: Bearer` and
no `x-api-key`; `x-api-key` the reverse) — never the static environment key, and never a scheme
the configuration does not name. Only when no `auth` block exists does the static env-key
resolution supply the credential with today's per-protocol headers. A credential-source resolution
failure is an EXPECTED listing/validation outcome and follows the existing degradation paths
(listing → free-text entry; validation → inconclusive-accept), never a crash.

A committed selection — listed or free-text — SHALL be accessibility-validated before persisting
when the connection protocol is `anthropic` (the unbilled `count_tokens` check, bounded, with
the dialog in its busy state while checking): a definite `not_found_error` SHALL keep the dialog
open with an inline error naming the model and that this account cannot serve it, persisting
nothing; a 200 or an inconclusive outcome (timeout, other status, network failure) SHALL commit.
On an `openai-compatible` connection no validation request exists and the selection commits as
before. A committed selection SHALL persist to `models.agents.<agent>` in `config.json`
immediately, independent of when the runtime applies it.

#### Scenario: Picker lists live models and marks the current one

- **WHEN** the user runs `Switch sandbox model` on a booted cliproxy runtime
- **THEN** the picker shows the proxy's current `/models` ids with the sandbox agent's active
  model marked, and choosing one writes `models.agents.sandbox`

#### Scenario: Listing failure degrades to free text

- **WHEN** the direct endpoint's model listing request fails
- **THEN** the picker offers free-text entry, the entered id persists exactly as typed after the
  same commit-time validation, and no switch capability is lost

#### Scenario: The anthropic listing derives from the chat baseURL

- **WHEN** the connection is direct-anthropic with the `/v1`-terminated `baseURL` chat requires
- **THEN** the listing request targets `{baseURL}/models` and succeeds — the picker auto-lists on
  the exact configuration under which chat works

#### Scenario: The picker authenticates with the configured credential source

- **WHEN** the connection is direct-anthropic with a `bearer` command `auth` block and the user
  opens the picker
- **THEN** the listing request carries `Authorization: Bearer <minted token>` and no `x-api-key`
  header, and a commit-time `count_tokens` validation for the selection authenticates identically

#### Scenario: An inaccessible pick is rejected in-dialog, not persisted

- **WHEN** the user commits a model whose `count_tokens` check answers `not_found_error`
- **THEN** the dialog stays open showing an error naming the model and the account-accessibility
  cause, and `models.agents` is not written

#### Scenario: A flaky validation does not block a switch

- **WHEN** the user commits a model and the `count_tokens` check times out
- **THEN** the selection persists (inconclusive-accept) exactly as an unvalidated commit would
