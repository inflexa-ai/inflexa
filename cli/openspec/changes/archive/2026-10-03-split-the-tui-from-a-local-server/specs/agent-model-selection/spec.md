## MODIFIED Requirements

### Requirement: Palette commands switch an agent's model through a listing picker

The command palette SHALL offer `Switch chat model`, `Switch sandbox model`, and
`Switch utility model` commands under the dedicated `Provider` palette category,
enabled only when the runtime of the local server is booted. Each SHALL open a
picker listing the shared connection's models dynamically, which the local server
reads (`GET /api/v1/models`) — the proxy's `/models` in cliproxy mode; in direct
mode, `{baseURL}/models` for BOTH protocols, derived from the SAME configured
`baseURL` the chat path uses, never a re-derived variant — marking the selected
role's current model (`GET /api/v1/agents`).

When listing fails, the picker SHALL degrade to free-text model entry, pre-filled
with the role's current model, rather than blocking the switch. The picker SHALL
also offer a manual-entry row when listing succeeds. That row SHALL remain
offered whatever the user typed into the filter. Backing out of the manual field
SHALL return to the listing.

In direct mode, listing and validation SHALL authenticate exactly as chat does:
configured `auth` resolves its credential source and applies only its named
scheme; only absent `auth` uses static env-key resolution. Credential-source
failure SHALL degrade through the existing listing/validation paths rather than
crash.

For Anthropic protocol, a committed listed or free-text selection SHALL be
accessibility-validated with the bounded unbilled `count_tokens` check. A
definite `not_found_error` SHALL keep the dialog open and persist nothing; a 200
or inconclusive timeout/network/other-status outcome SHALL commit. OpenAI-
compatible connections SHALL commit without that validation request. The picker
SHALL commit through `PUT /api/v1/agents/:role`: the server runs the validation,
refuses a definite `not_found_error` with 400 `validation_error`, and otherwise
writes the model and the effort of `models.agents.<role>` in ONE config write,
immediately, independent of when the runtime can apply it. One write means that
a failure can never leave the model changed and the effort not.

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

### Requirement: The TUI surfaces the connection and the active and pending agent models

The TUI SHALL render the shared connection identity, and the active model for
conversation, sandbox, and utility, from the local server: the connection from
the boot state (`GET /api/v1/server`, at the ready edge), and the role models
with each pending selection from the agent list (`GET /api/v1/agents`). The
server has no notification stream, thus the TUI SHALL read the agent list again
on its read edges: the ready edge of the boot, the edge where its chat stops
being busy, and after its own save. It SHALL surface any pending role selection
until a read shows that it applied.

#### Scenario: Status shows the connection and all role models

- **WHEN** the runtime is ready with three distinct resolved model ids
- **THEN** the TUI shows provider, mode, and the active conversation, sandbox, and utility models without requiring the user to inspect config

#### Scenario: Pending switch is visible, not silent

- **WHEN** a utility switch is scheduled behind in-flight work
- **THEN** the TUI shows utility's pending selection, and clears it at the first read edge after the switch applied
