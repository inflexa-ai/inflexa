## REMOVED Requirements

### Requirement: Initial schema migration

**Reason**: The `sessions`, `messages`, and `parts` tables are dropped — session identity is single-homed in the harness Postgres thread store, and the SQLite transcript tables have been frozen legacy (no writer, no reader) since the pg thread became the transcript's source of truth. The current baseline schema is governed by `data-model-storage`.
**Migration**: A versioned migration drops the three tables (see `data-model-storage`); the historical baseline keeps creating them so the forward-only history stays replayable.

### Requirement: Session queries

**Reason**: The `sessions` table is dropped; thread metadata reads go through the harness `ThreadStore` (`getThread`/`listThreads`) over the booted runtime's pool.
**Migration**: Callers re-point to the thread store post-boot; there is no SQLite fallback.

### Requirement: Session messages query

**Reason**: The `messages`/`parts` tables are dropped; the transcript's source of truth is the pg thread, loaded via the harness history read path.
**Migration**: None — the query has had no production caller since the harness transcript became authoritative.

### Requirement: Session mutations

**Reason**: The `sessions` table is dropped. Title updates go through `ThreadStore.updateTitle`; there is no eager session creation (thread rows are created lazily by the first turn).
**Migration**: `renameSession` callers re-point to `ThreadStore.updateTitle`; `createSession`/`updateSession` callers are deleted with the launcher's session resolution.

### Requirement: Message mutations

**Reason**: The `messages` table is dropped; it has had no production writer since the harness transcript became authoritative.
**Migration**: None — no callers exist.

### Requirement: Part mutations

**Reason**: The `parts` table is dropped; it has had no production writer since the harness transcript became authoritative.
**Migration**: None — no callers exist.

### Requirement: Capped recent-messages read query

**Reason**: The SQLite transcript tables are dropped; the capped transcript read lives on the harness history path (`loadPage`), which the TUI already uses.
**Migration**: None — the SQLite variant has no production caller.
