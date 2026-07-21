/**
 * Workflow-shape tests for `execute_command`'s completed-step snapshot.
 *
 * `execute_command` is `executionMode: "workflow"`: its body runs unwrapped in
 * the DBOS workflow body, so anything it reads from the database is re-read on
 * every replay. Completion is monotonic, so a re-read is not merely wasteful —
 * it returns a strictly larger completed-set and gives the same run a different
 * lineage graph after a crash. These tests pin the two halves of the fix:
 *
 *  1. a replayed exec classifies against the set snapshotted by the ORIGINAL
 *     execution, even though the ledger has since gained a completed step; and
 *  2. an exec whose snapshot was unavailable replays as unavailable, even
 *     though the query would now succeed — the degradation is checkpointed, so
 *     the error path cannot smuggle the determinism hazard back in.
 *
 * Both use the replay pattern from `workflows/__tests__/dbos/workflow-replay.test.ts`:
 * an UNCONDITIONAL mid-body `cancelWorkflow(self)` (DBOS rejects a step
 * sequence that diverges between attempts) followed by `resumeWorkflow`. The
 * world is mutated between the two attempts through module-level wiring the
 * body re-reads, which is precisely what must NOT change the outcome.
 *
 * Registration window: see the same file's note — this module registers a
 * workflow at import time, so it bounces an already-launched engine (plain
 * `DBOS.shutdown()`, no deregister) to reopen the registration window and
 * relaunches in `beforeAll`.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { DBOS } from "@dbos-inc/dbos-sdk";
import { Pool } from "pg";

import { setupDbosForTests, type DbosTestRig } from "../../__tests__/setup/dbos.js";
import { createCapturingLogger, type CapturingLogger } from "../../__tests__/setup/logger.js";
import { durableStep } from "../../loop/run-step.js";
import { ProvenanceCollector } from "../../provenance/collector.js";
import type { SandboxClient } from "../../sandbox/client.js";
import type { ExecEmit, ExecResult, SandboxRef, SubmitExecBody } from "../../sandbox/types.js";
import { insertStepExecution, queryCompletedStepsByAnalysis, updateStepExecution } from "../../state/step-executions.js";
import { makeToolContext } from "../__fixtures__/tool-context.js";
import type { ToolContext } from "../define-tool.js";
import { createExecuteCommandTool } from "./execute-command.js";

if (DBOS.isInitialized()) {
    await DBOS.shutdown();
}

const ANALYSIS = "an-replay";
const RUN = "run-1";
const OWN_STEP = "S3";
/** Completed before the first attempt — admissible from the start. */
const EARLY_SIBLING = "S1";
/** Completed only BETWEEN the two attempts — must never become an edge. */
const LATE_SIBLING = "S2";

const MOUNT_ROOT = `/${ANALYSIS}`;

const SANDBOX: SandboxRef = {
    sandboxId: "sb-replay",
    host: "127.0.0.1",
    port: 8765,
    backend: "docker",
    callbackSecret: "secret",
};

/**
 * One data read plus one read under each sibling's directory. The data read is
 * the control: it is admissible whatever the snapshot says, so an empty input
 * list would prove the frame was never fed rather than that the gate held.
 */
function frameResult(execId: string): ExecResult {
    return {
        execId,
        exitCode: 0,
        stdout: "",
        stderr: "",
        durationMs: 5,
        timedOut: false,
        provenance: {
            disabled: false,
            reads: [
                { path: `${MOUNT_ROOT}/data/inputs/counts.csv`, layers: ["python"] },
                { path: `${MOUNT_ROOT}/runs/${RUN}/${EARLY_SIBLING}/output/early.csv`, layers: ["python"] },
                { path: `${MOUNT_ROOT}/runs/${RUN}/${LATE_SIBLING}/output/late.csv`, layers: ["python"] },
            ],
            writes: [{ path: `${MOUNT_ROOT}/runs/${RUN}/${OWN_STEP}/output/result.csv`, layers: ["python"] }],
            deletes: [],
        },
    };
}

function fakeSandboxClient(): SandboxClient {
    return {
        async createSandbox() {
            return SANDBOX;
        },
        async submitExec(_ref: SandboxRef, _body: SubmitExecBody) {},
        async awaitExec(_ref: SandboxRef, execId: string, _emit: ExecEmit, _deadlineMs: number) {
            return frameResult(execId);
        },
        async isAlive() {
            return true;
        },
        async teardown() {},
        async teardownById() {},
        async listManagedSandboxes() {
            return [];
        },
    };
}

