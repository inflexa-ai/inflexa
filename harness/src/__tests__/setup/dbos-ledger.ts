/**
 * Seeding and counting for the durability engine's own system tables.
 *
 * Those tables live in the shared `dbos` schema — dropping a per-test cortex
 * schema takes nothing out of them — and they are partitioned only by unique
 * workflow ids. A seeder is therefore bound to one caller's `executor_id`
 * literal, stamped on every `workflow_status` row it writes: that literal is the
 * handle a file reclaims its own rows by, and reclaiming anything broader would
 * destroy another file's rows.
 *
 * The set of tables holding an `ON DELETE CASCADE` key to `workflow_status` is
 * hand-written here because the engine owns that schema and adds to it across
 * versions. `WORKFLOW_CASCADE_TABLES` is what a test pins against the live
 * constraints, and `CASCADE_INSERTS` is keyed by the same union, so a table
 * added to the list without an insert beside it is a type error rather than a
 * table nothing ever seeds.
 */

import type { Pool, QueryConfig } from "pg";

/**
 * The `dbos` tables that hold an `ON DELETE CASCADE` foreign key to
 * `workflow_status`, which is how deleting a status row reaches the bytes
 * hanging off it.
 */
export const WORKFLOW_CASCADE_TABLES = [
    "notifications",
    "operation_outputs",
    "streams",
    "workflow_events",
    "workflow_events_history",
    "workflow_inputs",
    "workflow_queue",
] as const;

export type WorkflowCascadeTable = (typeof WORKFLOW_CASCADE_TABLES)[number];

export type WorkflowTable = "workflow_status" | WorkflowCascadeTable;

/** `notifications` names its workflow reference `destination_uuid`; every other table uses `workflow_uuid`. */
function workflowIdColumn(table: WorkflowTable): string {
    return table === "notifications" ? "destination_uuid" : "workflow_uuid";
}

/**
 * One dependent row per cascading table. `label` only makes a seeded row
 * greppable back to the file that wrote it; nothing reads these values back.
 */
const CASCADE_INSERTS: Record<WorkflowCascadeTable, (workflowId: string, label: string) => QueryConfig> = {
    notifications: (workflowId, label) => ({
        // A topic is supplied rather than left NULL: the engine's insert trigger
        // builds its notify payload by concatenating the destination and the topic,
        // and a NULL topic makes the whole payload NULL.
        text: `INSERT INTO dbos.notifications (destination_uuid, topic, message)
               VALUES ($1, $2, '"message"')`,
        values: [workflowId, `${label}-topic`],
    }),
    operation_outputs: (workflowId, label) => ({
        text: `INSERT INTO dbos.operation_outputs (workflow_uuid, function_id, function_name, output)
               VALUES ($1, 0, $2, '"done"')`,
        values: [workflowId, `${label}-step`],
    }),
    streams: (workflowId) => ({
        text: `INSERT INTO dbos.streams (workflow_uuid, key, value, "offset")
               VALUES ($1, 'events', '"event"', 0)`,
        values: [workflowId],
    }),
    workflow_events: (workflowId, label) => ({
        text: `INSERT INTO dbos.workflow_events (workflow_uuid, key, value) VALUES ($1, $2, 'v')`,
        values: [workflowId, `${label}-key`],
    }),
    workflow_events_history: (workflowId, label) => ({
        text: `INSERT INTO dbos.workflow_events_history (workflow_uuid, function_id, key, value)
               VALUES ($1, 0, $2, 'v')`,
        values: [workflowId, `${label}-key`],
    }),
    workflow_inputs: (workflowId) => ({
        text: `INSERT INTO dbos.workflow_inputs (workflow_uuid, inputs) VALUES ($1, '[]')`,
        values: [workflowId],
    }),
    workflow_queue: (workflowId, label) => ({
        // `deduplication_id` is left NULL: the unique key it shares with `queue_name`
        // treats NULLs as distinct, so every seeded workflow can sit on the same queue
        // name without colliding.
        text: `INSERT INTO dbos.workflow_queue (queue_name, workflow_uuid) VALUES ($1, $2)`,
        values: [`${label}-queue`, workflowId],
    }),
};

