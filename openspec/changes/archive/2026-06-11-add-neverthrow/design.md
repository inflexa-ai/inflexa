## Context

The codebase has a SQLite storage layer (`db/`) where every function can throw — `Database` constructor, `.prepare().get()`, `.run()`, `JSON.parse()`, FK violations. Callers have no type-level indication of failure. The `chat/echo.ts` module is a placeholder that will become a real LLM API client, adding another throwing boundary. Today the app is small (~15 source files), making this the ideal time to adopt explicit error handling before the surface area grows.

## Goals / Non-Goals

**Goals:**
- Make all storage-layer failures explicit in the type system via `Result<T, DbError>`
- Force every callsite to handle the error path at compile time
- Prevent unconsumed Results via the `must-use-result` ESLint rule
- Establish the pattern for future throwing boundaries (LLM APIs, network, file I/O)

**Non-Goals:**
- Wrapping fire-and-forget patterns (`bus.ts` listener dispatch, `ensureDir`) — these intentionally swallow errors
- Granular retry logic or error recovery strategies — that's a future concern
- Wrapping pure/safe code (env.ts, types.ts) that doesn't interact with external systems

## Decisions

### 1. Error type: tagged union over error classes

```typescript
type DbError =
    | { type: "connection_failed"; cause: unknown }
    | { type: "query_failed"; op: string; cause: unknown }
    | { type: "mutation_failed"; op: string; cause: unknown }
    | { type: "migration_failed"; cause: unknown };
```

**Why over classes**: Tagged unions work naturally with `match()` and discriminated union narrowing. Each variant carries an `op` field (the function name) for diagnostics. The `cause` field preserves the original thrown value for logging.

**Alternative considered**: A single `DbError` class with an `op` field. Rejected because it doesn't let callers distinguish between connection failures (fatal, app should exit) and query failures (recoverable, show error in UI).

### 2. Wrapping strategy: `fromThrowable` at the function boundary

Each db function wraps its entire body with `Result.fromThrowable()`. This catches both SQLite errors and `JSON.parse` failures in one wrapper.

```typescript
export function getSession(id: string): Result<Session | null, DbError> {
    return fromThrowable(
        () => { /* existing body */ },
        (e) => ({ type: "query_failed", op: "getSession", cause: e })
    )();
}
```

**Why not wrap individual statements**: A single function typically has one logical operation (one query + one parse). Wrapping per-statement adds noise without actionable granularity — the caller can't do anything different if the parse failed vs the query failed.

### 3. `db()` returns `Result<Database, DbError>` — callers use `andThen`

The lazy singleton `db()` changes from returning `Database` to `Result<Database, DbError>`. Query/mutation functions call `db()` internally and chain with `andThen`, so the connection error propagates automatically.

```typescript
export function getSession(id: string): Result<Session | null, DbError> {
    return db().andThen((conn) =>
        fromThrowable(
            () => { /* use conn */ },
            (e) => ({ type: "query_failed", op: "getSession", cause: e })
        )()
    );
}
```

### 4. Chat layer chains Results, UI layer consumes them

- `chat/echo.ts` uses `andThen`/`map` to chain db operations and returns `Result<void, DbError>` (or a broader `ChatError` union if needed later)
- `cli/sessions.ts` uses `match()` to print data or error messages
- `tui/app.tsx` uses `match()` to update UI state or set error signals
- `cli/tui.tsx` uses `match()` to handle startup failures

### 5. ESLint plugin configuration

Add `eslint-plugin-neverthrow` and enable the `must-use-result` rule as `error`. This catches any `Result` or `ResultAsync` that isn't consumed — similar to Rust's `#[must_use]`.

The plugin requires `@typescript-eslint/parser`, which we already have via `typescript-eslint`.

### 6. New module: `src/db/errors.ts`

A dedicated file for the `DbError` type and any shared error-construction helpers. Keeps error definitions co-located with the db layer rather than polluting `types.ts` with storage concerns.

## Risks / Trade-offs

- **Verbosity increase** → Every db function gains a wrapping layer. Mitigated by the consistent `fromThrowable` + error-factory pattern — it's mechanical, not complex.
- **Chaining depth in chat layer** → Multiple `andThen` calls can get nested. Mitigated by `safeTry` generator syntax if chains exceed 3-4 steps.
- **Runtime overhead** → `fromThrowable` adds a try-catch per call. Negligible for SQLite operations that already do I/O.
- **`db()` singleton caching with Result** → The singleton must cache the *successful* `Database` instance, not the `Result`. Re-wrapping on every call would be wasteful. The init error should not be cached — a retry after fixing the issue (e.g., disk space freed) should succeed.
