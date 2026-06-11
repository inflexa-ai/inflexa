import { Database } from "bun:sqlite";
import { env } from "../lib/env.ts";
import { ensureDir, runMigrations } from "./util.ts";
import { migrations } from "./primary_migrations.ts";

let _db: Database | null = null;

export function db(): Database {
    if (_db) return _db;
    ensureDir(env.dbPath);
    _db = new Database(env.dbPath);
    _db.run("PRAGMA journal_mode = WAL");
    _db.run("PRAGMA synchronous = NORMAL");
    _db.run("PRAGMA busy_timeout = 5000");
    _db.run("PRAGMA cache_size = -64000");
    _db.run("PRAGMA foreign_keys = ON");
    runMigrations(_db, migrations);
    return _db;
}
