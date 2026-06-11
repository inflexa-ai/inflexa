import { Database } from "bun:sqlite";
import { Result, ok, err } from "neverthrow";
import type { DbError } from "./errors.ts";
import type { Migration } from "./util.ts";

export const migrations: Migration[] = [
    {
        version: 1,
        up: `
            CREATE TABLE sessions (
                id TEXT PRIMARY KEY,
                data TEXT NOT NULL
            );
            CREATE TABLE messages (
                id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL,
                data TEXT NOT NULL,
                FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
            );
            CREATE TABLE parts (
                id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL,
                message_id TEXT NOT NULL,
                data TEXT NOT NULL,
                FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE
            );
            CREATE INDEX idx_messages_session ON messages(session_id);
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
