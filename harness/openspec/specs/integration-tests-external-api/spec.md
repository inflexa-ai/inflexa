# integration-tests-external-api Specification

## Purpose

External-API tools — the bio-lookup and research clients (ChEMBL, PubChem,
DrugBank, DisGeNET, GWAS Catalog, Open Targets, the preclinical and
translational-medicine families, the literature/misc research clients) — are
verified in two deliberately separated tiers, split by what each tier touches.

The first tier is fast, deterministic **unit tests that stub `globalThis.fetch`**
and never reach the network. They are colocated with the tool
(`src/tools/bio/<provider>.test.ts`, `src/tools/research/<name>.test.ts`), run on
every `bun test`, and assert the tool's behavioral contract: a found query yields
a populated data variant; a not-found upstream yields an *empty* data variant (a
data outcome, never an `is_error`); and an upstream 5xx makes `execute` throw so
the agent loop wraps it as `tool_result { is_error: true }` (see the
harness-agent-loop spec). Each test saves the real `fetch` and restores it in
`afterEach`, so stubbing one tool never leaks into another.

The second tier is a small number of **real-upstream integration tests** under
`src/providers/integration/`, named `<name>.integration.test.ts`, that exercise
behavior only a live endpoint can confirm — today, Anthropic prompt-caching
over a billing gateway (`anthropic-caching.integration.test.ts`). Each wraps its
`describe` block in `describe.skipIf(!process.env.KEY)` so the whole block
auto-skips when its key (e.g. `ANTHROPIC_API_KEY`) is absent. This keeps the
suite green on a clean checkout while still running for anyone who supplies a
key.

There is no separate task runner, no justfile, and no `just test-integration`
target. Everything runs under `bun test`; integration coverage is selected by
env-var presence at runtime, not by an isolated command. Keeping both tiers in
the one default command means a contributor cannot forget to run them, and the
skip-when-no-key gate is what makes that safe.

## Requirements

### Requirement: External-API tools have stubbed-fetch unit tests

Each external-API tool SHALL have a colocated unit test that replaces
`globalThis.fetch` with a stub — saved before and restored after each test — and
asserts the tool's behavioral contract with no network access. Assertions SHALL
target the returned data variant's structure and entity presence, not exact
counts, ordering, or volatile upstream values.

#### Scenario: A found query returns a populated data variant

- **GIVEN** a stubbed `fetch` returning a canonical successful payload for a well-known entity
- **WHEN** the tool's `execute` runs
- **THEN** it resolves to `ok(...)` whose primary result array is non-empty and whose objects carry the fields defined by the tool's output schema

#### Scenario: A not-found upstream returns an empty data variant, not an error

- **GIVEN** a stubbed `fetch` returning HTTP 404
- **WHEN** the tool's `execute` runs
- **THEN** it resolves to a data variant with an empty result array, and the result is NOT marked `is_error`

#### Scenario: An upstream 5xx makes execute throw

- **GIVEN** a stubbed `fetch` returning HTTP 500
- **WHEN** the tool's `execute` runs
- **THEN** the call rejects, so the agent loop wraps it as a `tool_result { is_error: true }` rather than the test seeing a data variant

### Requirement: Key-gated tools are factory closures tested with and without a key

Tools that require an API key SHALL be constructed as factory closures over the
key (e.g. `createSearchDrugbankTool({ apiKey })`). Their unit tests SHALL inject
a fake key for the stubbed-fetch happy path and SHALL also construct a no-key
instance to assert the absent-key contract.

#### Scenario: An absent key surfaces an actionable error

- **GIVEN** a tool built with an empty `apiKey`
- **WHEN** its `execute` is called
- **THEN** it throws an error naming the missing env var (e.g. `DRUGBANK_API_KEY`) instead of returning an empty or partial result

### Requirement: Real-upstream integration tests live under src/providers/integration and auto-skip without a key

Real-upstream integration tests SHALL reside under `src/providers/integration/`,
named `<name>.integration.test.ts`, and SHALL wrap their `describe` block in
`describe.skipIf(!process.env.KEY)` so the entire block is skipped — with no test
failure — when the required env var is unset.

#### Scenario: The block is skipped when its key is absent

- **WHEN** `bun test` runs and the gating env var (e.g. `ANTHROPIC_API_KEY`) is unset
- **THEN** the integration `describe` block is skipped and no test in it fails

#### Scenario: The block runs when its key is present

- **WHEN** the gating env var is set
- **THEN** the integration test executes against the real endpoint and asserts the live-only behavior (e.g. a cache-creation on the first call followed by a cache-read on a repeated identical request)

### Requirement: A single test command with no separate integration runner

The suite SHALL run entirely under `bun test`; there SHALL be no justfile, task
runner, or dedicated integration target. Whether an integration block runs SHALL
be selected by env-var presence at runtime, not by a distinct command.

#### Scenario: One command runs both tiers

- **WHEN** a developer runs `bun test`
- **THEN** the stubbed-fetch unit tests execute, every `*.integration.test.ts` block whose key is unset is auto-skipped, and no separate `just test-integration` (or equivalent) invocation is required
