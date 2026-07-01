import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { Pool } from "pg";

import { withSchema } from "../__tests__/setup/postgres.js";
import { describeDbError, tryMutation, tryQuery, withTransaction, type DbError } from "./db-result.js";

describe("db-result", () => {
    let pool: Pool;
    let drop: () => Promise<void>;

    beforeAll(async () => {
        const ctx = await withSchema("db_result");
        pool = ctx.pool;
        drop = ctx.drop;
        // A tiny table with a unique constraint to exercise mapping + rollback.
        await pool.query(`
      CREATE TABLE dbr_items (
        id   text PRIMARY KEY,
        name text NOT NULL
      )
    `);
    });

    afterAll(async () => {
        await drop();
    });

    describe("tryQuery", () => {
        it("returns ok with the mapped value on a successful read", async () => {
            const result = await tryQuery("dbr.selectOne", async () => {
                const { rows } = await pool.query<{ n: number }>("SELECT 1::int AS n");
                return rows[0]?.n ?? null;
            });
            expect(result.isOk()).toBe(true);
            expect(result._unsafeUnwrap()).toBe(1);
        });

        it("absence stays in the ok channel as ok(null), never err", async () => {
            const result = await tryQuery("dbr.missingRow", async () => {
                const { rows } = await pool.query<{ id: string }>("SELECT id FROM dbr_items WHERE id = $1", ["does-not-exist"]);
                return rows[0]?.id ?? null;
            });
            expect(result.isOk()).toBe(true);
            expect(result._unsafeUnwrap()).toBeNull();
        });

        it("maps a driver throw (bad SQL) to err(query_failed)", async () => {
            const result = await tryQuery("dbr.badSql", async () => {
                await pool.query("SELECT * FROM no_such_table");
                return null;
            });
            expect(result.isErr()).toBe(true);
            const e = result._unsafeUnwrapErr();
            expect(e.type).toBe("query_failed");
            expect(e.op).toBe("dbr.badSql");
            expect(e.cause).toBeDefined();
        });
    });

    describe("tryMutation", () => {
        it("returns ok on a successful write", async () => {
            const result = await tryMutation("dbr.insert", async () => {
                const { rowCount } = await pool.query("INSERT INTO dbr_items (id, name) VALUES ($1, $2)", ["m-ok", "alpha"]);
                return rowCount ?? 0;
            });
            expect(result.isOk()).toBe(true);
            expect(result._unsafeUnwrap()).toBe(1);
        });

        it("maps a 23505 unique violation to err(constraint_violation) with the constraint name", async () => {
            await pool.query("INSERT INTO dbr_items (id, name) VALUES ($1, $2)", ["dup", "first"]);
            const result = await tryMutation("dbr.insertDup", async () => {
                const { rowCount } = await pool.query("INSERT INTO dbr_items (id, name) VALUES ($1, $2)", ["dup", "second"]);
                return rowCount ?? 0;
            });
            expect(result.isErr()).toBe(true);
            const e = result._unsafeUnwrapErr();
            expect(e.type).toBe("constraint_violation");
            if (e.type === "constraint_violation") {
                // pg reports the PK constraint name (dbr_items_pkey).
                expect(e.constraint).toContain("dbr_items");
                expect(e.op).toBe("dbr.insertDup");
            }
        });
    });

    describe("withTransaction", () => {
        it("COMMITs when the body resolves to ok — the write persists", async () => {
            const result = await withTransaction(pool, "dbr.txCommit", (client) =>
                tryMutation("dbr.txCommit.insert", async () => {
                    await client.query("INSERT INTO dbr_items (id, name) VALUES ($1, $2)", ["tx-commit", "kept"]);
                    return "tx-commit";
                }),
            );
            expect(result.isOk()).toBe(true);
            expect(result._unsafeUnwrap()).toBe("tx-commit");

            const { rows } = await pool.query<{ name: string }>("SELECT name FROM dbr_items WHERE id = $1", ["tx-commit"]);
            expect(rows[0]?.name).toBe("kept");
        });

        it("ROLLBACKs when a mutation in the body returns err — the sentinel forces rollback, nothing commits", async () => {
            // The transaction does a good insert, THEN a failing one (duplicate PK).
            // The sentinel must abort the whole transaction so the first insert is
            // NOT committed — this is the silent-commit footgun the contract closes.
            await pool.query("INSERT INTO dbr_items (id, name) VALUES ($1, $2)", ["tx-existing", "pre"]);

            const result = await withTransaction(pool, "dbr.txRollback", (client) =>
                tryMutation("dbr.txRollback.good", async () => {
                    await client.query("INSERT INTO dbr_items (id, name) VALUES ($1, $2)", ["tx-rollback-good", "should-vanish"]);
                    return 1;
                }).andThen(() =>
                    // This insert collides with the seeded row → err(constraint_violation).
                    tryMutation("dbr.txRollback.dup", async () => {
                        await client.query("INSERT INTO dbr_items (id, name) VALUES ($1, $2)", ["tx-existing", "collision"]);
                        return 1;
                    }),
                ),
            );

            expect(result.isErr()).toBe(true);
            const e = result._unsafeUnwrapErr();
            expect(e.type).toBe("constraint_violation");

            // The good insert must have rolled back — proves the sentinel fired and
            // the transaction did NOT silently commit the first statement.
            const { rows } = await pool.query("SELECT id FROM dbr_items WHERE id = $1", ["tx-rollback-good"]);
            expect(rows).toHaveLength(0);
        });
    });

    describe("describeDbError", () => {
        it("renders each variant to a one-line description", () => {
            const cases: Array<[DbError, string]> = [
                [{ type: "query_failed", op: "r", cause: 1 }, "database read failed (r)"],
                [{ type: "mutation_failed", op: "w", cause: 1 }, "database write failed (w)"],
                [{ type: "connection_failed", op: "c", cause: 1 }, "database connection failed (c)"],
                [{ type: "constraint_violation", op: "u", constraint: "uq", cause: 1 }, 'database constraint "uq" violated (u)'],
            ];
            for (const [e, expected] of cases) {
                expect(describeDbError(e)).toBe(expected);
            }
        });
    });
});