/** Per-test wiring the mirror body re-reads on every attempt. */
interface Wiring {
    pool: Pool;
    collector: ProvenanceCollector;
    logger: CapturingLogger;
}

let wiring: Wiring | undefined;

/**
 * Mirror of a sandbox step's shape around one `execute_command` call: the tool
 * is built and driven inside the workflow body with `durableStep` as its
 * `runStep`, so its snapshot lands in the DBOS step cache exactly as it does in
 * `sandbox-step.ts`.
 *
 * The self-cancel is unconditional — DBOS rejects a replay whose step sequence
 * diverges from the original.
 */
const execMirror = DBOS.registerWorkflow(
    async (): Promise<{ inputs: { path: string; source: string }[] }> => {
        const active = wiring;
        if (!active) throw new Error("execMirror: wiring not set");

        const tool = createExecuteCommandTool({
            logger: active.logger,
            sandboxClient: fakeSandboxClient(),
            sandbox: SANDBOX,
            workflowId: DBOS.workflowID!,
            stepId: OWN_STEP,
            nextFunctionId: () => "fn1",
            deadlineMs: () => Date.now() + 60_000,
            defaultCwd: `${MOUNT_ROOT}/runs/${RUN}/${OWN_STEP}`,
            lineageCollector: active.collector,
            mountRoot: MOUNT_ROOT,
            pool: active.pool,
            analysisId: ANALYSIS,
        });

        const ctx: ToolContext = { ...makeToolContext().ctx, runStep: durableStep };
        await tool.execute({ command: ["python", "scripts/run.py"] }, ctx);

        await DBOS.cancelWorkflow(DBOS.workflowID!);

        // Runs only on the resumed attempt; gives the replay something to move
        // forward into after the cached steps return.
        await DBOS.runStep(async () => "tail-ok", { name: "exec-mirror.tail" });

        return { inputs: active.collector.getTrackedInputs().map((ref) => ({ path: ref.path, source: ref.source })) };
    },
    { name: "execute-command-snapshot-mirror" },
);

/**
 * Poll the durable status rather than awaiting the handle — a rejected
 * workflow leaves a second reject-chain floating that Bun reports as its own
 * failure (see `workflow-replay.test.ts`).
 */
async function waitForTerminal(workflowId: string, timeoutMs = 10_000): Promise<string | undefined> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const status = await DBOS.getWorkflowStatus(workflowId);
        if (status && (status.status === "SUCCESS" || status.status === "ERROR" || status.status === "CANCELLED")) {
            return status.status;
        }
        await new Promise((r) => setTimeout(r, 25));
    }
    return undefined;
}

async function markCompleted(pool: Pool, stepId: string): Promise<void> {
    (await insertStepExecution(pool, { runId: RUN, stepId, analysisId: ANALYSIS, wave: 0, agentId: "scientific-executor" }))._unsafeUnwrap();
    (await updateStepExecution(pool, RUN, stepId, { status: "completed", durationMs: 1 }))._unsafeUnwrap();
}

/** The checkpointed outputs of every durable step this workflow recorded. */
async function checkpointedStepOutputs(pool: Pool, workflowId: string): Promise<{ name: string; output: string }[]> {
    const rows = await pool.query({
        text: `SELECT function_name, output FROM dbos.operation_outputs WHERE workflow_uuid = $1 ORDER BY function_id`,
        values: [workflowId],
    });
    return rows.rows.map((row: Record<string, unknown>) => ({ name: String(row.function_name ?? ""), output: String(row.output ?? "") }));
}

/**
 * A pool that reaches the server but cannot see the ledger — the snapshot query
 * fails the way a real read failure does, without depending on an unreachable
 * host. `cortex_step_executions` lives in the rig's per-test schema, which is
 * not on this connection's `search_path`.
 */
function makeLedgerBlindPool(): Pool {
    const pool = new Pool({
        host: process.env.DB_PG_HOST,
        port: Number(process.env.DB_PG_PORT ?? 5432),
        user: process.env.DB_PG_USER,
        password: process.env.DB_PG_PASSWORD,
        database: process.env.DB_PG_NAME,
        options: "-c search_path=pg_temp",
    });
    pool.on("error", () => {});
    return pool;
}

