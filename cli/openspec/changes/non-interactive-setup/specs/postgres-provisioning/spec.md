# postgres-provisioning Specification (delta)

## MODIFIED Requirements

### Requirement: Setup prompts for Postgres credentials and port

`inflexa setup` SHALL interactively prompt the user for Postgres username (default `inflexa`), password (default `inflexa`), and port (default: the channel-aware `env.postgresPort`) using `@clack/prompts` with `defaultValue` and `placeholder` so pressing Enter accepts the default. Only explicit choices SHALL be persisted to `config.json` under the `postgres` key. Because `config.json` is shared by both build channels, a port equal to EITHER channel's sibling default — production 8432 or dev 8434, the *reserved* channel defaults — SHALL NOT be persisted, from either channel: freezing one channel's default there would override the other channel's default and re-create the very stack collision environment-aware defaults remove. A genuinely customized value (any non-reserved port, or a non-default host/user/password), by contrast, SHALL be persisted and therefore applies to BOTH channels — deliberate, per the per-field override contract; a user who customizes the port on a dual-build machine owns that cross-channel consequence. The persisted block SHALL be rebuilt from the prompted values (never merged over the previous block). Symmetrically, `resolvePostgresConfig` SHALL ignore a persisted port equal to a reserved channel default and fall back to THIS channel's sibling default, so a pin an earlier build froze self-heals on the first resolve from EITHER channel — not only when a setup re-run happens to land on the channel whose default the pin matches. The prompted values SHALL be used in the generated compose file for this run regardless of what is persisted.

Every Postgres field SHALL be answerable (flags `--postgres-user`, `--postgres-password`, `--postgres-port`, `--postgres-database`, `--postgres-host`; file `postgres.{user,password,port,database,host}`): an answered field skips its prompt and is treated exactly as a typed value — the persist-only-explicit contract is unchanged, so an answer equal to its default persists nothing and the run still converges. Under batch resolution (`--yes` or non-TTY), unanswered fields SHALL resolve silently to the current resolution without persisting. An answered port equal to a RESERVED channel default SHALL be rejected during batch upfront validation — the interactive warn-and-use-once behavior would silently not persist the value, which automation cannot see; interactively that behavior is unchanged.

#### Scenario: Interactive terminal prompts for credentials

- **WHEN** `inflexa setup` runs on a TTY and reaches the Postgres step
- **THEN** the CLI prompts for username, password, and port showing the current/default value as placeholder
- **AND** pressing Enter accepts the default without typing

#### Scenario: Accepted defaults persist nothing

- **WHEN** the user accepts every prompted default
- **THEN** no `postgres` field is written to `config.json`, and each channel keeps resolving its own defaults

#### Scenario: A custom value is persisted and an accepted default is not

- **WHEN** the user enters a custom password but accepts the default port
- **THEN** `config.json` carries `postgres.password` and no `postgres.port`

#### Scenario: A frozen default is healed on re-accept

- **WHEN** `config.json` carries a `postgres.port` equal to a reserved channel default (frozen by an earlier setup) and the user re-runs setup accepting the prompted defaults
- **THEN** the persisted `postgres.port` is removed, and each channel resolves its own default port again

#### Scenario: A frozen default self-heals at resolve time from either channel

- **WHEN** `config.json` carries a `postgres.port` equal to a reserved channel default (e.g. the production 8432 frozen by an older build) and the CLI resolves the Postgres config on ANY channel — including the dev channel, whose default the pin does not equal — without a setup re-run
- **THEN** the reserved pin is ignored and the port resolves to that channel's own sibling default, so a dev developer is never dragged onto the production port and the collision cannot silently persist

#### Scenario: An answered field skips its prompt

- **WHEN** `inflexa setup --postgres-password s3cret` runs on a TTY without `--yes`
- **THEN** the password prompt is skipped (the answer is the value) and the username and port prompts still run

#### Scenario: Batch unanswered fields resolve silently

- **WHEN** `inflexa setup --yes` runs with no Postgres answers
- **THEN** the current resolution is used without prompting and nothing is persisted

#### Scenario: A reserved-port answer fails batch validation

- **WHEN** `inflexa setup --yes --postgres-port 8432` runs
- **THEN** setup fails during upfront validation naming the reserved channel defaults, before any container work

#### Scenario: Prompted values are used in compose file

- **WHEN** the user enters custom credentials during setup
- **THEN** the generated compose file uses those credentials as the `POSTGRES_USER`, `POSTGRES_PASSWORD`, and published port
