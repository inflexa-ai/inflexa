# test-placement Specification

## Purpose
Keeps each test of cli in a `test/` folder beside the code that it tests. Thus a
directory lists its modules, not its modules mixed with their tests. The
`@inflexa-ai/test-placement` oxlint rule enforces the placement.
## Requirements
### Requirement: Each test file lives in a test folder beside the code it tests

A test file is a file of `cli/src` whose name matches `*.test.ts`, `*.test.tsx`, or
`*.test.js`.
Each test file MUST be in the `test/` folder of the directory that holds the code
that it tests. The immediate parent directory of the test file MUST have the name
`test`. The rule binds each test class alike: a unit test, a render test
(`*.render.test.tsx`), an end-to-end test, and a test of the shared test support in
`src/test_support/`.

A file whose name does not match the test pattern has no placement obligation, and
it stays in its directory. Examples are a helper of `src/test_support/` and a
fixture file.

#### Scenario: The lint rule reports nothing

- **WHEN** `bun run lint` runs in `cli/`
- **THEN** `@inflexa-ai/test-placement` reports no file, and the lint run passes

#### Scenario: A new test joins the test folder of its directory

- **WHEN** a contributor adds a test for a module of `src/<dir>/`
- **THEN** the test file is in `src/<dir>/test/`

#### Scenario: A helper that is not a test stays

- **WHEN** a file under `src/` has no `*.test.ts`, `*.test.tsx`, or `*.test.js` name
- **THEN** the placement rule does not apply to it, and the file stays where it is

### Requirement: The lint configuration keeps the rule on

The oxlint configuration of cli MUST NOT turn `@inflexa-ai/test-placement` off. A
file that cannot move carries an inline disable with its reason. The configuration
carries no blanket `off` entry for the rule.

#### Scenario: No off entry for the rule

- **WHEN** a reader reads the oxlint configuration of cli
- **THEN** no override turns `@inflexa-ai/test-placement` off
