## Why

The current database layer (`src/db/store.ts`) is a single 115-line file mixing connection setup, schema creation, queries, and mutations. It lacks versioned migrations (uses `CREATE TABLE IF NOT EXISTS`), uses minimal PRAGMAs, and has no structure for adding a second database later (e.g., a job queue). Restructuring now — while the schema is small — sets the foundation for production-grade SQLite usage inspired by Rails 8's Solid Stack approach: proper PRAGMAs, versioned migrations, and a multi-file layout that separates reads from writes and scales to multiple databases.

## What Changes

- Replace the single `store.ts` with a multi-file layout under `src/db/`:
  - `primary.ts` — connection singleton, PRAGMAs, migration runner
  - `primary_migrations.ts` — ordered migration definitions (versioned, append-only)
  - `primary_query.ts` — read-only queries
  - `primary_mutation.ts` — write operations (inserts, updates, upserts)
  - `util.ts` — shared utilities (`newId()`, `ensureDir()`)
- Add production-grade SQLite PRAGMAs: `WAL`, `synchronous = NORMAL`, `busy_timeout = 5000`, `cache_size = -64000`, `foreign_keys = ON`
- Implement a versioned migration system with a `_migrations` table tracking applied versions
- **BREAKING**: `store.ts` is removed; all imports change from `import * as store from "../db/store.ts"` to targeted imports from the new modules

## Capabilities

### New Capabilities
- `sqlite-connection`: Database connection lifecycle — opening, PRAGMAs, lazy singleton, migration execution on first access
- `sqlite-migrations`: Versioned migration system — ordered migrations array, `_migrations` tracking table, startup auto-apply
- `primary-storage`: Query and mutation functions for sessions, messages, and parts against the primary database

### Modified Capabilities

## Impact

- `src/db/store.ts` — deleted, replaced by 5 new files
- `src/chat/echo.ts` — import path changes
- `src/cli/tui.tsx` — import path changes
- `src/cli/sessions.ts` — import path changes
- `src/tui/app.tsx` — import path changes
- No new dependencies; raw `bun:sqlite` only
