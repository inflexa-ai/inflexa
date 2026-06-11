## Why

Every function in the db layer can throw (SQLite errors, JSON.parse on malformed data, FK violations), but callers have no indication of this in the type system. Errors propagate silently until they crash the TUI. Adding `neverthrow` makes failure explicit via `Result<T, E>` types — callers are forced to handle both paths at compile time.

## What Changes

- Add `neverthrow` as a runtime dependency and `eslint-plugin-neverthrow` as a dev dependency
- Define a `DbError` tagged union type for all storage-layer failures
- Wrap all query functions (`getSession`, `listSessions`, `getSessionMessages`) to return `Result<T, DbError>`
- Wrap all mutation functions (`createSession`, `updateSession`, `createMessage`, `createPart`, `updatePart`) to return `Result<T, DbError>`
- Wrap the `db()` singleton initializer to return `Result<Database, DbError>`
- Wrap `runMigrations` to return `Result<void, DbError>`
- Update `chat/echo.ts` to chain Results through the chat flow
- Update consumer sites (`cli/tui.tsx`, `tui/app.tsx`, `cli/sessions.ts`) to handle Results via `match`/`unwrapOr`
- Add `neverthrow/must-use-result` ESLint rule to enforce Result consumption
- Leave fire-and-forget patterns untouched (`bus.ts` listener dispatch, `ensureDir`)

## Capabilities

### New Capabilities
- `result-types`: Define the neverthrow integration layer — DbError type, fromThrowable wrappers, and the ESLint rule enforcing Result consumption

### Modified Capabilities
- `primary-storage`: Query and mutation functions change return types from raw values to `Result<T, DbError>`
- `sqlite-connection`: The `db()` singleton changes from returning `Database` to `Result<Database, DbError>`
- `sqlite-migrations`: `runMigrations` changes from returning `void` to `Result<void, DbError>`

## Impact

- **Dependencies**: `neverthrow` (runtime), `eslint-plugin-neverthrow` (dev)
- **All db/ consumers**: Every callsite that reads from or writes to the database must handle `Result` — this touches `chat/echo.ts`, `cli/tui.tsx`, `tui/app.tsx`, `cli/sessions.ts`
- **ESLint config**: New plugin + rule added to `eslint.config.ts`
- **Type signatures**: All public db functions change return types — **BREAKING** for any external consumers (none currently)