let rig: DbosTestRig;
let blindPool: Pool | undefined;

beforeAll(async () => {
    rig = await setupDbosForTests("execute_command_replay");
    if (!DBOS.isInitialized()) await DBOS.launch();
});

afterAll(async () => {
    if (blindPool) await blindPool.end();
    if (rig) await rig.drop();
});

describe("execute_command completed-step snapshot under replay", () => {
    it("a replayed exec classifies against the originally snapshotted set, not a re-query", async () => {
        await markCompleted(rig.pool, EARLY_SIBLING);

        const collector = new ProvenanceCollector({ stepId: OWN_STEP, runId: RUN });
        wiring = { pool: rig.pool, collector, logger: createCapturingLogger() };

        const wfId = rig.nextWorkflowId("exec-snapshot-");
        const handle = await DBOS.startWorkflow(execMirror, { workflowID: wfId })();
        handle.getResult().catch(() => {});
        expect(await waitForTerminal(wfId)).toBe("CANCELLED");

        // The world moves on: the late sibling finishes between the original
        // execution and the replay.
        await markCompleted(rig.pool, LATE_SIBLING);
        const nowCompleted = (await queryCompletedStepsByAnalysis(rig.pool, ANALYSIS))._unsafeUnwrap().map((p) => p.stepId);
        expect(nowCompleted.sort()).toEqual([EARLY_SIBLING, LATE_SIBLING]);

        const resumed = await DBOS.resumeWorkflow<{ inputs: { path: string; source: string }[] }>(wfId);
        const result = await resumed.getResult();

        const paths = result.inputs.map((i) => i.path).sort();
        expect(paths).toEqual([`${MOUNT_ROOT}/data/inputs/counts.csv`, `${MOUNT_ROOT}/runs/${RUN}/${EARLY_SIBLING}/output/early.csv`]);
        // The load-bearing assertion: a re-queried snapshot would have admitted
        // the late sibling on the replayed attempt.
        expect(paths.some((p) => p.includes(LATE_SIBLING))).toBe(false);
        expect(collector.getTrackedInputs().map((r) => r.path)).toEqual(paths);
    });

    it("a snapshot that was unavailable replays as unavailable", async () => {
        await markCompleted(rig.pool, EARLY_SIBLING);

        blindPool ??= makeLedgerBlindPool();
        const collector = new ProvenanceCollector({ stepId: OWN_STEP, runId: RUN });
        const logger = createCapturingLogger();
        wiring = { pool: blindPool, collector, logger };

        const wfId = rig.nextWorkflowId("exec-degraded-");
        const handle = await DBOS.startWorkflow(execMirror, { workflowID: wfId })();
        handle.getResult().catch(() => {});
        expect(await waitForTerminal(wfId)).toBe("CANCELLED");

        // The failure is narrated at error level, through the injected seam.
        const errors = logger.records.filter((r) => r.level === "error");
        expect(errors.length).toBeGreaterThanOrEqual(1);
        expect(errors[0]!.msg).toContain("[execute_command]");
        expect(errors[0]!.fields.analysisId).toBe(ANALYSIS);

        // ...and the degraded outcome is itself a checkpoint, which is what
        // stops the replay from re-running the query and succeeding.
        const steps = await checkpointedStepOutputs(rig.pool, wfId);
        const snapshotStep = steps.find((s) => s.name.includes("lineage.completed-steps"));
        expect(snapshotStep).toBeDefined();
        expect(snapshotStep!.output).toContain('"ok":false');

        // The ledger is readable again on the replayed attempt.
        wiring = { pool: rig.pool, collector, logger };
        const readable = (await queryCompletedStepsByAnalysis(rig.pool, ANALYSIS))._unsafeUnwrap();
        expect(readable.length).toBeGreaterThan(0);

        const resumed = await DBOS.resumeWorkflow<{ inputs: { path: string; source: string }[] }>(wfId);
        const result = await resumed.getResult();

        // Still degraded: no producing-step read is admissible, and only the
        // data read survives.
        expect(result.inputs.map((i) => i.path)).toEqual([`${MOUNT_ROOT}/data/inputs/counts.csv`]);
    });
});
