import { Database } from "bun:sqlite";
import { ulid } from "ulid";

export interface Migration {
    version: number;
    up: string;
}

export function newId(): string {
    return ulid();
}

export function ensureDir(path: string) {
    const dir = path.slice(0, path.lastIndexOf("/"));
    try {
        Bun.spawnSync(["mkdir", "-p", dir]);
    } catch {
        // best effort
    }
}

export function runMigrations(db: Database, migrations: Migration[]) {
    db.run(`
        CREATE TABLE IF NOT EXISTS _migrations (
            version INTEGER PRIMARY KEY,
            applied_at INTEGER NOT NULL
        )
    `);

    const applied = db.prepare("SELECT MAX(version) as v FROM _migrations").get() as { v: number | null };
    const currentVersion = applied.v ?? 0;

    for (const m of migrations) {
        if (m.version <= currentVersion) continue;
        db.transaction(() => {
            db.run(m.up);
            db.prepare("INSERT INTO _migrations (version, applied_at) VALUES (?, ?)").run(m.version, Date.now());
        })();
    }
}
