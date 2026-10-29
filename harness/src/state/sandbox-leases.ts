/**
 * The rows of `cortex_sandbox_leases`: one row for each generation of a sandbox lease and its lease workflow. The
 * sandbox module writes them, and the reconciler and the purge read them.
 *
 * The grant is the one place that compares a request against the budget. It runs under one transaction-scoped
 * advisory lock, thus two grants never read the same free capacity.
 */

import type { ResultAsync } from "neverthrow";
import { z } from "zod";

import { ResourceSpecSchema, type MachineBudget, type ResourceSpec } from "../config/resource-limits.js";
import type { WorkKind } from "../contracts/chat-parts.js";
import { tryMutation, tryQuery, withTransaction, type Connectable, type DbError, type TransactionQuerier } from "../lib/db-result.js";
import type { Querier } from "./db.js";
import { PersistedSandboxRefSchema, type PersistedSandboxRef } from "./schema.js";

export type LeaseState = "requested" | "granted" | "released";

/** One generation of a lease, as its row records it. */
export type LeaseRecord = {
    readonly leaseWorkflowId: string;
    readonly leaseKey: string;
    readonly generation: number;
    readonly analysisId: string;
    readonly ownerWorkflowId: string;
    readonly workKind: WorkKind;
    readonly workId: string;
    readonly requested: ResourceSpec;
    readonly granted?: ResourceSpec;
    readonly state: LeaseState;
    readonly releaseReason?: string;
    readonly machine?: PersistedSandboxRef;
    readonly machineGeneration: number;
    /** The random value of the exec ids of the lease. No machine receives it, thus a command cannot derive a later exec id. */
    readonly execSalt: string;
};

/** What a request writes. The row starts in `requested`, and the time of the insert orders the queue. */
export type LeaseRequest = Omit<LeaseRecord, "granted" | "state" | "releaseReason" | "machine" | "machineGeneration" | "execSalt">;

const LeaseRowSchema = z.object({
    lease_workflow_id: z.string(),
    lease_key: z.string(),
    generation: z.number(),
    analysis_id: z.string(),
    owner_workflow_id: z.string(),
    work_kind: z.enum(["turn", "run", "profile"]),
    work_id: z.string(),
    requested: ResourceSpecSchema,
    granted: ResourceSpecSchema.nullable(),
    state: z.enum(["requested", "granted", "released"]),
    release_reason: z.string().nullable(),
    machine: PersistedSandboxRefSchema.nullable(),
    machine_generation: z.number(),
    exec_salt: z.string(),
});

const COLUMNS =
    "lease_workflow_id, lease_key, generation, analysis_id, owner_workflow_id, work_kind, work_id, requested, granted, state, release_reason, machine, machine_generation, exec_salt";

/** The one key of the advisory lock of the grant. Any constant works; it only has to be the same for each grant. */
const GRANT_LOCK_KEY = 74_210_031;

function recordOf(row: unknown): LeaseRecord {
    const parsed = LeaseRowSchema.parse(row);
    return {
        leaseWorkflowId: parsed.lease_workflow_id,
        leaseKey: parsed.lease_key,
        generation: parsed.generation,
        analysisId: parsed.analysis_id,
        ownerWorkflowId: parsed.owner_workflow_id,
        workKind: parsed.work_kind,
        workId: parsed.work_id,
        requested: parsed.requested,
        granted: parsed.granted ?? undefined,
        state: parsed.state,
        releaseReason: parsed.release_reason ?? undefined,
        machine: parsed.machine ?? undefined,
        machineGeneration: parsed.machine_generation,
        execSalt: parsed.exec_salt,
    };
}

/**
 * Write the request of a new generation. A key that holds a lease that is not released keeps it: the insert does
 * nothing, and the caller reads the active lease again.
 */
export function requestLease(pool: Querier, request: LeaseRequest): ResultAsync<void, DbError> {
    return tryMutation("sandboxLeases.request", async () => {
        await pool.query({
            text: `INSERT INTO cortex_sandbox_leases
                (lease_workflow_id, lease_key, generation, analysis_id, owner_workflow_id, work_kind, work_id, requested, state)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, 'requested')
                ON CONFLICT DO NOTHING`,
            values: [
                request.leaseWorkflowId,
                request.leaseKey,
                request.generation,
                request.analysisId,
                request.ownerWorkflowId,
                request.workKind,
                request.workId,
                JSON.stringify(request.requested),
            ],
        });
    });
}

/** The lease of the key that is not released, or `undefined`. */
export function activeLease(pool: Querier, leaseKey: string): ResultAsync<LeaseRecord | undefined, DbError> {
    return tryQuery("sandboxLeases.active", async () => {
        const { rows } = await pool.query({
            text: `SELECT ${COLUMNS} FROM cortex_sandbox_leases WHERE lease_key = $1 AND state <> 'released'`,
            values: [leaseKey],
        });
        return rows.length === 0 ? undefined : recordOf(rows[0]);
    });
}

