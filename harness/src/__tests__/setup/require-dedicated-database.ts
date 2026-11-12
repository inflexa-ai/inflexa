/**
 * The guard that stops `CORTEX_TEST_PG_URL` from pointing the tests at a database that a host uses.
 *
 * A test pool resolves a name that is not in its test schema in `public` (`search_path=<schema>,public`, because
 * pgvector lives there), and the DBOS rig shares the `dbos` schema of the override database. On a database of a host,
 * a test then reads and drops the tables of that host.
 *
 * The guard reads `public` and the schema that `current_schema()` gives. The base override pool sets no
 * `search_path`, thus that schema is the default schema of the role, which a host on the same URL uses. The guard
 * does not read `dbos`: a host runs `initCortexState` before it launches DBOS, thus its database holds Cortex tables
 * in the default schema before a `dbos` table exists, and a `dbos` check would refuse a test database that earlier
 * files of the run already used.
 */

import type { Pool, PoolConfig } from "pg";

const RELATION_LIMIT = 20;

const RELATION_KINDS: Record<string, string> = {
    r: "table",
    p: "partitioned table",
    v: "view",
    m: "materialized view",
    f: "foreign table",
};

export type FoundRelation = {
    schema: string;
    name: string;
    kind: string;
};

// A relation that an extension owns has a `pg_depend` row with `deptype = 'e'`. An index or a sequence of a table has
// no such row of its own, and it follows its table, thus only the relation kinds of `RELATION_KINDS` are listed.
const FIND_RELATIONS = `
    SELECT n.nspname AS schema, c.relname AS name, c.relkind AS kind
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f')
      AND n.nspname IN ('public', current_schema())
      AND NOT EXISTS (
          SELECT 1 FROM pg_depend d
          WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid AND d.deptype = 'e'
      )
    ORDER BY n.nspname, c.relname
    LIMIT ${RELATION_LIMIT + 1}`;

/**
 * Name the database for the refusal: host, port, and database, never the password. A connection string that `URL`
 * cannot read (the keyword form of libpq) could hold a password, thus it is not echoed.
 */
export function databaseLabel(options: PoolConfig): string {
    const { connectionString, host, port, database } = options;
    if (connectionString) {
        try {
            const url = new URL(connectionString);
            return `host ${url.hostname}, port ${url.port || "5432"}, database ${decodeURIComponent(url.pathname.slice(1))}`;
        } catch {
            return "the database of CORTEX_TEST_PG_URL";
        }
    }
    return `host ${host ?? "localhost"}, port ${port ?? 5432}, database ${database ?? ""}`;
}

/**
 * The refusal a developer reads. It names the database, the relations that it found, and the routes that are safe,
 * because the message is the only place where this is explained at the moment it matters.
 */
export function refusalMessage(label: string, found: readonly FoundRelation[]): string {
    const listed = found.slice(0, RELATION_LIMIT);
    const lines = listed.map((relation) => `  ${relation.schema}.${relation.name} (${RELATION_KINDS[relation.kind] ?? relation.kind})`);
    if (found.length > RELATION_LIMIT) lines.push(`  ... and more; this list omits the rest`);

    return `Refusing to run the tests against ${label}: it holds a relation that no extension owns in \`public\` or in the default schema of the role, so a host can use it.

A test can read and drop the tables of a host, because the pool of a test resolves a name that is not in its test schema in \`public\`. These relations make the database look like the database of a host:

${lines.join("\n")}

Use one of these routes:

  unset CORTEX_TEST_PG_URL; bun run test:full [paths...]
                                   starts one container, exports CORTEX_TEST_PG_URL, removes it on exit;
                                   the script reuses a CORTEX_TEST_PG_URL that is already set, thus unset it first
  bun test [paths...]              with CORTEX_TEST_PG_URL unset, starts a container of its own
  CORTEX_TEST_PG_URL=<url of a dedicated Postgres whose public schema is empty> bun test [paths...]
                                   points every file at a Postgres that only the tests use`;
}

/**
 * Throw unless the database of `pool` is free of a relation that no extension owns, in `public` and in
 * `current_schema()`. Reads only. Called by `startContainer()` in the override branch only.
 */
export async function assertDatabaseIsDedicated(pool: Pool): Promise<void> {
    const { rows } = await pool.query<FoundRelation>(FIND_RELATIONS);
    if (rows.length > 0) {
        throw new Error(refusalMessage(databaseLabel(pool.options), rows));
    }
}
