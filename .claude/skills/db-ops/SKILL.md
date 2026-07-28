---
name: db-ops
description: Write database queries and mutations for the SQLite storage layer. Use when adding, modifying, or reviewing db functions in src/db/, or when the user asks how to read/write to the database.
---

# Database Operations

The storage layer is hand-written SQLite (`bun:sqlite`) under `src/db/`. Every function returns
`Result<T, DbError>` from neverthrow — callers handle both paths. Reads live in `primary_query.ts`,
writes in `primary_mutation.ts`, shared helpers in `util.ts`, the error model in `errors.ts`, and
the schema in `primary_migrations.ts`.

## Naming → return type

The function name encodes the operation, and the verb fixes the return type. Match these exactly —
they are the contract.

| Function | Operation | Returns |
|----------|-----------|---------|
| `get<Entity>(id)` | one row by primary key | `Result<Entity \| null, DbError>` — `null` = not found |
| `get<Entity>By<Key>(key)` | one row by a non-PK key (only when a second lookup axis exists) | `Result<Entity \| null, DbError>` |
| `list<Entity>()` / `list<Entity>By<Parent>(pid)` | many rows | `Result<Entity[], DbError>` — `[]` when none |
| `count<Entity>(…)` | aggregate count | `Result<number, DbError>` |
| `<entity>Exists(…)` | existence check | `Result<boolean, DbError>` |
| `create<Entity>(…)` | INSERT, **this function mints the id** | `Result<Entity, DbError>` |
| `insert<Entity>(entity)` | INSERT, **caller supplies a fully-formed entity** | `Result<Entity, DbError>` |
| `update<Entity>(…)` / `update<Entity><Field>(id, …)` | UPDATE | `Result<number, DbError>` — rows changed (`0` = no such row) |
| `touch<Entity>(id)` | heartbeat update that must NOT bump `updatedAt` | `Result<number, DbError>` |
| `delete<Entity>(id)` | hard DELETE | `Result<number, DbError>` — rows changed |

Rules the table encodes:

- **`get` returns one, `list` returns many.** A many-row read is always `list*`, even when keyed by a parent (`listAnalysisInputs`).
- **Absence is not an error.** A missing single row is `ok(null)`; a mutation that matches nothing is `ok(0)`. `DbError` is reserved for genuine failures (connection, exec, constraint, migration) — never "not found".
- **Mutations report rows changed.** `update*` / `delete*` / `touch*` return the `.changes` count from `.run()`, so a caller can detect a no-op (`n === 0`) without a follow-up read.
- **`create` vs `insert` encodes id ownership.** `create*` mints the id inline with `randomUUIDv7()`; `insert*` takes an entity whose id is already fixed by the caller (e.g. `insertAnchor` — its id is the write-once on-disk marker UUID and must be preserved, not regenerated).

## Storage model: blob vs columnar

Two table shapes are available — choose by how the row is read; don't default to one.

**JSON-blob `(id, data, + promoted columns)`** — when the row is always loaded whole by id (or an
indexed FK) and you never filter/sort/aggregate on its inner fields. Store the entity as JSON in
`data`; promote ONLY the columns you query (FKs, ordering keys) to real indexed columns. **No live
table is shaped this way** — every table in the schema is columnar — so this is the shape to reach
for when a new entity genuinely fits it, not a pattern to copy from existing code. A blob read parses
the column and hands back `null` on a miss:

```ts
export function getThing(id: string): Result<Thing | null, DbError> {
    return tryQuery("getThing", (conn) => {
        const row = conn.query("SELECT data FROM things WHERE id = ?").get(id) as { data: string } | null;
        return row ? (JSON.parse(row.data) as Thing) : null;
    });
}
```

**Columnar (one typed column per field)** — when you filter/sort/join/aggregate on fields (anchors:
search by path, order by `last_seen`). Use the trio the anchor code models: a `<Entity>Row` type
(snake_case columns, SQLite-native types), an `<entity>FromRow()` mapper, and a shared
`<ENTITY>_COLS` constant.

```ts
/** A row of the columnar `anchors` table — one typed column per field, so identity and path stay filterable in SQL. */
type AnchorRow = { id: string; created_at: number; /* … */ marker_written: number };

function anchorFromRow(r: AnchorRow): Anchor {
    return { id: r.id, createdAt: r.created_at, /* … */ markerWritten: r.marker_written === 1 };
}

const ANCHOR_COLS = "id, created_at, updated_at, cached_path, marker_written, last_seen";
```

