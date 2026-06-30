## 1. Dependencies and Setup

- [x] 1.1 Install `neverthrow` as a runtime dependency and `eslint-plugin-neverthrow` as a dev dependency
- [x] 1.2 Add `eslint-plugin-neverthrow` to `eslint.config.ts` with `neverthrow/must-use-result` at error level

## 2. Error Types

- [x] 2.1 Create `src/db/errors.ts` with the `DbError` tagged union type (connection_failed, query_failed, mutation_failed, migration_failed)

## 3. Database Connection and Migrations

- [x] 3.1 Wrap `runMigrations` in `src/db/util.ts` to return `Result<void, DbError>` using `fromThrowable`
- [x] 3.2 Wrap `db()` in `src/db/primary.ts` to return `Result<Database, DbError>` — cache the Database instance on success, do not cache on failure

## 4. Query Layer

- [x] 4.1 Wrap `getSession` in `src/db/primary_query.ts` to return `Result<Session | null, DbError>`
- [x] 4.2 Wrap `listSessions` in `src/db/primary_query.ts` to return `Result<Session[], DbError>`
- [x] 4.3 Wrap `getSessionMessages` in `src/db/primary_query.ts` to return `Result<StoredMessage[], DbError>`

## 5. Mutation Layer

- [x] 5.1 Wrap `createSession` in `src/db/primary_mutation.ts` to return `Result<Session, DbError>`
- [x] 5.2 Wrap `updateSession` in `src/db/primary_mutation.ts` to return `Result<void, DbError>`
- [x] 5.3 Wrap `createMessage` in `src/db/primary_mutation.ts` to return `Result<Message, DbError>`
- [x] 5.4 Wrap `createPart` in `src/db/primary_mutation.ts` to return `Result<TextPart, DbError>`
- [x] 5.5 Wrap `updatePart` in `src/db/primary_mutation.ts` to return `Result<void, DbError>`

## 6. Consumer Updates

- [x] 6.1 Update `chat/echo.ts` to chain Results through the chat flow, returning `Result<void, DbError>`
- [x] 6.2 Update `cli/sessions.ts` to handle `listSessions()` Result via `match`
- [x] 6.3 Update `cli/tui.tsx` to handle `getSession`/`createSession` Results at startup
- [x] 6.4 Update `tui/app.tsx` to handle Results from db queries/mutations in event handlers and `onMount`

## 7. Verification

- [x] 7.1 Run `bun run typecheck` — all types must pass
- [x] 7.2 Run `bun run lint` — no errors, including `must-use-result`
- [x] 7.3 Run `bun run dev` — app launches and basic chat flow works
