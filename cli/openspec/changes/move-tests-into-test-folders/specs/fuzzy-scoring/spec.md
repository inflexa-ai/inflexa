# Spec Delta

## MODIFIED Requirements

### Requirement: Scoring contract is regression-locked by tests

The contract above SHALL be exercised by a test suite runnable via `bun test`, wired as the `test` script in `package.json`. The test runner SHALL be Bun's built-in runner, adding no new dependency.

#### Scenario: bun test runs the contract suite

- **WHEN** `bun test` is run
- **THEN** the `src/lib/test/fuzzy.test.ts` suite executes and asserts the scorer scenarios (match, rejection, empty-query, case-insensitivity, contiguity, early-hit) and the ranker scenarios (field-weight ordering, no-match drop, tie order, empty-query passthrough) above
