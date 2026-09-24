/** The Postgres realization of the tool output store of the loop, over `cortex_tool_outputs`. */

import type { Pool } from "pg";

import { tryMutation, tryQuery } from "../lib/db-result.js";
import type { KeptToolOutput, ToolOutputStore } from "../loop/tool-output.js";

interface ToolOutputRow {
    readonly analysis_id: string;
    readonly ref: string;
    readonly tool_name: string;
    readonly tool_call_id: string;
    readonly thread_id: string | null;
    readonly content: string;
    readonly total_length: number;
}

function toKeptToolOutput(row: ToolOutputRow): KeptToolOutput {
    return {
        analysisId: row.analysis_id,
        ref: row.ref,
        toolName: row.tool_name,
        toolCallId: row.tool_call_id,
        ...(row.thread_id === null ? {} : { threadId: row.thread_id }),
        content: row.content,
        totalLength: row.total_length,
    };
}

export function createToolOutputStore(pool: Pool): ToolOutputStore {
    return {
        put: (output) =>
            tryMutation("toolOutputs.put", () =>
                pool.query(
                    // The update sets no `created_at`, thus the row keeps the time of its first put.
                    `INSERT INTO cortex_tool_outputs (analysis_id, ref, tool_name, tool_call_id, thread_id, content, total_length)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (analysis_id, ref) DO UPDATE SET
           tool_name = EXCLUDED.tool_name,
           tool_call_id = EXCLUDED.tool_call_id,
           thread_id = EXCLUDED.thread_id,
           content = EXCLUDED.content,
           total_length = EXCLUDED.total_length`,
                    [output.analysisId, output.ref, output.toolName, output.toolCallId, output.threadId ?? null, output.content, output.totalLength],
                ),
            ).map(() => undefined),
        get: (analysisId, ref) =>
            tryQuery("toolOutputs.get", () =>
                pool.query<ToolOutputRow>(
                    `SELECT analysis_id, ref, tool_name, tool_call_id, thread_id, content, total_length
         FROM cortex_tool_outputs
         WHERE analysis_id = $1 AND ref = $2`,
                    [analysisId, ref],
                ),
            ).map(({ rows }) => (rows[0] === undefined ? null : toKeptToolOutput(rows[0]))),
    };
}
