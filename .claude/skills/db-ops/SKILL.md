---
name: db-ops
description: Write database queries and mutations for the SQLite storage layer. Use when adding, modifying, or reviewing db functions in src/db/, or when the user asks how to read/write to the database.
---

# Database Operations

All db functions return `Result<T, DbError>` from neverthrow. Callers must handle both paths.

## Query (read)

File: `src/db/primary_query.ts`

`tryQuery` obtains the db connection internally — just pass the op name and a callback that receives `conn`.

```ts
import { type Result } from "neverthrow";
import type { DbError } from "./errors.ts";
import { tryQuery } from "./util.ts";

export function getWidget(id: string): Result<Widget | null, DbError> {
    return tryQuery("getWidget", (conn) => {
        const row = conn.query("SELECT data FROM widgets WHERE id = ?").get(id) as { data: string } | null;
        return row ? (JSON.parse(row.data) as Widget) : null;
    });
}
```

## Mutation (write)

File: `src/db/primary_mutation.ts`

`tryMutation` works the same way — obtains the connection, wraps errors.

```ts
import type { Result } from "neverthrow";
import { newId, tryMutation } from "./util.ts";
import type { DbError } from "./errors.ts";

export function createWidget(name: string): Result<Widget, DbError> {
    const widget: Widget = { id: newId(), name, createdAt: Date.now() };
    return tryMutation("createWidget", (conn) => {
        conn.query("INSERT INTO widgets (id, data) VALUES (?, ?)").run(widget.id, JSON.stringify(widget));
        return widget;
    });
}
```

## Consuming Results

Always use `.match()` to consume a Result. The `neverthrow/must-use-result` ESLint rule enforces this.

```ts
getWidget(id).match(
    (widget) => { /* success path */ },
    (error) => { /* error.type is "query_failed" | "connection_failed" | ... */ },
);
```

To chain multiple operations, use `.andThen()` and `.map()`:

```ts
createWidget("foo")
    .andThen((widget) => createWidgetTag(widget.id, "new"))
    .match(
        (tag) => { /* both succeeded */ },
        (error) => { /* first failure in the chain */ },
    );
```

## Rules

- **`conn.query()`** not `.prepare()` — `query()` caches the compiled prepared statement, `prepare()` recompiles every call
- **`tryQuery`/`tryMutation`** from `src/db/util.ts` — they call `db()` internally and wrap thrown errors
- **`.match()`** not `.isErr()`/`.value` — the ESLint rule doesn't recognize `isErr` as consumption, and `match` is safer (forces handling both branches)
- **`newId()`** from `src/db/util.ts` for ULID primary keys
- **`JSON.stringify`/`JSON.parse`** for the `data` column — all entities are stored as JSON blobs

## Error types

Defined in `src/db/errors.ts`:

| Variant | `type` field | `op` field | When |
|---------|-------------|-----------|------|
| Connection | `"connection_failed"` | — | db open, PRAGMAs |
| Query | `"query_failed"` | function name | SELECT, JSON.parse |
| Mutation | `"mutation_failed"` | function name | INSERT, UPDATE, DELETE |
| Migration | `"migration_failed"` | — | migration SQL |