export function readLease(pool: Querier, leaseWorkflowId: string): ResultAsync<LeaseRecord | undefined, DbError> {
    return tryQuery("sandboxLeases.read", async () => {
        const { rows } = await pool.query({
            text: `SELECT ${COLUMNS} FROM cortex_sandbox_leases WHERE lease_workflow_id = $1`,
            values: [leaseWorkflowId],
        });
        return rows.length === 0 ? undefined : recordOf(rows[0]);
    });
}

/** The highest generation of the key, or 0 for a key with no lease. */
export function latestGeneration(pool: Querier, leaseKey: string): ResultAsync<number, DbError> {
    return tryQuery("sandboxLeases.latestGeneration", async () => {
        const { rows } = await pool.query<{ generation: number | null }>({
            text: `SELECT max(generation) AS generation FROM cortex_sandbox_leases WHERE lease_key = $1`,
            values: [leaseKey],
        });
        return rows[0]?.generation ?? 0;
    });
}

export type GrantOutcome = { readonly kind: "granted"; readonly size: ResourceSpec } | { readonly kind: "waiting" } | { readonly kind: "released" };

function fits(budget: MachineBudget, held: { cpu: number; memoryGb: number }, request: ResourceSpec): boolean {
    return held.cpu + request.cpu <= budget.cpu && held.memoryGb + request.memoryGb <= budget.memoryGb;
}

function grantIn(client: TransactionQuerier, leaseWorkflowId: string, budget: MachineBudget | undefined): ResultAsync<GrantOutcome, DbError> {
    return tryMutation("sandboxLeases.grant", async (): Promise<GrantOutcome> => {
        await client.query({ text: "SELECT pg_advisory_xact_lock($1)", values: [GRANT_LOCK_KEY] });
        const own = await client.query({ text: `SELECT ${COLUMNS} FROM cortex_sandbox_leases WHERE lease_workflow_id = $1`, values: [leaseWorkflowId] });
        const lease = own.rows.length === 0 ? undefined : recordOf(own.rows[0]);
        if (lease === undefined || lease.state === "released") return { kind: "released" };
        if (lease.state === "granted") return { kind: "granted", size: lease.granted ?? lease.requested };
        if (budget !== undefined) {
            // The strict order of the requests: only the oldest waiting request can take a grant.
            const head = await client.query<{ lease_workflow_id: string }>(
                `SELECT lease_workflow_id FROM cortex_sandbox_leases WHERE state = 'requested' ORDER BY requested_at, lease_workflow_id LIMIT 1`,
            );
            if (head.rows[0]?.lease_workflow_id !== leaseWorkflowId) return { kind: "waiting" };
            const sums = await client.query<{ cpu: string | null; memory_gb: string | null }>(
                `SELECT sum((granted->>'cpu')::numeric) AS cpu, sum((granted->>'memoryGb')::numeric) AS memory_gb
                 FROM cortex_sandbox_leases WHERE state = 'granted'`,
            );
            const held = { cpu: Number(sums.rows[0]?.cpu ?? 0), memoryGb: Number(sums.rows[0]?.memory_gb ?? 0) };
            if (!fits(budget, held, lease.requested)) return { kind: "waiting" };
        }
        await client.query({
            text: `UPDATE cortex_sandbox_leases SET state = 'granted', granted = requested, granted_at = now(), last_used_at = now()
                   WHERE lease_workflow_id = $1`,
            values: [leaseWorkflowId],
        });
        return { kind: "granted", size: lease.requested };
    });
}

/** Grant the lease when it is the oldest waiting request and it fits the budget. With no budget, grant at once. */
export function tryGrant(pool: Connectable, leaseWorkflowId: string, budget: MachineBudget | undefined): ResultAsync<GrantOutcome, DbError> {
    return withTransaction(pool, "sandboxLeases.tryGrant", (client) => grantIn(client, leaseWorkflowId, budget));
}

/** The lease workflow of the oldest waiting request, the next one that a free capacity can wake. */
export function oldestWaiting(pool: Querier): ResultAsync<string | undefined, DbError> {
    return tryQuery("sandboxLeases.oldestWaiting", async () => {
        const { rows } = await pool.query<{ lease_workflow_id: string }>(
            `SELECT lease_workflow_id FROM cortex_sandbox_leases WHERE state = 'requested' ORDER BY requested_at, lease_workflow_id LIMIT 1`,
        );
        return rows[0]?.lease_workflow_id;
    });
}

/** Record the machine of a machine generation. */
export function setMachine(pool: Querier, leaseWorkflowId: string, machine: PersistedSandboxRef, machineGeneration: number): ResultAsync<void, DbError> {
    return tryMutation("sandboxLeases.setMachine", async () => {
        await pool.query({
            text: `UPDATE cortex_sandbox_leases SET machine = $2::jsonb, machine_generation = $3, last_used_at = now()
                   WHERE lease_workflow_id = $1 AND state = 'granted'`,
            values: [leaseWorkflowId, JSON.stringify(machine), machineGeneration],
        });
    });
}

