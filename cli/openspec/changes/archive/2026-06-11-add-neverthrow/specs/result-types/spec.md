## ADDED Requirements

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

### Requirement: ESLint must-use-result rule
The system SHALL include `eslint-plugin-neverthrow` as a dev dependency and enable the `neverthrow/must-use-result` rule at `error` level in `eslint.config.ts`.

#### Scenario: Unconsumed Result triggers lint error
- **WHEN** a function returns a `Result` and the caller discards it without calling `.match()`, `.unwrapOr()`, `.andThen()`, or `._unsafeUnwrap()`
- **THEN** ESLint reports an error on that line

#### Scenario: Consumed Result passes lint
- **WHEN** a function returns a `Result` and the caller consumes it via `.match()`, `.unwrapOr()`, or chains it with `.andThen()`/`.map()`
- **THEN** ESLint reports no error
