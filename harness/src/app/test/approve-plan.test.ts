// oxlint-disable-next-line eslint-js/no-restricted-syntax -- the assertion is about formatted date and clock text, whose shape is a pattern
const DATE_OR_CLOCK_TEXT = /\d{4}-\d{2}-\d{2}|\d{2}:\d{2}/;

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { errAsync, okAsync } from "neverthrow";
import type { Pool } from "pg";

import { type Connectable } from "../../lib/db-result.js";
import { presentFirst } from "../../lib/present.js";
import type { Querier } from "../../state/db.js";

import { createCapturingLogger } from "../../__tests__/setup/logger.js";
import { withSchema } from "../../__tests__/setup/postgres.js";
import { makeLocalAuth } from "../../auth/local-auth-context.js";
import type { AuthorizeRunInput, RunAuthorizer } from "../../execution/run-authorizer.js";
import type { RunLauncher } from "../../execution/run-launcher.js";
import { storedMessagesToChat } from "../../memory/conversation-display-replay.js";
import { createThreadHistory } from "../../memory/thread-history.js";
import { createThreadStore } from "../../memory/thread-store.js";
import type { ProvenanceSeam, SessionProvenanceEvent } from "../../provenance/seam.js";
import { insertRun, updateRunStatus, upsertAnalysis, upsertPlan } from "../../state/index.js";
import { approvePlan, type ApprovePlanDeps } from "../approve-plan.js";

const ANALYSIS_ID = "analysis-approve-1";
const OTHER_ANALYSIS_ID = "analysis-approve-2";
const THREAD_ID = "thread-approve-1";
const PLAN_ID = "pln-0000000a";
const NEWER_PLAN_ID = "pln-0000000b";
const IDENTITY = { user: "person-1" };

function step(id: string) {
    return {
        id,
        name: `Step ${id}`,
        track: "test",
        step_type: "analysis",
        question: `do ${id}`,
        acceptance_criteria: ["completes"],
        depends_on: [],
        agent: "bulk-transcriptomics-agent",
        resources: { cpu: 1, memoryGb: 4 },
        maxSteps: 30,
    };
}

const plan = { title: "Differential expression", analytical_narrative: "test plan", steps: [step("step-a")], created_at: "2026-01-01T00:00:00Z" };

let pool: Pool;
let drop: () => Promise<void>;

beforeEach(async () => {
    ({ pool, drop } = await withSchema("approve_plan"));
    (await upsertAnalysis(pool, ANALYSIS_ID, null))._unsafeUnwrap();
    (await upsertAnalysis(pool, OTHER_ANALYSIS_ID, null))._unsafeUnwrap();
    (await createThreadStore(pool).createThread({ threadId: THREAD_ID, analysisId: ANALYSIS_ID }))._unsafeUnwrap();
    (await upsertPlan(pool, { planId: PLAN_ID, analysisId: ANALYSIS_ID, plan }))._unsafeUnwrap();
});

afterEach(async () => {
    await drop();
});

/** The doubles of the approval: a launcher that notes when it was called, an authorizer that notes its input, and a provenance sink that notes its events. */
function doubles(over: { launchFails?: boolean } = {}) {
    const launches: Array<{ workflowId: string; atMs: number }> = [];
    const authorizations: AuthorizeRunInput[] = [];
    const events: SessionProvenanceEvent[] = [];
    const runLauncher: RunLauncher = {
        launch: async (_workflow, options) => {
            if (over.launchFails) throw new Error("launch boom");
            launches.push({ workflowId: options.workflowId, atMs: Date.now() });
        },
    };
    const runAuthorizer: RunAuthorizer = {
        authorize: (input) => {
            authorizations.push(input);
            return okAsync({
                runSession: {
                    identity: { user: "u-1" },
                    scope: { kind: "analysis", analysisId: ANALYSIS_ID },
                    provenance: { agentId: "approvePlan", callPath: ["approvePlan"] },
                    runFrame: { runId: "run-approve" },
                    auth: makeLocalAuth(),
                },
                ownsMandate: true,
            });
        },
        revoke: () => okAsync(undefined),
        revokeByJti: () => okAsync(undefined),
    };
    const provenance: ProvenanceSeam = { emitSessionEvent: (event) => events.push(event) };
    return { launches, authorizations, events, runLauncher, runAuthorizer, provenance };
}

