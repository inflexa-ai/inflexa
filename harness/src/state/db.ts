/**
 * Shared Postgres-querier type for `state/` modules.
 *
 * Every per-entity module accepts a `Querier` as its first parameter so the
 * same operation works against the harness's connection pool or a
 * single-transaction `PoolClient`. Lifted here to keep the type declared in
 * one place instead of redeclared per file.
 *
 * The type is structural and states exactly what the state modules read: one
 * `query` over the text or config form, returning `rows` and `rowCount`. A
 * real `Pool` and `PoolClient` satisfy it, and so does a test double that
 * answers `query` alone; nothing else of `pg`'s surface is claimed here.
 */

import type { QueryConfig, QueryResultRow } from "pg";

export type Querier = {
    query<R extends QueryResultRow = Record<string, unknown>>(
        queryTextOrConfig: string | QueryConfig,
        values?: unknown[],
    ): Promise<{ rows: R[]; rowCount: number | null }>;
};
