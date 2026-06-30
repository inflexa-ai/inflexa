/**
 * Shared Postgres-querier type for `state/` modules.
 *
 * Every per-entity module accepts a `Querier` as its first parameter so the
 * same operation works against the harness's connection pool or a
 * single-transaction `PoolClient`. Lifted here to keep the type declared in
 * one place instead of redeclared per file.
 */

import type { Pool, PoolClient } from "pg";

export type Querier = Pool | PoolClient;