function depsOf(d: ReturnType<typeof doubles>, over: Partial<ApprovePlanDeps> = {}): ApprovePlanDeps {
    return {
        pool,
        executeAnalysisWorkflow: async () => {
            throw new Error("the launcher starts the workflow");
        },
        runAuthorizer: d.runAuthorizer,
        runLauncher: d.runLauncher,
        provenance: d.provenance,
        ...over,
    };
}

const auth = makeLocalAuth();
const input = ({ newestRunId = null, ...over }: Partial<Parameters<typeof approvePlan>[1]> = {}): Parameters<typeof approvePlan>[1] => ({
    analysisId: ANALYSIS_ID,
    threadId: THREAD_ID,
    planId: PLAN_ID,
    newestRunId,
    identity: IDENTITY,
    auth,
    ...over,
});

async function runRows(): Promise<Array<{ run_id: string; thread_id: string | null; status: string }>> {
    const { rows } = await pool.query<{ run_id: string; thread_id: string | null; status: string }>(
        "SELECT run_id, thread_id, status FROM cortex_runs ORDER BY started_at, run_id",
    );
    return rows;
}

async function threadRowCount(): Promise<number> {
    const { rows } = await pool.query<{ n: number }>("SELECT count(*)::int AS n FROM messages WHERE thread_id = $1", [THREAD_ID]);
    return rows[0]?.n ?? 0;
}

