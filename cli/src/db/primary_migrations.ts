import { Database } from "bun:sqlite";
import { Result, ok, err } from "neverthrow";
import type { DbError } from "./errors.ts";
import type { Migration } from "./util.ts";

export const migrations: Migration[] = [
    {
        // Single baseline. Tables are declared parent-before-child so every FK is a backward
        // reference. Columns follow the house order: the identity triple (id, created_at,
        // updated_at) first and colocated, then core data, then foreign keys last.
        version: 1,
        up: `
            CREATE TABLE anchors (
                id TEXT PRIMARY KEY,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                cached_path TEXT NOT NULL,
                marker_written INTEGER NOT NULL,
                last_seen INTEGER NOT NULL
            );
            CREATE TABLE projects (
                id TEXT PRIMARY KEY,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                name TEXT NOT NULL UNIQUE,
                description TEXT,
                tags TEXT NOT NULL DEFAULT ''
            );
            CREATE TABLE analyses (
                id TEXT PRIMARY KEY,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                name TEXT NOT NULL,
                slug TEXT NOT NULL,
                provenance TEXT,
                provenance_chain_hash TEXT,
                provenance_signature TEXT,
                provenance_prev_chain_hash TEXT,
                anchor_id TEXT NOT NULL REFERENCES anchors(id),
                project_id TEXT REFERENCES projects(id),
                -- The whole workspace (staged inputs, run artifacts, provenance exports) lives at
                -- …/analyses/<slug>/ under the anchor, so a slug must be unique within its anchor.
                -- This uniqueness is also what makes the harness workspace-root resolver injective.
                UNIQUE (anchor_id, slug)
            );
            CREATE INDEX idx_analyses_project ON analyses(project_id);
            CREATE INDEX idx_analyses_anchor ON analyses(anchor_id);
            -- Inputs are stored as references, never copies: the local filesystem is authoritative.
            -- Each row's path is relative-to-anchor when anchor_id is set (so it rides the anchor's
            -- UUID across moves/renames) and absolute otherwise. The analysis FK cascades — dropping
            -- an analysis takes its input refs with it. No identity triple: a ref is not an entity.
            -- anchor_id is nullable (raw absolute paths have no anchor), and SQLite treats each NULL
            -- as distinct in UNIQUE constraints — so a partial index pair covers both cases.
            CREATE TABLE analysis_inputs (
                path TEXT NOT NULL,
                is_dir INTEGER NOT NULL DEFAULT 0,
                analysis_id TEXT NOT NULL REFERENCES analyses(id) ON DELETE CASCADE,
                anchor_id TEXT REFERENCES anchors(id)
            );
            CREATE INDEX idx_analysis_inputs_analysis ON analysis_inputs(analysis_id);
            CREATE UNIQUE INDEX uq_analysis_inputs_anchored
                ON analysis_inputs(analysis_id, path, anchor_id)
                WHERE anchor_id IS NOT NULL;
            CREATE UNIQUE INDEX uq_analysis_inputs_unanchored
                ON analysis_inputs(analysis_id, path)
                WHERE anchor_id IS NULL;
            -- Chat tables: the row is the opaque JSON \`data\` blob; the only columns are the id and
            -- the FK indexes. A session links to its analysis (one analysis, many sessions) via the
            -- analysis_id column, not the blob. Deleting an analysis cascades to its sessions,
            -- which cascades to messages, which cascades to parts.
            CREATE TABLE sessions (
                id TEXT PRIMARY KEY,
                data TEXT NOT NULL,
                analysis_id TEXT REFERENCES analyses(id) ON DELETE CASCADE
            );
            CREATE INDEX idx_sessions_analysis ON sessions(analysis_id);
            CREATE TABLE messages (
                id TEXT PRIMARY KEY,
                data TEXT NOT NULL,
                session_id TEXT NOT NULL,
                FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
            );
            CREATE INDEX idx_messages_session ON messages(session_id);
            CREATE TABLE parts (
                id TEXT PRIMARY KEY,
                data TEXT NOT NULL,
                session_id TEXT NOT NULL,
                message_id TEXT NOT NULL,
                FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE
            );
            CREATE INDEX idx_parts_message ON parts(message_id);
            CREATE INDEX idx_parts_session ON parts(session_id);
        `,
    },
    {
        // A conversation is single-homed in the harness Postgres thread store: it owns the session's
        // identity, its title, its activity timestamps, and every message. These three SQLite tables
        // were the second home — frozen with no writer and no reader — so the drop retires them rather
        // than leave dead schema inviting a new reader and reopening "which store is authoritative".
        //
        // What the drop achieves, stated exactly: the transcript rows become permanently unreachable
        // and their pages return to the freelist for reuse. The bytes are NOT scrubbed, and reclaiming
        // them is deliberately not attempted here — VACUUM cannot run inside the transaction this
        // migration executes in, and it transiently needs roughly the database's size again in free
        // space, a cost no upgrade should impose on a user's disk.
        //
        // IF EXISTS on all three: the database is a file the user owns and may hand-edit or restore, so
        // a table they already removed must not hard-fail the migration on every launch and brick every
        // command over data that is otherwise intact (CLAUDE.md → local state can desync).
        //
        // Dropped child-first (parts → messages → sessions), though nothing forces that order today:
        // every foreign key on this set is ON DELETE CASCADE, so parent-first succeeds just as well.
        // The child-first order is kept so the step stays correct if a future key ever declines to
        // cascade. Each table's indexes go with it, so they need no statements of their own.
        version: 2,
        up: `
            DROP TABLE IF EXISTS parts;
            DROP TABLE IF EXISTS messages;
            DROP TABLE IF EXISTS sessions;
        `,
    },
    {
        // The local LLM-usage ledger: one row per completed LLM call the harness reports through its
        // UsageRecorder seam. `record_key` IS the identity — the harness guarantees that key is stable
        // across every replay of the same call, so minting a synthetic id beside it would create two
        // things that must agree about what "the same call" is. Writes upsert on it; a usage row is an
        // observation, not an entity, so it carries no id/created_at/updated_at triple (the same
        // exception analysis_inputs takes). Column order still follows the house rule: identity
        // (record_key + its arrival stamp) first, then core data — there is no foreign-key group here.
        //
        // NO foreign key on any column, deliberately. `scope_id` is minted harness-side and includes
        // synthetic workload ids this database will never hold (the embedding boot probe and the
        // embedding setup verifier both drive agent loops under invented analysis ids). The recorder is
        // contractually forbidden to throw, so a referential constraint would fire on exactly the rows
        // it must never fail on. `thread_id`/`run_id`/`step_id` are attribution too, not relations.
        //
        // The scope rides as a discriminant + id rather than a single analysis_id so both variants of
        // the harness's Scope union are representable and neither is silently discarded; a per-analysis
        // read simply constrains scope_kind = 'analysis'.
        //
        // Every token column is nullable with NO NOT NULL and NO DEFAULT. Absent must stay
        // distinguishable from zero: 'NOT NULL DEFAULT 0' would rewrite "this provider does not report
        // cache reads" into "this provider reported zero cache reads", an unknown dressed as a
        // measurement. Reads aggregate with SUM(), which skips NULLs and itself yields NULL for a group
        // in which nothing was reported, so the distinction survives aggregation as well. The five are
        // named for the harness ChatUsage fields they carry, one column per field.
        //
        // Exactly one index, on (scope_kind, scope_id): every surface filters the scope first and the
        // model/agent breakdowns group underneath that filter. No run_id or served_model_id index —
        // nothing queries by either without a scope, and an index whose only justification is a query
        // no surface makes is write cost with no reader.
        version: 3,
        up: `
            CREATE TABLE llm_usage (
                record_key TEXT PRIMARY KEY,
                recorded_at INTEGER NOT NULL,
                agent_id TEXT NOT NULL,
                call_path TEXT NOT NULL,
                scope_kind TEXT NOT NULL,
                scope_id TEXT NOT NULL,
                thread_id TEXT,
                run_id TEXT,
                step_id TEXT,
                requested_model_id TEXT,
                served_model_id TEXT,
                input_tokens INTEGER,
                output_tokens INTEGER,
                cache_creation_input_tokens INTEGER,
                cache_read_input_tokens INTEGER,
                reasoning_tokens INTEGER
            );
            CREATE INDEX idx_llm_usage_scope ON llm_usage(scope_kind, scope_id);
        `,
    },
    {
        // The lifecycle of the detached package-store downloader: one row that records what the process
        // does now. The receipt on disk stays the truth of what the store holds, so nothing here decides
        // whether a sandbox can start — a store that a manual pull built carries no row at all, and it is
        // usable. The two records never merge (design: "Split the two records, and give each one job").
        //
        // ONE row, keyed on a fixed id rather than a minted UUIDv7. There is one store root and one
        // downloader, so "the download of that root" IS the identity; a synthetic id beside it would make
        // two things that must agree about which row is current. This is the same argument `llm_usage`
        // makes for `record_key`. Every write upserts on that id, so a retry rewrites the row in place.
        //
        // The CHECK on `state` is what makes the reader's cast of the column sound: SQLite refuses any
        // value outside the six, thus a row that comes back always carries a `LibStoreDownloadStatus`.
        //
        // `total_bytes` and `total_layers` are nullable with NO DEFAULT, because absent must stay
        // distinguishable from zero. The manifest declares the size of every layer, so the two totals are
        // exact from the moment it resolves and NULL before it — a `DEFAULT 0` would rewrite "the manifest
        // has not resolved" into "this store is empty", and a reader would draw a full meter over nothing.
        //
        // `holder_pid` is the liveness signal in reverse: the downloader holds the `lib-store-download`
        // instance lock for its whole life, and a `running` row with no live holder reads as `failed`. The
        // pid is recorded so a cancel can reach the process; the LOCK, not this column, decides liveness.
        //
        // No foreign key on any column, and no index: the table holds one row, which every reader reaches
        // by its primary key.
        version: 4,
        up: `
            CREATE TABLE lib_store_downloads (
                id TEXT PRIMARY KEY,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                state TEXT NOT NULL CHECK (state IN ('pending', 'running', 'installed', 'failed', 'declined', 'canceled')),
                bytes_transferred INTEGER NOT NULL DEFAULT 0,
                total_bytes INTEGER,
                layers_completed INTEGER NOT NULL DEFAULT 0,
                total_layers INTEGER,
                manifest_digest TEXT,
                message TEXT,
                holder_pid INTEGER
            );
        `,
    },
];

export function runMigrations(db: Database, migrations: Migration[]): Result<void, DbError> {
    try {
        db.run(`
            CREATE TABLE IF NOT EXISTS _migrations (
                version INTEGER PRIMARY KEY,
                applied_at INTEGER NOT NULL
            )
        `);

        const applied = db.query("SELECT MAX(version) as v FROM _migrations").get() as { v: number | null };
        const currentVersion = applied.v ?? 0;

        for (const m of migrations) {
            if (m.version <= currentVersion) continue;
            db.transaction(() => {
                db.run(m.up);
                db.query("INSERT INTO _migrations (version, applied_at) VALUES (?, ?)").run(m.version, Date.now());
            })();
        }

        return ok(undefined);
    } catch (cause) {
        return err({ type: "migration_failed", cause });
    }
}
