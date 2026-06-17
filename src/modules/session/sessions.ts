import * as query from "../../db/primary_query.ts";
import { dieOn } from "../../lib/cli.ts";

export async function listSessions() {
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