describe("approvePlan", () => {
    it("starts the run on the thread with no model call, and gives the display message of the record", async () => {
        const d = doubles();

        const approval = (await approvePlan(depsOf(d), input()))._unsafeUnwrap();

        expect(approval).toMatchObject({ planId: PLAN_ID, started: true });
        expect(d.launches.map((launch) => launch.workflowId)).toEqual([approval.runId]);
        expect(await runRows()).toEqual([{ run_id: approval.runId, thread_id: THREAD_ID, status: "running" }]);
        expect(approval.message?.role).toBe("system");
        expect(approval.message?.parts.map((part) => part.type)).toEqual(["data-plan-approval", "data-run-card"]);
    });

    it("runs the approval under the session of the host with the provenance plan-approval", async () => {
        const d = doubles();

        (await approvePlan(depsOf(d), input()))._unsafeUnwrap();

        expect(d.authorizations).toHaveLength(1);
        expect(presentFirst(d.authorizations).auth).toBe(auth);
        expect(presentFirst(d.authorizations).scope).toEqual({ kind: "analysis", analysisId: ANALYSIS_ID, threadId: THREAD_ID });
        expect(presentFirst(d.authorizations).provenance).toEqual({ agentId: "plan-approval", callPath: ["plan-approval"] });
    });

    it("emits one approve-plan event whose time is not later than the launch, and the part carries the same instant", async () => {
        const d = doubles();

        const approval = (await approvePlan(depsOf(d), input()))._unsafeUnwrap();

        expect(d.events).toHaveLength(1);
        const event = presentFirst(d.events);
        expect(event).toMatchObject({ type: "approve-plan", analysisId: ANALYSIS_ID, threadId: THREAD_ID, planId: PLAN_ID, runId: approval.runId });
        if (event.type !== "approve-plan") throw new Error("expected the approve-plan event");
        const atMs = event.atMs;
        expect(atMs).toBeLessThanOrEqual(presentFirst(d.launches).atMs);
        const approvalMessage = approval.message;
        if (approvalMessage === null) throw new Error("the approval carries no message");
        const part = approvalMessage.parts[0];
        expect(part).toEqual({ type: "data-plan-approval", planId: PLAN_ID, runId: approval.runId, approvedAt: new Date(atMs).toISOString() });
    });

    it("tells the next turn the record text with the ids and no time", async () => {
        const d = doubles();

        const approval = (await approvePlan(depsOf(d), input()))._unsafeUnwrap();

        const history = (await createThreadHistory(pool).loadRecent(THREAD_ID))._unsafeUnwrap();
        expect(history).toHaveLength(1);
        expect(presentFirst(history).role).toBe("user");
        expect(JSON.stringify(presentFirst(history).content)).toContain(`The person approved plan ${PLAN_ID}. Run ${approval.runId} started.`);
        expect(DATE_OR_CLOCK_TEXT.test(JSON.stringify(presentFirst(history).content))).toBe(false);
    });

    it("shows the approval and the run card in the transcript, and the result message equals the transcript message but for the row time", async () => {
        const d = doubles();

        const approval = (await approvePlan(depsOf(d), input()))._unsafeUnwrap();

        const transcript = storedMessagesToChat((await createThreadHistory(pool).loadAll(THREAD_ID))._unsafeUnwrap().flat());
        expect(transcript).toHaveLength(1);
        const { createdAt, ...rest } = presentFirst(transcript);
        expect(createdAt).toBeDefined();
        expect(approval.message).toEqual(rest);
        expect(rest.parts).toMatchObject([
            { type: "data-plan-approval", planId: PLAN_ID, runId: approval.runId },
            { type: "data-run-card", runId: approval.runId, planId: PLAN_ID, title: "Differential expression", stepCount: 1 },
        ]);
    });

    it("refuses a replaced plan with the newest plan that names it as its parent, and writes nothing", async () => {
        (await upsertPlan(pool, { planId: NEWER_PLAN_ID, analysisId: ANALYSIS_ID, plan, parentPlanId: PLAN_ID }))._unsafeUnwrap();
        const d = doubles();

        const refusal = (await approvePlan(depsOf(d), input()))._unsafeUnwrapErr();

        expect(refusal).toEqual({ type: "superseded", supersededBy: NEWER_PLAN_ID });
        expect(await runRows()).toEqual([]);
        expect(await threadRowCount()).toBe(0);
        expect(d.events).toEqual([]);
    });

    it("refuses a plan of another analysis and an unknown plan with plan_not_found", async () => {
        (await upsertPlan(pool, { planId: "pln-0000000c", analysisId: OTHER_ANALYSIS_ID, plan }))._unsafeUnwrap();
        const d = doubles();

        const foreign = (await approvePlan(depsOf(d), input({ planId: "pln-0000000c" })))._unsafeUnwrapErr();
        const unknown = (await approvePlan(depsOf(d), input({ planId: "pln-0000000d" })))._unsafeUnwrapErr();

        expect(foreign).toEqual({ type: "plan_not_found", planId: "pln-0000000c" });
        expect(unknown).toEqual({ type: "plan_not_found", planId: "pln-0000000d" });
        expect(await runRows()).toEqual([]);
    });

    it("refuses an archived thread, an unknown thread, and a thread of another analysis with thread_not_found", async () => {
        const store = createThreadStore(pool);
        (await store.createThread({ threadId: "thread-archived", analysisId: ANALYSIS_ID }))._unsafeUnwrap();
        (await store.archiveThread("thread-archived"))._unsafeUnwrap();
        (await store.createThread({ threadId: "thread-foreign", analysisId: OTHER_ANALYSIS_ID }))._unsafeUnwrap();
        const d = doubles();

        for (const threadId of ["thread-archived", "thread-missing", "thread-foreign"]) {
            expect((await approvePlan(depsOf(d), input({ threadId })))._unsafeUnwrapErr()).toEqual({ type: "thread_not_found" });
        }
        expect(await runRows()).toEqual([]);
        expect(d.events).toEqual([]);
    });

    it("records nothing for a plan with an active run, and gives that run with started false", async () => {
        (
            await insertRun(pool, { runId: "r-active", analysisId: ANALYSIS_ID, threadId: null, workflowName: "executeAnalysis", planId: PLAN_ID })
        )._unsafeUnwrap();
        const d = doubles();

        const approval = (await approvePlan(depsOf(d), input({ newestRunId: "r-active" })))._unsafeUnwrap();

        expect(approval).toEqual({ planId: PLAN_ID, runId: "r-active", started: false, message: null });
        expect(await threadRowCount()).toBe(0);
        expect(d.events).toEqual([]);
        expect(d.launches).toEqual([]);
    });

    it("records nothing for a stale view of a plan whose run ended, and starts no run", async () => {
        (
            await insertRun(pool, { runId: "r-ended", analysisId: ANALYSIS_ID, threadId: null, workflowName: "executeAnalysis", planId: PLAN_ID })
        )._unsafeUnwrap();
        (await updateRunStatus(pool, "r-ended", "completed"))._unsafeUnwrap();
        const d = doubles();

        const approval = (await approvePlan(depsOf(d), input({ newestRunId: null })))._unsafeUnwrap();

        expect(approval).toEqual({ planId: PLAN_ID, runId: "r-ended", started: false, message: null });
        expect((await runRows()).map((row) => row.run_id)).toEqual(["r-ended"]);
        expect(await threadRowCount()).toBe(0);
        expect(d.events).toEqual([]);
        expect(d.launches).toEqual([]);
    });

    it("runs the plan again when the view shows the newest run", async () => {
        (
            await insertRun(pool, { runId: "r-ended", analysisId: ANALYSIS_ID, threadId: null, workflowName: "executeAnalysis", planId: PLAN_ID })
        )._unsafeUnwrap();
        (await updateRunStatus(pool, "r-ended", "completed"))._unsafeUnwrap();
        const d = doubles();

        const approval = (await approvePlan(depsOf(d), input({ newestRunId: "r-ended" })))._unsafeUnwrap();

        expect(approval.started).toBe(true);
        expect(approval.runId).not.toBe("r-ended");
        expect(approval.message?.parts.map((part) => part.type)).toEqual(["data-plan-approval", "data-run-card"]);
        expect(d.launches.map((launch) => launch.workflowId)).toEqual([approval.runId]);
    });

    it("refuses a view of a run that the plan does not have with run_not_found", async () => {
        const d = doubles();

        const refusal = (await approvePlan(depsOf(d), input({ newestRunId: "r-missing" })))._unsafeUnwrapErr();

        expect(refusal).toEqual({ type: "run_not_found", runId: "r-missing" });
        expect(await runRows()).toEqual([]);
        expect(d.events).toEqual([]);
    });

    it("passes a refusal of the launch through, and emits and appends nothing", async () => {
        const d = doubles();
        const refusing: RunAuthorizer = { ...d.runAuthorizer, authorize: () => errAsync({ reason: "mint refused", suspend: false }) };

        const refusal = (await approvePlan(depsOf(d, { runAuthorizer: refusing }), input()))._unsafeUnwrapErr();

        expect(refusal).toEqual({ type: "not_authorized", reason: "mint refused" });
        expect(d.events).toEqual([]);
        expect(await threadRowCount()).toBe(0);
    });

    it("passes a failed start through as launch_failed", async () => {
        const d = doubles({ launchFails: true });

        const refusal = (await approvePlan(depsOf(d), input()))._unsafeUnwrapErr();

        expect(refusal).toMatchObject({ type: "launch_failed", cause: { message: "launch boom" } });
        expect(d.events).toEqual([]);
        expect(await threadRowCount()).toBe(0);
    });

    it("gives the run with message null, and logs the failure, when the append of the record fails", async () => {
        const d = doubles();
        const logger = createCapturingLogger();
        // The reservation of the run takes the first connection and the record append takes the second, thus refusing the second connection fails the append alone.
        let connections = 0;
        const flaky: Querier & Connectable = {
            query: (textOrConfig, values) => pool.query(textOrConfig, values),
            connect: () => (++connections === 1 ? pool.connect() : Promise.reject(new Error("append boom"))),
        };

        const approval = (await approvePlan(depsOf(d, { pool: flaky, logger }), input()))._unsafeUnwrap();

        expect(approval).toMatchObject({ planId: PLAN_ID, started: true, message: null });
        expect(await runRows()).toEqual([{ run_id: approval.runId, thread_id: THREAD_ID, status: "running" }]);
        expect(d.events).toHaveLength(1);
        expect(logger.records.filter((record) => record.level === "error").map((record) => record.msg)).toEqual([
            "[approve-plan] the approval record could not be appended",
        ]);
    });
});