/**
 * Clear the machine of one machine generation, and give the machine that the row held. A row whose generation
 * moved on keeps its machine, thus a late report of an old death clears nothing.
 */
export function clearMachine(pool: Querier, leaseWorkflowId: string, machineGeneration: number): ResultAsync<PersistedSandboxRef | undefined, DbError> {
    return tryMutation("sandboxLeases.clearMachine", async () => {
        const { rows } = await pool.query({
            text: `WITH old AS (
                       SELECT lease_workflow_id, machine FROM cortex_sandbox_leases
                       WHERE lease_workflow_id = $1 AND machine_generation = $2 AND machine IS NOT NULL
                       FOR UPDATE
                   )
                   UPDATE cortex_sandbox_leases AS l SET machine = NULL FROM old
                   WHERE l.lease_workflow_id = old.lease_workflow_id
                   RETURNING old.machine`,
            values: [leaseWorkflowId, machineGeneration],
        });
        return rows.length === 0 ? undefined : PersistedSandboxRefSchema.parse(rows[0]?.machine);
    });
}

/**
 * Clear the machine of an idle lease: no exec used the lease for `idleMs`. An exec writes `last_used_at` before it
 * submits, under the same row lock, thus an exec that starts can never lose its machine to this clear.
 */
export function clearIdleMachine(
    pool: Querier,
    leaseWorkflowId: string,
    machineGeneration: number,
    idleMs: number,
): ResultAsync<PersistedSandboxRef | undefined, DbError> {
    return tryMutation("sandboxLeases.clearIdleMachine", async () => {
        const { rows } = await pool.query({
            text: `WITH old AS (
                       SELECT lease_workflow_id, machine FROM cortex_sandbox_leases
                       WHERE lease_workflow_id = $1 AND machine_generation = $2 AND machine IS NOT NULL
                         AND last_used_at < now() - make_interval(secs => $3::double precision / 1000)
                       FOR UPDATE
                   )
                   UPDATE cortex_sandbox_leases AS l SET machine = NULL FROM old
                   WHERE l.lease_workflow_id = old.lease_workflow_id
                   RETURNING old.machine`,
            values: [leaseWorkflowId, machineGeneration, idleMs],
        });
        return rows.length === 0 ? undefined : PersistedSandboxRefSchema.parse(rows[0]?.machine);
    });
}

/** Mark the lease used now, and give its machine. A lease that is not granted gives `undefined`. */
export function touchLease(
    pool: Querier,
    leaseWorkflowId: string,
): ResultAsync<{ machine?: PersistedSandboxRef; machineGeneration: number } | undefined, DbError> {
    return tryMutation("sandboxLeases.touch", async () => {
        const { rows } = await pool.query({
            text: `UPDATE cortex_sandbox_leases SET last_used_at = now()
                   WHERE lease_workflow_id = $1 AND state = 'granted'
                   RETURNING machine, machine_generation`,
            values: [leaseWorkflowId],
        });
        if (rows.length === 0) return undefined;
        const row = z.object({ machine: PersistedSandboxRefSchema.nullable(), machine_generation: z.number() }).parse(rows[0]);
        return { machine: row.machine ?? undefined, machineGeneration: row.machine_generation };
    });
}

/** Mark the lease released, and give the machine that it still held. A second release gives `undefined`. */
export function releaseLease(pool: Querier, leaseWorkflowId: string, reason: string): ResultAsync<{ machine?: PersistedSandboxRef } | undefined, DbError> {
    return tryMutation("sandboxLeases.release", async () => {
        const { rows } = await pool.query({
            text: `WITH old AS (
                       SELECT lease_workflow_id, machine FROM cortex_sandbox_leases
                       WHERE lease_workflow_id = $1 AND state <> 'released'
                       FOR UPDATE
                   )
                   UPDATE cortex_sandbox_leases AS l SET state = 'released', release_reason = $2, released_at = now(), machine = NULL
                   FROM old WHERE l.lease_workflow_id = old.lease_workflow_id
                   RETURNING old.machine`,
            values: [leaseWorkflowId, reason],
        });
        if (rows.length === 0) return undefined;
        const machine = PersistedSandboxRefSchema.nullable().parse(rows[0]?.machine);
        return { machine: machine ?? undefined };
    });
}

/** Each lease that is not released, for the sweep of the reconciler. */
export function openLeases(pool: Querier): ResultAsync<LeaseRecord[], DbError> {
    return tryQuery("sandboxLeases.open", async () => {
        const { rows } = await pool.query(`SELECT ${COLUMNS} FROM cortex_sandbox_leases WHERE state <> 'released'`);
        return rows.map(recordOf);
    });
}
