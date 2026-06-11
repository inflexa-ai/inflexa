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
