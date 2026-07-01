## 1. Shared utilities

- [x] 1.1 Create `src/db/util.ts` with `newId()` (ULID generation), `ensureDir()`, `Migration` type, and `runMigrations(db, migrations)` function

## 2. Primary database setup

- [x] 2.1 Create `src/db/primary_migrations.ts` with the migrations array containing version 1 (sessions, messages, parts tables with indexes and foreign keys)
- [x] 2.2 Create `src/db/primary.ts` with lazy singleton connection, PRAGMAs (WAL, synchronous=NORMAL, busy_timeout=5000, cache_size=-64000, foreign_keys=ON), and migration execution on first access

## 3. Queries and mutations

- [x] 3.1 Create `src/db/primary_query.ts` with `getSession()`, `listSessions()`, `getSessionMessages()`
- [x] 3.2 Create `src/db/primary_mutation.ts` with `createSession()`, `updateSession()`, `createMessage()`, `upsertPart()`

## 4. Update consumers

- [x] 4.1 Update `src/chat/echo.ts` imports to use `primary_query`, `primary_mutation`, and `util`
- [x] 4.2 Update `src/cli/tui.tsx` imports to use `primary_query`, `primary_mutation`, and `util`
- [x] 4.3 Update `src/cli/sessions.ts` imports to use `primary_query`
- [x] 4.4 Update `src/tui/app.tsx` imports to use `primary_query`, `primary_mutation`, and `util`

## 5. Cleanup and verify

- [x] 5.1 Delete `src/db/store.ts`
- [x] 5.2 Run typecheck and verify all imports resolve
- [x] 5.3 Run the app with a test database to verify session creation, message flow, and part upserts work end-to-end
