# integration-tests-external-api Delta

## ADDED Requirements

### Requirement: Golden-fixture schema tests guard every external-API schema

Each external-API zod schema MUST have a colocated, table-driven test over promoted real payloads. The fixtures live at `src/tools/lib/__fixtures__/<provider>/` as raw JSON bodies. For each schema, the test MUST assert three facts. The schema accepts the positive fixture, which carries the observed absence encoding of the provider. The mapped output of the positive fixture matches the expected values. The schema rejects the negative `*.drift.json` twin, which carries one genuine type break.

The tests run offline on every `bun test`, with no key and no network.

#### Scenario: The positive fixture parses and maps

- **WHEN** the table-driven test parses the positive fixture of a schema
- **THEN** the parse succeeds, and the mapped output equals the expected record

#### Scenario: The drift twin is rejected

- **WHEN** the test parses the `*.drift.json` twin of the same fixture
- **THEN** the parse fails, thus the schema still detects a real contract break

#### Scenario: The suite is green offline

- **WHEN** `bun test` runs on a clean checkout with no key set
- **THEN** every golden-fixture test runs and passes without a network call

### Requirement: Each fixture directory carries a manifest, and a refresh script replays it

Each fixture directory MUST carry a `manifest.json` that records, for each fixture: the request URL, the parameters, and the capture date. An entry for a non-GET capture MUST record the method, the body, and the headers, so a GraphQL POST replays. An excerpted fixture cannot match its live body byte for byte. Such an entry MUST carry `replay: false`, and the script MUST report it as skipped, not as drift.

The script `scripts/refresh-fixtures.ts` MUST replay the manifest against the live providers, pull the published oracle schemas again, and diff the results against the stored fixtures. The script MUST report drift without a write by default. It MUST rewrite fixtures only under a `--write` flag.

The replay MUST be polite: sequential requests, a minimum gap of 300 ms, and a maximum of 3 requests each second against NCBI. A manifest entry can name ignore-paths for volatile fields, such as a timestamp or a total count. The diff MUST skip an ignored path, thus only contract drift is reported.

#### Scenario: Drift is reported without writes

- **WHEN** the script runs without flags and a provider payload drifted
- **THEN** the script prints the drift for that fixture and changes no file

#### Scenario: The replay is polite

- **WHEN** the script replays a manifest with more than one entry
- **THEN** the requests run one at a time, with at least 300 ms between two requests

#### Scenario: A volatile field does not report drift

- **WHEN** a fixture names an ignore-path for a volatile field, and only that field changed
- **THEN** the script reports no drift for that fixture

#### Scenario: A write is explicit

- **WHEN** the script runs with `--write`
- **THEN** the drifted fixtures are rewritten, and the manifest capture dates are updated

## MODIFIED Requirements

### Requirement: Real-upstream integration tests live under src/providers/integration and auto-skip without a key

Real-upstream integration tests MUST reside under `src/providers/integration/`, named `<name>.integration.test.ts`. A block for a key-gated provider MUST wrap its `describe` in `describe.skipIf(!process.env.KEY)`. When the gating env var is unset, the entire block is skipped, with no test failure.

A block for a keyless provider MUST wrap its `describe` in `describe.skipIf(!process.env.CORTEX_LIVE_API_TESTS)`. Without that gate, a keyless block runs on every clean checkout, and the suite then depends on the network.

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
