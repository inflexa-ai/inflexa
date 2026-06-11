import { Database } from "bun:sqlite";
import { ulid } from "ulid";
import type { Session, Message, Part, StoredMessage } from "../types.ts";

const DB_PATH = process.env["INF_DB_PATH"] ?? `${process.env["HOME"]}/.local/share/inf/agent.db`;

function ensureDir(path: string) {
    const dir = path.slice(0, path.lastIndexOf("/"));
    try {
        Bun.spawnSync(["mkdir", "-p", dir]);
    } catch {
        // best effort
    }
}

let _db: Database | null = null;

function db(): Database {
    if (_db) return _db;
    ensureDir(DB_PATH);
    _db = new Database(DB_PATH);
    _db.exec("PRAGMA journal_mode = WAL");
    _db.exec("PRAGMA foreign_keys = ON");
    migrate(_db);
    return _db;
}

function migrate(d: Database) {
    d.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      data TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      data TEXT NOT NULL,
      FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS parts (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      data TEXT NOT NULL,
      FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id);
    CREATE INDEX IF NOT EXISTS idx_parts_message ON parts(message_id);
    CREATE INDEX IF NOT EXISTS idx_parts_session ON parts(session_id);
  `);
}

export function newId(): string {
    return ulid();
}

export function createSession(title?: string): Session {
    const session: Session = {
        id: newId(),
        title: title ?? "New session",
        createdAt: Date.now(),
        updatedAt: Date.now(),
    };
    db().prepare("INSERT INTO sessions (id, data) VALUES (?, ?)").run(session.id, JSON.stringify(session));
    return session;
}

export function getSession(id: string): Session | null {
    const row = db().prepare("SELECT data FROM sessions WHERE id = ?").get(id) as { data: string } | null;
    return row ? (JSON.parse(row.data) as Session) : null;
}

export function updateSession(session: Session): void {
    session.updatedAt = Date.now();
    db().prepare("UPDATE sessions SET data = ? WHERE id = ?").run(JSON.stringify(session), session.id);
}

export function listSessions(): Session[] {
    const rows = db().prepare("SELECT data FROM sessions ORDER BY id DESC").all() as { data: string }[];
    return rows.map((r) => JSON.parse(r.data) as Session);
}

export function createMessage(msg: Message): void {
    db().prepare("INSERT INTO messages (id, session_id, data) VALUES (?, ?, ?)").run(msg.id, msg.sessionId, JSON.stringify(msg));
}

export function getSessionMessages(sessionId: string): StoredMessage[] {
    const msgRows = db().prepare("SELECT id, data FROM messages WHERE session_id = ? ORDER BY id ASC").all(sessionId) as { id: string; data: string }[];

    const partRows = db().prepare("SELECT message_id, data FROM parts WHERE session_id = ? ORDER BY id ASC").all(sessionId) as {
        message_id: string;
        data: string;
    }[];

    const partsByMsg = new Map<string, Part[]>();
    for (const r of partRows) {
        const arr = partsByMsg.get(r.message_id) ?? [];
        arr.push(JSON.parse(r.data) as Part);
        partsByMsg.set(r.message_id, arr);
    }

    return msgRows.map((r) => ({
        info: JSON.parse(r.data) as Message,
        parts: partsByMsg.get(r.id) ?? [],
    }));
}

export function upsertPart(part: Part): void {
    db()
        .prepare(
            `INSERT INTO parts (id, session_id, message_id, data) VALUES (?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET data = excluded.data`,
        )
        .run(part.id, part.sessionId, part.messageId, JSON.stringify(part));
}
