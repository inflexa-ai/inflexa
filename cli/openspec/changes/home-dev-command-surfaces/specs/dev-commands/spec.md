## ADDED Requirements

### Requirement: The dev-only command surfaces live under one directory

These surfaces serve the dev channel alone, and each one MUST live under
`src/modules/harness/dev/`:

- the `chat` REPL, with the stdout printer that it builds
- the `run` launcher
- the `profile` command actions
- the status readers that only those commands call

The tree MUST then state the channel of a file. It states it beside the registration gate
at `src/cli/index.ts`, which already states it.

The dependency MUST run one way. A file under `dev/` can import product code, because a dev
surface is a consumer of the product. A product file MUST NOT import a path under `dev/`.

The gated registration block in `src/cli/index.ts` is the one sanctioned crossing. It reaches each
command action through the lazy `import()` that registration already uses. That call sits inside
`devCommandsEnabled()`, so a release build never evaluates it. Each other file outside `dev/` MUST
NOT import a path under it. That ban covers the static form and the dynamic form alike.

A lint rule MUST enforce that direction for a static import, so the boundary fails a build rather
than a review. The rule MUST exempt the files under `dev/`. It MUST NOT exempt the registration
gate, because the crossings of the gate are dynamic and the rule does not read a dynamic import.
Thus the gate keeps the guard against a static import. The rule MUST match the import string, not a
resolved path. A sibling reaches the directory as `./dev/<file>`, which a pattern anchored on the
full module path never matches.

A helper that both a product surface and a dev surface call MUST stay outside `dev/`, in
the module that owns its subject. A shared helper MUST NOT move into `dev/` because a dev
surface calls it. A dev-only helper MUST NOT stay outside `dev/` when no product file calls
it. When one file holds both kinds, that file MUST split on the channel line rather than
move whole.

This requirement is about location. It adds no gate, and it changes no behavior. The
channel gate stays at registration, per "The command surface is channel-gated at
registration".

#### Scenario: The dev surfaces sit under the dev directory

- **WHEN** a reader lists `src/modules/harness/`
- **THEN** the `chat` REPL, the `run` launcher, and the `profile` command actions are absent from that level
- **AND** `src/modules/harness/dev/` holds them

#### Scenario: Only the gated registry imports the dev directory

- **GIVEN** any file outside `src/modules/harness/dev/` other than `src/cli/index.ts`
- **WHEN** its imports are read
- **THEN** none of them resolves to a path under `src/modules/harness/dev/`

#### Scenario: The registry reaches the dev actions behind the gate

- **GIVEN** `src/cli/index.ts`
- **WHEN** its imports of `src/modules/harness/dev/` are read
- **THEN** each one is a lazy `import()` inside the `devCommandsEnabled()` block
- **AND** none is a top-level import that a release build would evaluate

#### Scenario: A helper with a product consumer stays outside

- **GIVEN** `seedProfileLedger`, which the product parity trigger `profile_trigger.ts` imports
- **WHEN** the dev surfaces are homed under `dev/`
- **THEN** `seedProfileLedger` stays outside `dev/`
- **AND** the dev `profile` command actions import it from there

#### Scenario: The lint rule refuses a product file's static import

- **GIVEN** a file under `src/` that is not in `dev/`, the registration gate included
- **WHEN** it declares a static import of a path under `src/modules/harness/dev/`
- **THEN** `bun run lint` reports a `no-restricted-imports` error naming the boundary
- **AND** the error fires for a sibling's `./dev/<file>` form and for a deep `../modules/harness/dev/<file>` form alike

#### Scenario: The lint rule leaves the sanctioned traffic alone

- **GIVEN** a file under `src/modules/harness/dev/` that imports another file in that directory
- **WHEN** `bun run lint` runs
- **THEN** it reports no error for that import
- **AND** the registration gate's three lazy imports report none either

#### Scenario: A mixed file splits on the channel line

- **GIVEN** one file that holds both a product export and a dev-only export
- **WHEN** the dev surfaces are homed under `dev/`
- **THEN** the product export stays outside `dev/`, and the dev-only export moves in
- **AND** neither part keeps a re-export shim at the old path
