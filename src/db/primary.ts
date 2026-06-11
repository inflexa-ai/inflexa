import { Database } from "bun:sqlite";
import { ensureDir, runMigrations } from "./util.ts";
import { migrations } from "./primary_migrations.ts";

const DB_PATH = process.env["INF_DB_PATH"] ?? `${process.env["HOME"]}/.local/share/inf/agent.db`;

let _db: Database | null = null;

export function db(): Database {
    if (_db) return _db;
    ensureDir(DB_PATH);
    _db = new Database(DB_PATH);
    _db.run("PRAGMA journal_mode = WAL");
    _db.run("PRAGMA synchronous = NORMAL");
    _db.run("PRAGMA busy_timeout = 5000");
    _db.run("PRAGMA cache_size = -64000");
    _db.run("PRAGMA foreign_keys = ON");
    runMigrations(_db, migrations);
    return _db;
}