export interface DbosLedgerSeederDeps {
    /** The rig pool; its `search_path` is irrelevant here, since every statement names `dbos` explicitly. */
    readonly pool: Pool;
    /**
     * Stamped on every `workflow_status` row this seeder writes and the stem of
     * every other literal it stamps. Must be unique to the calling file and must
     * not be the rig's own executor id, or the launched engine's recovery pass
     * claims the seeded PENDING rows.
     */
    readonly executorId: string;
    /**
     * The cascading tables to write a dependent row into. Defaults to all of them:
     * a caller asserting a post-purge zero per table needs every one of them
     * seeded, or the zero stands for an empty table rather than a reclamation.
     * Narrow it when the assertions read back only some.
     */
    readonly cascadeTables?: readonly WorkflowCascadeTable[];
}

export interface DbosLedgerSeeder {
    /** One `workflow_status` row, optionally parented, plus a row in each cascading table this seeder covers. */
    seedWorkflow(workflowId: string, parentId?: string): Promise<void>;
    /** Rows in one system table keyed to any of the given workflows. */
    countRows(table: WorkflowTable, workflowIds: readonly string[]): Promise<number>;
    /** Status rows for the given workflows. */
    countStatusRows(workflowIds: readonly string[]): Promise<number>;
    /** Every dependent row count for the given workflows, keyed by table. */
    countCascadeRows(workflowIds: readonly string[]): Promise<Record<string, number>>;
    /** Every seeded table set to the same count, for comparing a whole cascade at once. */
    cascadeRows(each: number): Record<string, number>;
}

/**
 * Bind seeding and counting to one file's pool and `executor_id` literal. Rows
 * are written directly rather than by running workflows, so a parent/child shape
 * and its dependent rows pin what a delete reaches without depending on a live
 * workflow's timing.
 */
export function createDbosLedgerSeeder(deps: DbosLedgerSeederDeps): DbosLedgerSeeder {
    const { pool, executorId } = deps;
    const cascadeTables = deps.cascadeTables ?? WORKFLOW_CASCADE_TABLES;

    const countRows = async (table: WorkflowTable, workflowIds: readonly string[]): Promise<number> => {
        const { rows } = await pool.query<{ n: number }>({
            // Neither a table nor a column name can be a bind parameter; both come from
            // the literal `WorkflowTable` union, so nothing caller-shaped reaches the SQL.
            text: `SELECT COUNT(*)::int AS n FROM dbos.${table} WHERE ${workflowIdColumn(table)} = ANY($1)`,
            values: [[...workflowIds]],
        });
        return rows[0]?.n ?? 0;
    };

    return {
        async seedWorkflow(workflowId: string, parentId?: string): Promise<void> {
            await pool.query({
                text: `INSERT INTO dbos.workflow_status (workflow_uuid, status, name, executor_id, parent_workflow_id)
                       VALUES ($1, 'PENDING', $2, $3, $4)`,
                values: [workflowId, `${executorId}-workflow`, executorId, parentId ?? null],
            });
            for (const table of cascadeTables) {
                await pool.query(CASCADE_INSERTS[table](workflowId, executorId));
            }
        },

        countRows,

        countStatusRows: (workflowIds) => countRows("workflow_status", workflowIds),

        async countCascadeRows(workflowIds: readonly string[]): Promise<Record<string, number>> {
            const counts: Record<string, number> = {};
            for (const table of cascadeTables) {
                counts[table] = await countRows(table, workflowIds);
            }
            return counts;
        },

        cascadeRows(each: number): Record<string, number> {
            const counts: Record<string, number> = {};
            for (const table of cascadeTables) {
                counts[table] = each;
            }
            return counts;
        },
    };
}
