import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { migrations, runMigrations } from "./primary_migrations.ts";

// The migration runner takes an explicit Database, so these run against a throwaway in-memory DB
// with no env/singleton plumbing — the cleanest way to pin schema + idempotency.
function migratedMemoryDb(): Database {
    const db = new Database(":memory:");
    runMigrations(db, migrations)._unsafeUnwrap();
    return db;
}

describe("runMigrations", () => {
    test("creates the full schema", () => {
        const db = migratedMemoryDb();
        const tables = db
            .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='table'")
            .all()
            .map((r) => r.name);
        for (const table of ["anchors", "projects", "analyses", "analysis_inputs", "sessions", "messages", "parts", "_migrations"]) {
            expect(tables).toContain(table);
        }
    });

    test("analyses table includes provenance columns", () => {
        const columns = migratedMemoryDb()
            .query<{ name: string }, []>("PRAGMA table_info(analyses)")
            .all()
            .map((c) => c.name);
        expect(columns).toContain("provenance");
        expect(columns).toContain("provenance_chain_hash");
        expect(columns).toContain("provenance_signature");
        expect(columns).toContain("provenance_prev_chain_hash");
    });

    test("records the applied version in the _migrations ledger", () => {
        const versions = migratedMemoryDb()
            .query<{ version: number }, []>("SELECT version FROM _migrations ORDER BY version")
            .all()
            .map((r) => r.version);
        expect(versions).toEqual([1]);
    });

    test("is idempotent: re-running applies nothing new", () => {
        const db = migratedMemoryDb();
        runMigrations(db, migrations)._unsafeUnwrap(); // second run
        const count = db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM _migrations").get();
        expect(count?.n).toBe(1);
    });

    test("enforces uniqueness on analysis_inputs", () => {
        const db = migratedMemoryDb();
        const indexes = db
            .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='analysis_inputs'")
            .all()
            .map((r) => r.name);
        expect(indexes).toContain("uq_analysis_inputs_anchored");
        expect(indexes).toContain("uq_analysis_inputs_unanchored");
    });

    test("sessions.analysis_id FK has ON DELETE CASCADE", () => {
        const fks = migratedMemoryDb().query<{ table: string; on_delete: string }, []>("PRAGMA foreign_key_list(sessions)").all();
        const analysisFk = fks.find((f) => f.table === "analyses");
        expect(analysisFk).toBeDefined();
        expect(analysisFk!.on_delete).toBe("CASCADE");
    });

    test("declares the analyses foreign keys to anchors and projects", () => {
        const fkTables = migratedMemoryDb()
            .query<{ table: string }, []>("PRAGMA foreign_key_list(analyses)")
            .all()
            .map((f) => f.table);
        expect(fkTables).toContain("anchors");
        expect(fkTables).toContain("projects");
    });
});