- **Booleans** have no SQLite type — store `INTEGER` 0/1 and convert at the `FromRow` boundary (`x === 1` reading, `x ? 1 : 0` writing).
- **Timestamps** are app-stamped epoch millis (`Date.now()`), set in app code — there are no DB `updated_at` triggers. Blob rows stamp `updatedAt` inside the entity; columnar mutations set the column explicitly. Distinguish a data edit (bumps `updatedAt`) from a heartbeat (a `touch*` that deliberately leaves it alone).

## Identifiers

Mint ids inline with `randomUUIDv7()` (`import { randomUUIDv7 } from "bun"`) at the call site — never
via a helper. `create*` functions mint; `insert*` functions receive an entity whose id is already set.

```ts
/** Mints and persists a new project. A duplicate `name` trips the `UNIQUE` constraint. */
export function createProject(input: { name: Str256; description: string | null; tags: string[] }): Result<Project, DbError> {
    const now = Date.now();
    const project: Project = { id: randomUUIDv7(), createdAt: now, updatedAt: now, ...input };
    return tryMutation("createProject", (conn) => {
        conn.query("INSERT INTO projects (id, created_at, updated_at, name, description, tags) VALUES (?, ?, ?, ?, ?, ?)").run(
            project.id,
            project.createdAt,
            project.updatedAt,
            project.name,
            project.description,
            project.tags.join(","),
        );
        return project;
    });
}
```

`create`/`insert` return the entity built in app code (no read-back) — valid only because we set
every field ourselves. If a column ever gains a DB-side default or trigger, that mutation must read
the row back instead.

## Transactions

When one logical change spans multiple writes (e.g. unlinking a project's analyses before deleting
it), wrap them in `withTransaction` so they commit together or roll back together — a mid-way failure
must not leave a partial. The mutations inside run on the same connection and enlist automatically;
returning an `err` from the callback triggers the rollback.

```ts
return withTransaction("deleteProject", () =>
    tryMutation("deleteProject.unlink", (conn) => {
        conn.query("UPDATE analyses SET project_id = NULL, updated_at = ? WHERE project_id = ?").run(Date.now(), id);
    }).andThen(() =>
        tryMutation("deleteProject.delete", (conn) => {
            return conn.query("DELETE FROM projects WHERE id = ?").run(id).changes;
        }),
    ),
);
```

Emit events / invalidate caches AFTER the transaction commits (in the `.match` success branch), never
inside the callback — otherwise a rollback leaves the UI believing in a write that never landed.

## Errors

`DbError` (`errors.ts`) is a tagged union. A write that trips a SQLite constraint is classified into
`constraint_violation` carrying the constraint kind, so callers can branch (e.g. duplicate id →
friendly message) instead of treating every failure alike.

| Variant | `type` | When |
|---------|--------|------|
| Connection | `"connection_failed"` | db open, PRAGMAs |
| Query | `"query_failed"` | SELECT, JSON.parse |
| Mutation | `"mutation_failed"` | INSERT/UPDATE/DELETE that didn't trip a constraint |
| Constraint | `"constraint_violation"` | unique / foreign_key / not_null / check (from `SQLiteError.code`) |
| Migration | `"migration_failed"` | migration SQL |

Classification is automatic — `tryMutation` and `withTransaction` route a thrown `SQLiteError` through
it. Don't classify by hand; just return the typed callback result.

## Consuming Results

Always consume with `.match()` — the `neverthrow/must-use-result` ESLint rule enforces handling, and
`isErr()`/`.value` is not recognized as consumption.

```ts
findProjectByRef(ref).match(
    (project) => { /* project is Project | null */ },
    (error) => { /* error.type is "query_failed" | "constraint_violation" | … */ },
);
```

Chain with `.andThen()` (next step also returns a Result) and `.map()` (plain transform).

## Rules

- **`conn.query()`** not `.prepare()` — `query()` caches the compiled statement, `prepare()` recompiles each call.
- **`tryQuery` / `tryMutation` / `withTransaction`** from `util.ts` obtain the connection and wrap thrown errors — a query/mutation function never calls `db()` or touches `Database` directly.
- **`randomUUIDv7()`** inline for ids — never a `newId()` / `newFooId()` helper.
- **`.match()`** to consume, not `.isErr()`/`.value`.
- **SQL keywords stay UPPERCASE** (`SELECT`, `INSERT`, `WHERE`) to match the existing inline queries.
