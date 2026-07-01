## Context

inf-cli stores chat sessions, messages, and parts in a single SQLite database at `~/.local/share/inf/agent.db`. The current `src/db/store.ts` handles everything in one file: connection setup, schema creation via `CREATE TABLE IF NOT EXISTS`, queries, and mutations. There are 4 consumers (`echo.ts`, `tui.tsx`, `app.tsx`, `sessions.ts`) all importing `* as store`.

The codebase uses raw `bun:sqlite` (built into the Bun runtime, no native module dependencies). The schema uses a document-store pattern: relational shell columns (`id`, `session_id`, `message_id`) with a JSON `data` TEXT column holding the full typed object.

## Goals / Non-Goals

**Goals:**
- Multi-file layout: separate connection/setup, migrations, queries, and mutations
- Production-grade PRAGMAs following Rails 8 / Litestream recommendations
- Versioned migration system that tracks applied versions and auto-runs on startup
- Structure that naturally extends to additional databases (queue, cache) by repeating the `<name>.ts` / `<name>_migrations.ts` / `<name>_query.ts` / `<name>_mutation.ts` pattern

**Non-Goals:**
- Adding a second database (queue, cache) — just prepare the pattern
- Changing the existing schema or document-store pattern
- Adding an ORM or query builder — staying with raw SQL
- Backup/replication (Litestream, snapshots)

## Decisions

### 1. File layout: `primary.ts` / `primary_migrations.ts` / `primary_query.ts` / `primary_mutation.ts` / `util.ts`

Each database gets a set of files prefixed by its name. `primary` is the first; future databases follow the same pattern (`queue.ts`, `queue_migrations.ts`, etc.).

```
src/db/
  util.ts                  — newId(), ensureDir()
  primary.ts               — connection singleton, PRAGMAs, runs migrations
  primary_migrations.ts    — migration array + runner
  primary_query.ts         — read-only: getSession, listSessions, getSessionMessages
  primary_mutation.ts      — writes: createSession, updateSession, createMessage, createPart, updatePart
```

**Why separate query/mutation?** It maps to SQLite's WAL concurrency model (concurrent readers, serialized writers). It also makes it obvious at the import site whether a call is a read or a write, which matters for reasoning about contention.

**Alternative considered:** Single `primary_store.ts` for all queries and mutations, split later when it grows. Rejected because the user prefers the discipline of the split from day one.

### 2. PRAGMAs

Applied on every connection open, in this order:

```sql
PRAGMA journal_mode = WAL;       -- concurrent reads during writes
PRAGMA synchronous = NORMAL;     -- safe under WAL, fewer fsyncs
PRAGMA busy_timeout = 5000;      -- wait 5s instead of SQLITE_BUSY
PRAGMA cache_size = -64000;      -- ~64MB page cache
PRAGMA foreign_keys = ON;        -- enforce FK constraints
```

Source: Litestream tips, OpenCode reference, Rails 8 SQLite defaults.

**Why not `synchronous = OFF`?** Only appropriate for ephemeral/disposable databases (like a queue). Primary data is precious.

### 3. Versioned migration system

A `_migrations` table in each database tracks applied versions:

```sql
CREATE TABLE IF NOT EXISTS _migrations (
  version INTEGER PRIMARY KEY,
  applied_at INTEGER NOT NULL
);
```

Migrations are defined as an ordered array in `primary_migrations.ts`:

```typescript
export const migrations: Migration[] = [
    { version: 1, up: `CREATE TABLE sessions (...)` },
    { version: 2, up: `ALTER TABLE ...` },
];
```

The runner in `primary.ts`:
1. Creates `_migrations` if it doesn't exist
2. Reads the max applied version
3. Applies all migrations with version > max, in order, inside a transaction
4. Records each applied version with a timestamp

**Why not `CREATE TABLE IF NOT EXISTS` forever?** It doesn't handle `ALTER TABLE`, `CREATE INDEX` on existing tables, or any schema evolution. Versioned migrations are the standard for shipped software.

**Why an array in TS, not SQL files on disk?** For a compiled `bun build --compile` binary, SQL files aren't on the filesystem. Inline SQL strings in a TS array are bundled automatically. No build-time embedding step needed.

### 4. Migration runner lives in `primary_migrations.ts`, connection calls it from `primary.ts`

The `Migration` type and the `runMigrations(db, migrations)` function live in `primary_migrations.ts`. The `primary.ts` connection singleton imports both the migration array and runner, calling it after PRAGMAs. This keeps migration logic reusable — a future `queue_migrations.ts` would define its own array and the same `runMigrations` function works.

Actually, `runMigrations` is database-agnostic — it should live in `util.ts` so all databases can share it. The migration *definitions* stay per-database.

### 5. Export style

Consumers currently do `import * as store from "../db/store.ts"` and call `store.createSession()`, `store.newId()`, etc. After the change:

```typescript
import { newId } from "../db/util.ts";
import { getSession, listSessions, getSessionMessages } from "../db/primary_query.ts";
import { createSession, updateSession, createMessage, upsertPart } from "../db/primary_mutation.ts";
```

Named imports from specific files. No namespace re-export — callers know exactly where each function comes from.

## Risks / Trade-offs

- **[More files for a small codebase]** Five files instead of one for ~115 lines of code. The structure pays off as the schema grows and when a second database is added, but it's overhead today. → Accepted as a deliberate design choice.
- **[Migration version conflicts]** If two branches add migrations with the same version number, they'll conflict. → Low risk for a single-developer project. If it becomes an issue, switch to timestamp-based versions.
- **[No down migrations]** The migration system is up-only. → Acceptable for a CLI tool where rollback means shipping a new version. Down migrations add complexity without clear value here.
- **[Existing databases need manual reset]** The first versioned migration creates tables without `IF NOT EXISTS`, so existing databases from the old `store.ts` will fail. → Since this is v0.0.1 with one commit, users can delete `~/.local/share/inf/agent.db` and start fresh. Document this in the change.
