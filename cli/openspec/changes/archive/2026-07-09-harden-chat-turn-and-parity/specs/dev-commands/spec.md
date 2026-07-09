# dev-commands — Delta

## ADDED Requirements

### Requirement: A production build without a baked source commit fails at build time

`scripts/build.ts` SHALL refuse to produce a binary when the resolved build channel is `production` and
`INFLEXA_GIT_COMMIT` is unset or empty, printing the reason and exiting non-zero. The commit SHALL then
be `--define`d into the bundle so the runtime read resolves to a baked literal.

The commit is consumed by the provenance `system` actor, and provenance is never allowed to degrade to
unsigned or to a fabricated value — so a binary that cannot stamp it is a broken build. Discovering that
at build time is the operator's problem to fix; discovering it at runtime is the user's crash on their
first provenance-recording command.

The define SHALL be explicit rather than routed through the `bakedEnv` block's scanner: the scanner's
missing-variable guard applies to every channel, and a `development` build outside a git checkout must
still be allowed to fall through to resolving the commit from `git rev-parse` at runtime.

`src/lib/env.ts` SHALL keep its runtime throw for a `production` channel with no commit, documented as a
backstop reachable only by a binary built without `scripts/build.ts` — not, as previously claimed, as
dead code guaranteed unreachable by a `--define` that the scanner never emitted.

#### Scenario: A production build without a commit is refused

- **WHEN** `scripts/build.ts` runs with `INFLEXA_BUILD_CHANNEL=production` and no `INFLEXA_GIT_COMMIT`
- **THEN** it SHALL print the reason and exit non-zero
- **AND** no binary SHALL be emitted

#### Scenario: A production build bakes the commit

- **WHEN** `scripts/build.ts` runs with `INFLEXA_BUILD_CHANNEL=production` and a resolved commit
- **THEN** `process.env.INFLEXA_GIT_COMMIT` SHALL be `--define`d into the bundle
- **AND** the resulting binary SHALL stamp provenance without shelling out to `git`

#### Scenario: A development build outside a git checkout still builds

- **WHEN** `scripts/build.ts` runs with `INFLEXA_BUILD_CHANNEL=development` and no resolvable commit
- **THEN** the build SHALL succeed
- **AND** the binary SHALL resolve the commit from `git rev-parse` at runtime, as the development path already does
