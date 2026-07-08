import * as query from "../../db/primary_query.ts";
import { dieOn } from "../../lib/cli.ts";

/**
 * `inflexa sessions` — print the saved chat sessions (id, title, creation time).
 * Sessions are the live launch-identity rows (a chat thread binds 1:1 to one), so this
 * lists current data; their `messages`/`parts` history is frozen legacy data with no
 * remaining writer. The command performs reads only — no row is created or modified.
 */
export async function listSessions(): Promise<void> {
    query.listSessions().match((sessions) => {
        if (sessions.length === 0) {
            console.log("No sessions found.");
            return;
        }

        console.log(`\n  Sessions (${sessions.length}):\n`);
        for (const s of sessions) {
            const date = new Date(s.createdAt).toLocaleString();
            console.log(`  ${s.id}  ${s.title}  (${date})`);
        }
        console.log();
    }, dieOn("Failed to list sessions"));
}
