import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { must } from "@inflexa-ai/harness/lib/test/guards.js";
import { errAsync, okAsync } from "neverthrow";
import type { Pool } from "pg";

import { createCapturingLogger } from "../../__tests__/setup/logger.js";
import { withSchema } from "../../__tests__/setup/postgres.js";
import { makeLocalAuth } from "../../auth/local-auth-context.js";
import type { AuthorizeRunInput, RunAuthorizer } from "../../execution/run-authorizer.js";
import { poolDouble, stubRunSession } from "../../lib/test/doubles.js";
import type { RunLauncher } from "../../execution/run-launcher.js";
import { storedMessagesToChat } from "../../memory/conversation-display-replay.js";
import { createThreadHistory } from "../../memory/thread-history.js";
import { createThreadStore } from "../../memory/thread-store.js";
import type { ProvenanceSeam, SessionProvenanceEvent } from "../../provenance/seam.js";
import { insertRun, upsertAnalysis, upsertPlan } from "../../state/index.js";
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
        launch: (_workflow, options) => {
            if (over.launchFails) throw new Error("launch boom");
            launches.push({ workflowId: options.workflowId, atMs: Date.now() });
            return Promise.resolve();
        },
    };
    const runAuthorizer: RunAuthorizer = {
        authorize: (input) => {
            authorizations.push(input);
            const runSession = stubRunSession({ runFrame: { runId: "run-approved" } });
            return okAsync({ runSession, ownsMandate: true });
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
        executeAnalysisWorkflow: () => {
            return Promise.reject(new Error("the launcher starts the workflow"));
        },
        runAuthorizer: d.runAuthorizer,
        runLauncher: d.runLauncher,
        provenance: d.provenance,
        ...over,
    };
}

const auth = makeLocalAuth();
const input = (over: Partial<Parameters<typeof approvePlan>[1]> = {}) => ({
    analysisId: ANALYSIS_ID,
    threadId: THREAD_ID,
    planId: PLAN_ID,
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
    return rows[0].n;
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
        expect(d.authorizations[0].auth).toBe(auth);
        expect(d.authorizations[0].scope).toEqual({ kind: "analysis", analysisId: ANALYSIS_ID, threadId: THREAD_ID });
        expect(d.authorizations[0].provenance).toEqual({ agentId: "plan-approval", callPath: ["plan-approval"] });
    });

    it("emits one approve-plan event whose time is not later than the launch, and the part carries the same instant", async () => {
        const d = doubles();

        const approval = (await approvePlan(depsOf(d), input()))._unsafeUnwrap();

        expect(d.events).toHaveLength(1);
        const event = d.events[0];
        if (event.type !== "approve-plan") throw new Error(`expected the approve-plan event, got ${event.type}`);
        expect(event).toMatchObject({ type: "approve-plan", analysisId: ANALYSIS_ID, threadId: THREAD_ID, planId: PLAN_ID, runId: approval.runId });
        const atMs = event.atMs;
        expect(atMs).toBeLessThanOrEqual(d.launches[0].atMs);
        const part = must(approval.message, "approval message").parts[0];
        expect(part).toEqual({ type: "data-plan-approval", planId: PLAN_ID, runId: approval.runId, approvedAt: new Date(atMs).toISOString() });
    });

    it("tells the next turn the record text with the ids and no time", async () => {
        const d = doubles();

        const approval = (await approvePlan(depsOf(d), input()))._unsafeUnwrap();

        const history = (await createThreadHistory(pool).loadRecent(THREAD_ID))._unsafeUnwrap();
        expect(history).toHaveLength(1);
        expect(history[0].role).toBe("user");
        expect(JSON.stringify(history[0].content)).toContain(`The person approved plan ${PLAN_ID}. Run ${approval.runId} started.`);
        // oxlint-disable-next-line eslint-js/no-restricted-syntax -- the assertion checks the absence of a date or time shape in the serialized transcript, a grammar with no builtin test
        expect(JSON.stringify(history[0].content)).not.toMatch(/\d{4}-\d{2}-\d{2}|\d{2}:\d{2}/);
    });

    it("shows the approval and the run card in the transcript, and the result message equals the transcript message but for the row time", async () => {
        const d = doubles();

        const approval = (await approvePlan(depsOf(d), input()))._unsafeUnwrap();

        const transcript = storedMessagesToChat((await createThreadHistory(pool).loadAll(THREAD_ID))._unsafeUnwrap().flat());
        expect(transcript).toHaveLength(1);
        const { createdAt, ...rest } = transcript[0];
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

        const approval = (await approvePlan(depsOf(d), input()))._unsafeUnwrap();

        expect(approval).toEqual({ planId: PLAN_ID, runId: "r-active", started: false, message: null });
        expect(await threadRowCount()).toBe(0);
        expect(d.events).toEqual([]);
        expect(d.launches).toEqual([]);
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

        expect(refusal.type).toBe("launch_failed");
        if (refusal.type !== "launch_failed") throw new Error("expected a launch_failed refusal");
        expect(refusal.cause).toMatchObject({ message: "launch boom" });
        expect(d.events).toEqual([]);
        expect(await threadRowCount()).toBe(0);
    });

    it("gives the run with message null, and logs the failure, when the append of the record fails", async () => {
        const d = doubles();
        const logger = createCapturingLogger();
        // The record append is the one write that takes a connection of the pool, thus refusing the connection fails the append alone.
        const flaky = poolDouble((query, values) => pool.query(query.text, values), {
            connect: () => Promise.reject(new Error("append boom")),
        });

        const approval = (await approvePlan(depsOf(d, { pool: flaky, logger }), input()))._unsafeUnwrap();

        expect(approval).toMatchObject({ planId: PLAN_ID, started: true, message: null });
        expect(await runRows()).toEqual([{ run_id: approval.runId, thread_id: THREAD_ID, status: "running" }]);
        expect(d.events).toHaveLength(1);
        expect(logger.records.filter((record) => record.level === "error").map((record) => record.msg)).toEqual([
            "[approve-plan] the approval record could not be appended",
        ]);
    });
});
