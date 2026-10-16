import type { QueryResultRow } from "pg";
import { z } from "zod";

import { envelopeMessage, legacyAnthropicToModelMessage } from "./ai-sdk-message-storage.js";
import { errorMessage } from "../lib/thrown.js";

/** The query method of a `pg` client, which the migration transaction also supplies. */
export type BackfillClient = {
    query(text: string, values?: unknown[]): Promise<{ rows: QueryResultRow[] }>;
};

const LegacyRowSchema = z.object({
    thread_id: z.string(),
    seq: z.string(),
    role: z.string(),
    content_jsonb: z.union([z.string(), z.array(z.record(z.string(), z.json()))]),
});

type LegacyRow = z.infer<typeof LegacyRowSchema>;

export async function backfillAiSdkMessageEnvelopes(client: BackfillClient): Promise<void> {
    // Legacy Anthropic columns (`role`, `content_jsonb`) are temporary and
    // should be removed after the AI SDK message-envelope migration window.
    const legacy = await client.query(
        `SELECT thread_id, seq::text AS seq, role, content_jsonb
         FROM messages
         WHERE message_envelope IS NULL
         ORDER BY thread_id, seq`,
    );
    const rows: LegacyRow[] = z.array(LegacyRowSchema).parse(legacy.rows);

    for (const row of rows) {
        const identity = `${row.thread_id}/${row.seq}`;
        try {
            const message = legacyAnthropicToModelMessage({
                threadId: row.thread_id,
                seq: Number(row.seq),
                role: row.role,
                content: row.content_jsonb,
            });
            await client.query("UPDATE messages SET message_envelope = $1::json WHERE thread_id = $2 AND seq = $3::bigint", [
                JSON.stringify(envelopeMessage(message)),
                row.thread_id,
                row.seq,
            ]);
        } catch (err) {
            const message = errorMessage(err);
            throw new Error(`Failed to backfill AI SDK message envelope for ${identity}: ${message}`, { cause: err });
        }
    }

    const remaining = await client.query(
        `SELECT thread_id, seq::text AS seq
         FROM messages
         WHERE message_envelope IS NULL
         ORDER BY thread_id, seq
         LIMIT 1`,
    );
    if (remaining.rows.length > 0) {
        const row = z.object({ thread_id: z.string(), seq: z.string() }).parse(remaining.rows[0]);
        throw new Error(`AI SDK message backfill left an unmigrated row at ${row.thread_id}/${row.seq}`);
    }
}
