import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
        for (const table of ["anchors", "projects", "analyses", "analysis_inputs", "llm_usage", "_migrations"]) {
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

    test("llm_usage token columns are nullable with no default", () => {
        // The absent-means-not-reported discipline is easiest to lose right here: a `NOT NULL DEFAULT 0`
        // on any of these would silently rewrite "this provider does not report cache reads" into "this
        // provider reported zero cache reads" — an unknown turned into a measurement, and no read-side
        // care could recover the difference afterwards. PRAGMA table_info states both halves directly.
        const columns = migratedMemoryDb().query<{ name: string; notnull: number; dflt_value: string | null }, []>("PRAGMA table_info(llm_usage)").all();
        for (const name of ["input_tokens", "output_tokens", "cache_creation_input_tokens", "cache_read_input_tokens", "reasoning_tokens"]) {
            const column = columns.find((c) => c.name === name);
            expect(column).toBeDefined();
            expect(column?.notnull).toBe(0);
            expect(column?.dflt_value).toBeNull();
        }
        // The attribution half of the same contract, pinned beside it: these five are what makes a row
        // answerable at all, so they are the only NOT NULL columns besides the key and its stamp.
        for (const name of ["recorded_at", "agent_id", "call_path", "scope_kind", "scope_id"]) {
            expect(columns.find((c) => c.name === name)?.notnull).toBe(1);
        }
    });

    test("llm_usage is keyed by the harness record key and declares no foreign key", () => {
        const db = migratedMemoryDb();
        const primaryKey = db
            .query<{ name: string; pk: number }, []>("PRAGMA table_info(llm_usage)")
            .all()
            .filter((c) => c.pk > 0)
            .map((c) => c.name);
        expect(primaryKey).toEqual(["record_key"]);
        // No FK, deliberately: scope ids are minted harness-side and include synthetic workload ids this
        // database never holds, while the recorder is contractually forbidden to throw — a referential
        // constraint would fire on exactly the rows it must not fail on.
        expect(db.query("PRAGMA foreign_key_list(llm_usage)").all()).toEqual([]);
    });

    test("records every applied version in the _migrations ledger", () => {
        const versions = migratedMemoryDb()
            .query<{ version: number }, []>("SELECT version FROM _migrations ORDER BY version")
            .all()
            .map((r) => r.version);
        expect(versions).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
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
        // The name claims exactness, so assert the COMPLETE set rather than containment: a further index
        // appearing, or one of these quietly disappearing, has to fail here. `sql IS NOT NULL` excludes
        // SQLite's implicit sqlite_autoindex_* entries — they back the PRIMARY KEY / UNIQUE constraints
        // and are not indexes this schema declares. The ledger contributes exactly one: no run_id or
        // served_model_id index, because nothing queries by either without a scope.
        const indexes = migratedMemoryDb()
            .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='index' AND sql IS NOT NULL ORDER BY name")
            .all()
            .map((r) => r.name);
        expect(indexes).toEqual([
            "idx_analyses_anchor",
            "idx_analyses_project",
            "idx_analysis_inputs_analysis",
            "idx_llm_usage_scope",
            "idx_ps_flight_subs_flight",
            "uq_analysis_inputs_anchored",
            "uq_analysis_inputs_unanchored",
            "uq_ps_flight_subs_analysis",
            "uq_ps_flight_subs_host",
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
        expect(versions).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);

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

describe("migration 7 — the flight-table rebuild", () => {
    // Task 1.3 of flight-refusals-and-debris: the rebuild runs while a SECOND
    // connection — the picture of a live flush child on an old binary — holds
    // the same database file. The old states are a subset of the new CHECK,
    // and SQLite re-prepares a statement on a schema change, thus the writes
    // of the old connection must keep landing on the rebuilt table.
    test("a live second connection keeps its rows and keeps writing across the rebuild", () => {
        const dir = mkdtempSync(join(tmpdir(), "inflexa-mig7-"));
        const path = join(dir, "agent.db");
        const migrator = new Database(path);
        const holder = new Database(path);
        try {
            for (const conn of [migrator, holder]) {
                conn.run("PRAGMA journal_mode = WAL");
                conn.run("PRAGMA busy_timeout = 5000");
                conn.run("PRAGMA foreign_keys = ON");
            }
            runMigrations(
                migrator,
                migrations.filter((m) => m.version <= 6),
            )._unsafeUnwrap();
            holder
                .query(
                    `INSERT INTO package_store_flights (id, created_at, updated_at, state, ecosystem, name, specifier, progress, holder_pid)
                 VALUES (?, ?, ?, 'running', 'python', 'scanpy', '', NULL, ?)`,
                )
                .run("python::scanpy::", 1, 1, 4242);
            holder.query("INSERT INTO package_store_flight_subscriptions (flight_id, analysis_id) VALUES (?, NULL)").run("python::scanpy::");

            runMigrations(migrator, migrations)._unsafeUnwrap();

            // The copied row and its subscription survived the rebuild.
            const changed = holder
                .query("UPDATE package_store_flights SET updated_at = ?, progress = ? WHERE id = ?")
                .run(2, "[provision] step", "python::scanpy::").changes;
            expect(changed).toBe(1);
            const row = holder
                .query<{ state: string; progress: string | null; message: string | null }, [string]>(
                    "SELECT state, progress, message FROM package_store_flights WHERE id = ?",
                )
                .get("python::scanpy::");
            expect(row).toEqual({ state: "running", progress: "[provision] step", message: null });
            expect(holder.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM package_store_flight_subscriptions").get()?.n).toBe(1);
            // The rebuilt CHECK accepts the new terminal state.
            migrator.query("UPDATE package_store_flights SET state = 'failed', message = ? WHERE id = ?").run("resolve: x", "python::scanpy::");
            expect(holder.query<{ state: string }, []>("SELECT state FROM package_store_flights").get()?.state).toBe("failed");
        } finally {
            migrator.close();
            holder.close();
            rmSync(dir, { recursive: true, force: true });
        }
    });
});

describe("migration 8 — the transfer phase column", () => {
    test("the column is nullable with no default", () => {
        // The additive contract of the migration, stated where a rewrite would break it. A
        // `NOT NULL DEFAULT 'download'` would turn "this row declares no phase" — an image
        // transfer, and a row an older binary wrote — into the claim that the row downloads.
        const column = migratedMemoryDb()
            .query<{ name: string; notnull: number; dflt_value: string | null }, []>("PRAGMA table_info(transfers)")
            .all()
            .find((c) => c.name === "phase");
        expect(column).toBeDefined();
        expect(column?.notnull).toBe(0);
        expect(column?.dflt_value).toBeNull();
    });

    test("an existing version-7 row gains a null phase and the CHECK holds", () => {
        // The upgrade an installed user takes: a row that a previous binary wrote meets the
        // appended column. No backfill runs, thus the row reads as "no phase known". The CHECK
        // is what makes the cast of the reader sound, so a third word must be refused.
        const db = new Database(":memory:");
        runMigrations(
            db,
            migrations.filter((m) => m.version <= 7),
        )._unsafeUnwrap();
        db.run(
            `INSERT INTO transfers (id, created_at, updated_at, state, bytes_transferred, total_bytes, layers_completed, total_layers, digest, message, holder_pid)
             VALUES ('catalog', 1, 1, 'running', 512, NULL, 0, NULL, NULL, NULL, 4242)`,
        );

        runMigrations(db, migrations)._unsafeUnwrap();

        const row = db.query<{ bytes_transferred: number; phase: string | null }, []>("SELECT bytes_transferred, phase FROM transfers").get();
        expect(row).toEqual({ bytes_transferred: 512, phase: null });
        db.run("UPDATE transfers SET phase = 'unpacking' WHERE id = 'catalog'");
        expect(db.query<{ phase: string | null }, []>("SELECT phase FROM transfers").get()?.phase).toBe("unpacking");
        expect(() => db.run("UPDATE transfers SET phase = 'staging' WHERE id = 'catalog'")).toThrow();
    });
});

describe("migration 10 — one spelling for each request", () => {
    test("a row with a raw name keeps that spelling, and the folded column goes", () => {
        // The live case: migration 9 recorded `GO.db` beside the folded `go-db`,
        // and a request holds ONE name. The spelling is the half that an
        // installer can reach, thus it is the half that survives.
        const db = new Database(":memory:");
        runMigrations(
            db,
            migrations.filter((m) => m.version <= 9),
        )._unsafeUnwrap();
        db.run(
            "INSERT INTO pending_store_adds (id, created_at, name, raw_name, specifier, ecosystem, analysis_id) VALUES ('p1', 1, 'go-db', 'GO.db', '', 'r', NULL)",
        );
        db.run(
            `INSERT INTO package_store_flights (id, created_at, updated_at, state, ecosystem, name, raw_name, specifier, progress, message, holder_pid)
             VALUES ('r::go-db::', 1, 1, 'queued', 'r', 'go-db', 'GO.db', '', NULL, NULL, 4242)`,
        );
        db.run("INSERT INTO package_store_flight_subscriptions (flight_id, analysis_id) VALUES ('r::go-db::', NULL)");

        runMigrations(db, migrations)._unsafeUnwrap();

        expect(db.query<{ spelling: string }, []>("SELECT spelling FROM pending_store_adds").get()?.spelling).toBe("GO.db");
        expect(db.query<{ spelling: string }, []>("SELECT spelling FROM package_store_flights").get()?.spelling).toBe("GO.db");
        // The id IS the key, and the key carries the spelling. A kept `r::go-db::`
        // would miss the next claim of `GO.db`, and a second row would run beside
        // this one.
        expect(db.query<{ id: string }, []>("SELECT id FROM package_store_flights").get()?.id).toBe("r::GO.db::");
        // No folded column survives: the fold left the SQL with this rebuild.
        expect(() => db.run("SELECT name FROM package_store_flights")).toThrow();
        expect(() => db.run("SELECT raw_name FROM pending_store_adds")).toThrow();
        // The subscription rode the rebuild of its parent onto the new key, and
        // the CASCADE of the old parent did not eat it.
        expect(db.query<{ flight_id: string }, []>("SELECT flight_id FROM package_store_flight_subscriptions").get()?.flight_id).toBe("r::GO.db::");
        expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM package_store_flight_subscriptions").get()?.n).toBe(1);
    });

    test("a row from before the raw-name column takes its folded name as the spelling", () => {
        // The upgrade of an older install: `raw_name` is null, and the folded
        // name is the only spelling that the row still knows.
        const db = new Database(":memory:");
        runMigrations(
            db,
            migrations.filter((m) => m.version <= 8),
        )._unsafeUnwrap();
        db.run("INSERT INTO pending_store_adds (id, created_at, name, specifier, ecosystem, analysis_id) VALUES ('p1', 1, 'scanpy', '==1.11', 'python', NULL)");
        db.run(
            `INSERT INTO package_store_flights (id, created_at, updated_at, state, ecosystem, name, specifier, progress, message, holder_pid)
             VALUES ('python::scanpy::', 1, 1, 'failed', 'python', 'scanpy', '', NULL, 'resolve: offline', 4242)`,
        );

        runMigrations(db, migrations)._unsafeUnwrap();

        expect(db.query<{ spelling: string; specifier: string }, []>("SELECT spelling, specifier FROM pending_store_adds").get()).toEqual({
            spelling: "scanpy",
            specifier: "==1.11",
        });
        const flight = db
            .query<{ spelling: string; state: string; message: string | null }, []>("SELECT spelling, state, message FROM package_store_flights")
            .get();
        expect(flight).toEqual({ spelling: "scanpy", state: "failed", message: "resolve: offline" });
    });
});
