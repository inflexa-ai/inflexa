# Spec Delta

## MODIFIED Requirements

### Requirement: Real-upstream integration tests live under src/providers/integration and auto-skip without a key

Real-upstream integration tests MUST reside under `src/providers/integration/test/`,
named `<name>.integration.test.ts`. A block for a key-gated provider MUST wrap
its `describe` in `describe.skipIf(!process.env.KEY)`. When the gating env var
is unset, the entire block is skipped, with no test failure.

A block for a keyless provider MUST wrap its `describe` in
`describe.skipIf(!process.env.CORTEX_LIVE_API_TESTS)`. Without that gate, a
keyless block runs on every clean checkout, and the suite then depends on the
network.

#### Scenario: The block is skipped when its key is absent

- **WHEN** `bun test` runs and the gating env var (for example `ANTHROPIC_API_KEY`) is unset
- **THEN** the integration `describe` block is skipped and no test in it fails

#### Scenario: The block runs when its key is present

- **WHEN** the gating env var is set
- **THEN** the integration test executes against the real endpoint and asserts the live-only behavior (for example a cache-creation on the first call followed by a cache-read on a repeated identical request)

#### Scenario: A keyless provider block waits for the opt-in gate

- **WHEN** `bun test` runs and `CORTEX_LIVE_API_TESTS` is unset
- **THEN** each keyless-provider integration block is skipped, and the suite makes no network call

#### Scenario: The opt-in gate runs the keyless blocks

- **WHEN** `CORTEX_LIVE_API_TESTS` is set
- **THEN** the keyless-provider blocks run against the live endpoints and assert that each schema accepts the live payload
