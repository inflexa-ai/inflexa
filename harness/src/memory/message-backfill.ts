import { errorMessageOf } from "../lib/thrown.js";
import { textOf } from "../lib/unknown-text.js";
import type { QueryResultRow } from "pg";

import { envelopeMessage, legacyAnthropicToModelMessage } from "./ai-sdk-message-storage.js";

/** The query method of a `pg` client, which the migration transaction also supplies. */
export type BackfillClient<Row extends QueryResultRow = QueryResultRow> = {
    query(text: string, values?: unknown[]): Promise<{ rows: Row[] }>;
};

type LegacyRow = {
    readonly thread_id: string;
    readonly seq: string;
    readonly role: string;
    readonly content_jsonb: string | Array<Record<string, unknown>>;
};

export async function backfillAiSdkMessageEnvelopes(client: BackfillClient<LegacyRow>): Promise<void> {
    // Legacy Anthropic columns (`role`, `content_jsonb`) are temporary and
    // should be removed after the AI SDK message-envelope migration window.
    const { rows } = await client.query(
        `SELECT thread_id, seq::text AS seq, role, content_jsonb
         FROM messages
         WHERE message_envelope IS NULL
         ORDER BY thread_id, seq`,
    );

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
            const message = errorMessageOf(err) ?? textOf(err);
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
    const [row] = remaining.rows;
    if (row !== undefined) {
        throw new Error(`AI SDK message backfill left an unmigrated row at ${row.thread_id}/${row.seq}`);
    }
}
