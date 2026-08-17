import type { Pool } from "pg";

import { createDetailResolver } from "../tools/detail-resolver.js";
import type { Tool } from "../tools/define-tool.js";
import { envelopeDisplayMessages, cortexMessagesToConversationUI, parseStoredDisplayEnvelope } from "./conversation-display-storage.js";
import { parseStoredMessageEnvelope } from "./ai-sdk-message-storage.js";
import { contentToCortexMessages } from "./content-to-cortex.js";
import { createCardResolver } from "./reconstruct-cards.js";
import type { StoredMessage } from "./thread-history.js";

const BATCH_SIZE = 100;

interface TurnHead {
    readonly thread_id: string;
    readonly seq: string;
    readonly analysis_id: string | null;
}

const GENUINE_USER_SQL = `m.message_envelope->'message'->>'role' = 'user'
  AND m.message_envelope->'message'->'providerOptions'->'cortex'->>'synthetic' IS DISTINCT FROM 'true'`;

export interface ConversationDisplayBackfillDeps {
    readonly pool: Pool;
    /**
     * The conversation agent's composed roster, used to recover each legacy call's
     * one-line detail from its persisted input. Tools contributed through the
     * host-tools seam are invisible to any map the harness holds on its own, so the
     * list has to come from the assembled runtime.
     */
    readonly tools: readonly Tool[];
    readonly batchSize?: number;
}

/**
 * Freeze the migration renderer's output into display envelopes, once per legacy
 * turn, so the runtime read path never has to reconstruct anything.
 *
 * Missing mutable resources degrade to a generic, cardless display — a plan
 * that is absent is normal historical absence, not a fault. Malformed stored rows
 * and database faults remain startup-fatal: a turn that cannot be migrated must
 * not be silently skipped and then read as if it had no display.
 */
export async function backfillConversationDisplayEnvelopes(deps: ConversationDisplayBackfillDeps): Promise<number> {
    const batchSize = Math.max(1, deps.batchSize ?? BATCH_SIZE);
    const resolveDetail = createDetailResolver(deps.tools);
    let migrated = 0;
    let validationOffset = 0;

    for (;;) {
        const { rows } = await deps.pool.query<{ thread_id: string; seq: string; display_envelope: unknown }>(
            `SELECT thread_id, seq::text AS seq, display_envelope
               FROM messages
              WHERE display_envelope IS NOT NULL
              ORDER BY thread_id, seq
              LIMIT $1 OFFSET $2`,
            [batchSize, validationOffset],
        );
        await Promise.all(rows.map((row) => parseStoredDisplayEnvelope(row.display_envelope, `${row.thread_id}/${row.seq}/display`)));
        if (rows.length < batchSize) break;
        validationOffset += rows.length;
    }

    for (;;) {
        const { rows: heads } = await deps.pool.query<TurnHead>(
            `SELECT m.thread_id, m.seq::text AS seq, t.analysis_id
               FROM messages m
               LEFT JOIN cortex_analysis_threads t ON t.thread_id = m.thread_id
              WHERE ${GENUINE_USER_SQL}
                AND m.display_envelope IS NULL
              ORDER BY m.thread_id, m.seq
              LIMIT $1`,
            [batchSize],
        );
        if (heads.length === 0) return migrated;

        for (const head of heads) {
            const { rows } = await deps.pool.query<{ seq: string; message_envelope: unknown }>(
                `SELECT m.seq::text AS seq, m.message_envelope
                   FROM messages m
                  WHERE m.thread_id = $1
                    AND m.seq >= $2::bigint
                    AND m.seq < COALESCE(
                      (
                        SELECT MIN(next.seq)
                          FROM messages next
                         WHERE next.thread_id = m.thread_id
                           AND next.seq > $2::bigint
                           AND next.message_envelope->'message'->>'role' = 'user'
                           AND next.message_envelope->'message'->'providerOptions'->'cortex'->>'synthetic' IS DISTINCT FROM 'true'
                      ),
                      9223372036854775807
                    )
                  ORDER BY m.seq`,
                [head.thread_id, head.seq],
            );

            const stored: StoredMessage[] = rows.map((row) => {
                const envelope = parseStoredMessageEnvelope(row.message_envelope, `${head.thread_id}/${row.seq}`);
                return { seq: Number(row.seq), envelope, message: envelope.message };
            });

            let resolveCard;
            if (head.analysis_id !== null) {
                resolveCard = createCardResolver(deps.pool, head.analysis_id);
            }
            const cortex = await contentToCortexMessages(stored, { resolveCard, resolveDetail });
            const uiMessages = cortexMessagesToConversationUI(cortex);
            // A genuine turn always contributes at least its user message. Keep a
            // defensive model-derived fallback so absence can never strand a NULL
            // envelope and make startup retry forever.
            const display =
                uiMessages.length > 0
                    ? uiMessages
                    : [
                          {
                              id: head.seq,
                              role: "user" as const,
                              parts: [{ type: "text" as const, text: "", state: "done" as const }],
                          },
                      ];
            const envelope = envelopeDisplayMessages(display);
            const result = await deps.pool.query(
                `UPDATE messages
                    SET display_envelope = $1::jsonb
                  WHERE thread_id = $2 AND seq = $3::bigint
                    AND display_envelope IS NULL`,
                [JSON.stringify(envelope), head.thread_id, head.seq],
            );
            migrated += result.rowCount ?? 0;
        }
    }
}
