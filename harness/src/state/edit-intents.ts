/** The Postgres realization of the intent store of `edit_file`, over `cortex_edit_intents`. */

import { z } from "zod";

import type { Querier } from "./db.js";

import { tryMutation, tryQuery } from "../lib/db-result.js";
import type { EditFileOk, EditIntent, EditIntentStore } from "../tools/workspace/edit-file.js";
import { MUTATE_TOOL_NAMES, type WriteRecord } from "../tools/workspace/mutator.js";

const WriteRecordSchema: z.ZodType<WriteRecord> = z.object({
    analysisId: z.string(),
    threadId: z.string().optional(),
    path: z.string(),
    hash: z.string(),
    size: z.number(),
    toolName: z.enum(MUTATE_TOOL_NAMES),
    invocationId: z.string(),
});

const EditFileOkSchema: z.ZodType<EditFileOk> = z.object({
    status: z.literal("ok"),
    path: z.string(),
    replacements: z.number(),
    bytesWritten: z.number(),
    lines: z.array(z.number()).optional(),
    decision_record_noted: z.literal(true).optional(),
});

const EditIntentRowSchema = z.object({
    step_key: z.string(),
    analysis_id: z.string(),
    path: z.string(),
    hash_before: z.string(),
    hash_after: z.string(),
    result: EditFileOkSchema,
    call_record: z.array(WriteRecordSchema),
});

function toEditIntent(raw: unknown): EditIntent {
    const row = EditIntentRowSchema.parse(raw);
    return {
        key: row.step_key,
        analysisId: row.analysis_id,
        path: row.path,
        hashBefore: row.hash_before,
        hashAfter: row.hash_after,
        result: row.result,
        callRecord: row.call_record,
    };
}

export function createEditIntentStore(pool: Querier): EditIntentStore {
    return {
        put: (intent) =>
            tryMutation("editIntents.put", () =>
                pool.query(
                    // The update sets no `created_at`, thus the row keeps the time of its first put.
                    `INSERT INTO cortex_edit_intents (step_key, analysis_id, path, hash_before, hash_after, result, call_record)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (step_key) DO UPDATE SET
           analysis_id = EXCLUDED.analysis_id,
           path = EXCLUDED.path,
           hash_before = EXCLUDED.hash_before,
           hash_after = EXCLUDED.hash_after,
           result = EXCLUDED.result,
           call_record = EXCLUDED.call_record`,
                    [
                        intent.key,
                        intent.analysisId,
                        intent.path,
                        intent.hashBefore,
                        intent.hashAfter,
                        JSON.stringify(intent.result),
                        JSON.stringify(intent.callRecord),
                    ],
                ),
            ).map(() => undefined),
        get: (key) =>
            tryQuery("editIntents.get", async () => {
                const { rows } = await pool.query(
                    `SELECT step_key, analysis_id, path, hash_before, hash_after, result, call_record
         FROM cortex_edit_intents
         WHERE step_key = $1`,
                    [key],
                );
                return rows[0] === undefined ? null : toEditIntent(rows[0]);
            }),
    };
}
