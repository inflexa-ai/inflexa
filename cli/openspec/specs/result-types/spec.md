# result-types Specification

## Purpose
Defines the neverthrow integration layer — the DbError type, error-wrapping helpers, and the `must-use-result` rule of the type check command, which makes sure that each Result is consumed.

## Requirements
### Requirement: DbError tagged union type
The system SHALL define a `DbError` discriminated union type in `src/db/errors.ts` with the following variants:
- `{ type: "connection_failed"; cause: unknown }` — database open/PRAGMA failures
- `{ type: "query_failed"; op: string; cause: unknown }` — SELECT/read failures
- `{ type: "mutation_failed"; op: string; cause: unknown }` — INSERT/UPDATE/DELETE failures
- `{ type: "migration_failed"; cause: unknown }` — migration execution failures

The `op` field SHALL contain the name of the function that failed (e.g., `"getSession"`, `"createPart"`).

#### Scenario: Type narrowing on DbError
- **WHEN** a caller receives a `DbError` and switches on `error.type`
- **THEN** TypeScript narrows to the correct variant, providing access to `op` on query/mutation errors

### Requirement: neverthrow dependency
The system SHALL include `neverthrow` as a runtime dependency in `package.json`.

#### Scenario: neverthrow is importable
- **WHEN** source files import from `neverthrow`
- **THEN** the imports resolve successfully (`ok`, `err`, `Result`, `fromThrowable`, etc.)

### Requirement: must-use-result rule of the type check command

The system SHALL enable the `must-use-result` rule of the `inflexa-typecheck` command (`@inflexa-ai/typecheck`, configured in `typecheck.config.ts`) at `error` level for the files under `src/`. The rule SHALL be off for the test globs, with a comment in the configuration that names #810 as the issue that turns it back on. The configuration SHALL name in the rule's `consumers` option each function that takes a `Result` and handles it itself (for example `fromCatalogStart` and `readImageSbom`), each with its reason in the configuration. A `Result` that the rule counts as handled is not a report. The rule's own documentation lists the handled forms (for example a `.match()` call, an `isErr()` check, a read of `.value`, a return), and a `Result` passed to a function named in `consumers` counts as handled.

#### Scenario: Unconsumed Result triggers lint error

- **WHEN** a function in `src/` returns a `Result` and the caller discards it without a use the rule counts as handled
- **THEN** `bun run typecheck` reports an error on that line

#### Scenario: Consumed Result passes lint

- **WHEN** a function in `src/` returns a `Result` and the caller consumes it in a use the rule counts as handled, including a call of a function named in `consumers`
- **THEN** `bun run typecheck` reports no error for it

#### Scenario: The rule is off in the test globs

- **WHEN** `bun run typecheck` runs over a file that matches the test globs
- **THEN** `must-use-result` reports nothing in that file, whatever the file does with a `Result`
