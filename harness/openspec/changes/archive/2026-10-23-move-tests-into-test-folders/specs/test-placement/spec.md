# Spec Delta

## Purpose

Keeps each test of the harness in a `test/` folder beside the code it tests, so
a directory lists its modules and not its modules interleaved with their tests.
The `@inflexa-ai/test-placement` oxlint rule enforces the placement.

## ADDED Requirements

### Requirement: Each test file lives in a test folder beside the code it tests

Each file of `harness/src` whose name matches `*.test.ts` or `*.test.tsx` MUST
reside in a `test/` folder of the directory that holds the code it tests: the
immediate parent directory of the test file MUST be named `test`. The rule binds
each test class alike: a unit test beside its module, a real-upstream
integration test of `src/providers/integration/`, a golden-fixture test, and a
test inside a `__tests__` directory. A file whose name does not match the test
pattern — for example a setup helper under `src/__tests__/setup/` — has no
placement obligation and stays in its directory.

#### Scenario: The lint rule reports nothing

- **WHEN** `bun run lint` runs in `harness/`
- **THEN** `@inflexa-ai/test-placement` reports no file, and the lint run passes

#### Scenario: A new test joins the test folder of its directory

- **WHEN** a contributor adds a test for a module of `src/<dir>/`
- **THEN** the test file lives inside `src/<dir>/test/`

#### Scenario: A helper that is not a test stays

- **WHEN** a file under `src/` carries no `*.test.ts` or `*.test.tsx` name
- **THEN** the placement rule does not apply to it, and the file stays where it is

### Requirement: The lint configuration keeps the rule on

The oxlint configuration of the harness MUST NOT turn
`@inflexa-ai/test-placement` off. A file that genuinely cannot move carries an
inline disable with its reason; the configuration carries no blanket `off`
entry.

#### Scenario: No off entry for the rule

- **WHEN** the oxlint configuration of the harness is read
- **THEN** no override turns `@inflexa-ai/test-placement` off
