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
                output_directory TEXT,
                provenance TEXT,
                provenance_chain_hash TEXT,
                provenance_signature TEXT,
                provenance_prev_chain_hash TEXT,
                anchor_id TEXT NOT NULL REFERENCES anchors(id),
                project_id TEXT REFERENCES projects(id),
                -- Outputs live at …/analyses/<slug>/, so a slug must be unique within its anchor.
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
