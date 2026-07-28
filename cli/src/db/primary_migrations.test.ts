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

function tableNames(db: Database): string[] {
    return db
        .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='table'")
        .all()
        .map((r) => r.name);
}

describe("runMigrations", () => {
    test("creates the full schema", () => {
        const tables = tableNames(migratedMemoryDb());
        for (const table of ["anchors", "projects", "analyses", "analysis_inputs", "_migrations"]) {
            expect(tables).toContain(table);
        }
    });

    test("a fresh database ends without the chat tables", () => {
        const tables = tableNames(migratedMemoryDb());
        for (const table of ["sessions", "messages", "parts"]) {
            expect(tables).not.toContain(table);
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

    test("records every applied version in the _migrations ledger", () => {
        const versions = migratedMemoryDb()
            .query<{ version: number }, []>("SELECT version FROM _migrations ORDER BY version")
            .all()
            .map((r) => r.version);
        expect(versions).toEqual([1, 2]);
    });

    test("is idempotent: re-running applies nothing new", () => {
        const db = migratedMemoryDb();
        runMigrations(db, migrations)._unsafeUnwrap(); // second run
        const count = db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM _migrations").get();
        expect(count?.n).toBe(migrations.length);
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

    test("leaves exactly the surviving lookup indexes", () => {
        // The name claims exactness, so assert the COMPLETE set rather than containment: a sixth index
        // appearing, or one of these quietly disappearing, has to fail here. `sql IS NOT NULL` excludes
        // SQLite's implicit sqlite_autoindex_* entries — they back the PRIMARY KEY / UNIQUE constraints
        // and are not indexes this schema declares.
        const indexes = migratedMemoryDb()
            .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='index' AND sql IS NOT NULL ORDER BY name")
            .all()
            .map((r) => r.name);
        expect(indexes).toEqual([
            "idx_analyses_anchor",
            "idx_analyses_project",
            "idx_analysis_inputs_analysis",
            "uq_analysis_inputs_anchored",
            "uq_analysis_inputs_unanchored",
        ]);
        // Redundant against the set equality above, but names the chat indexes so a regression that
        // re-created one reads as exactly that rather than as an anonymous set mismatch.
        for (const index of ["idx_sessions_analysis", "idx_messages_session", "idx_parts_message", "idx_parts_session"]) {
            expect(indexes).not.toContain(index);
        }
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

describe("migration 2: dropping the chat tables", () => {
    // The upgrade an installed user actually takes: a database left at the version-1 baseline, holding
    // rows in every table, meets the appended migration. Foreign keys are ON as they are on the app
    // connection (db() sets the pragma), so a drop order that left a dangling child reference would
    // fail here rather than only in the field.
    function v1DbWithChatRows(): Database {
        const db = new Database(":memory:");
        db.run("PRAGMA foreign_keys = ON");
        runMigrations(
            db,
            migrations.filter((m) => m.version === 1),
        )._unsafeUnwrap();

        db.run("INSERT INTO anchors (id, created_at, updated_at, cached_path, marker_written, last_seen) VALUES ('anc', 1, 1, '/tmp/x', 1, 1)");
        db.run("INSERT INTO projects (id, created_at, updated_at, name, description, tags) VALUES ('prj', 1, 1, 'Acme', NULL, '')");
        db.run("INSERT INTO analyses (id, created_at, updated_at, name, slug, anchor_id, project_id) VALUES ('ana', 1, 1, 'A', 'a', 'anc', 'prj')");
        db.run("INSERT INTO analysis_inputs (path, is_dir, analysis_id, anchor_id) VALUES ('in.csv', 0, 'ana', 'anc')");
        db.run("INSERT INTO sessions (id, data, analysis_id) VALUES ('ses', '{}', 'ana')");
        db.run("INSERT INTO messages (id, data, session_id) VALUES ('msg', '{}', 'ses')");
        db.run("INSERT INTO parts (id, data, session_id, message_id) VALUES ('prt', '{}', 'ses', 'msg')");
        return db;
    }

    test("an existing version-1 database loses the three chat tables", () => {
        const db = v1DbWithChatRows();
        runMigrations(db, migrations)._unsafeUnwrap();
        const tables = tableNames(db);
        for (const table of ["sessions", "messages", "parts"]) {
            expect(tables).not.toContain(table);
        }
    });

    test("the surviving tables keep their rows", () => {
        const db = v1DbWithChatRows();
        runMigrations(db, migrations)._unsafeUnwrap();
        const tables = tableNames(db);
        for (const table of ["anchors", "projects", "analyses", "analysis_inputs"]) {
            expect(tables).toContain(table);
            expect(db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n).toBe(1);
        }
    });

    test("a chat table the user already dropped by hand does not brick the migration", () => {
        // The database is a file the user owns and may hand-edit or restore from an older copy. SQLite's
        // bare DROP TABLE is a hard error on a table that is already gone, and the runner never records
        // version 2 for a transaction that threw — so the same error would re-fire on EVERY subsequent
        // launch, taking down every command over entity data that is perfectly intact. IF EXISTS is what
        // makes the migration converge from a mutilated schema instead.
        const db = v1DbWithChatRows();
        db.run("DROP TABLE parts");

        expect(runMigrations(db, migrations).isOk()).toBe(true);

        const versions = db
            .query<{ version: number }, []>("SELECT version FROM _migrations ORDER BY version")
            .all()
            .map((r) => r.version);
        expect(versions).toEqual([1, 2]);

        const tables = tableNames(db);
        for (const table of ["sessions", "messages", "parts"]) {
            expect(tables).not.toContain(table);
        }
        for (const table of ["anchors", "projects", "analyses", "analysis_inputs"]) {
            expect(tables).toContain(table);
            expect(db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n).toBe(1);
        }
    });
});
