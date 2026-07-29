/**
 * The run-event read seam driven against a real Postgres and a launched DBOS:
 * real workflows write real durable streams, and the assertions are on what a
 * subscriber ends up holding.
 *
 * The emitter workflow is registered ONCE at module top level — DBOS demands
 * `registerWorkflow` before `launch`, and the rig launches lazily — so the test
 * bodies just start it. It optionally parks on a `release` message so a test can
 * hold a run open, publishing a `gated` event first so "the pre-gate parts are
 * durably written" is a fact the test waits on rather than a delay it hopes for.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { DBOS } from "@dbos-inc/dbos-sdk";

import { setupDbosForTests, type DbosTestRig } from "../__tests__/setup/dbos.js";
import { createCapturingLogger } from "../__tests__/setup/logger.js";
import type { CortexChatPart } from "../contracts/chat-parts.js";
import { insertStepExecution } from "../state/step-executions.js";
import { createRunEventStream } from "./run-event-stream.js";

if (DBOS.isInitialized()) {
    await DBOS.shutdown();
}

interface EmitInput {
    readonly before: unknown[];
    readonly after: unknown[];
    /** Park between the two batches until the test sends `release`. */
    readonly gate: boolean;
}

const emitRunEvents = DBOS.registerWorkflow(
    async (input: EmitInput): Promise<number> => {
        for (const part of input.before) await DBOS.writeStream("events", part);
        if (input.gate) {
            await DBOS.setEvent("gated", true);
            await DBOS.recv<string>("release", 60);
        }
        for (const part of input.after) await DBOS.writeStream("events", part);
        return input.before.length + input.after.length;
    },
    { name: "run-event-stream-test-emitter" },
);

let rig: DbosTestRig;

beforeAll(async () => {
    rig = await setupDbosForTests("run_event_stream");
    if (!DBOS.isInitialized()) await DBOS.launch();
});

afterAll(async () => {
    if (rig) await rig.drop();
});

// ── Fixtures ─────────────────────────────────────────────────────────

const activity = (runId: string, stepId: string, phase: string, text: string): unknown => ({
    type: "data-step-activity",
    id: `step-activity-${runId}-${stepId}`,
    runId,
    stepId,
    phase,
    activity: text,
});

const summary = (runId: string, stepId: string, markdown: string): unknown => ({
    type: "data-step-summary",
    id: `step-summary-${runId}-${stepId}`,
    runId,
    stepId,
    agentId: "bio",
    markdown,
});

const dagState = (runId: string, statuses: readonly string[]): unknown => ({
    type: "data-dag-state",
    id: `dag-${runId}`,
    runId,
    steps: statuses.map((status, i) => ({ id: `T1S${i + 1}`, name: `step ${i + 1}`, agent: "bio", status, level: 0, dependsOn: [] })),
});

const runCompleted = (runId: string): unknown => ({
    type: "data-run-completed",
    runId,
    status: "completed",
    completedSteps: 1,
    totalSteps: 1,
    artifactCount: 0,
    findings: [],
});

// ── Helpers ──────────────────────────────────────────────────────────

/** Start the emitter under `workflowId` and hand back a handle to its result. */
function startEmitter(workflowId: string, input: EmitInput): Promise<{ getResult: () => Promise<number> }> {
    return DBOS.startWorkflow(emitRunEvents, { workflowID: workflowId })(input);
}

/** Record a step's child workflow id the way a running child workflow does. */
async function recordChild(pool: DbosTestRig["pool"], runId: string, stepId: string, childWorkflowId: string): Promise<void> {
    (
        await insertStepExecution(pool, {
            runId,
            stepId,
            analysisId: `analysis-${runId}`,
            wave: 0,
            agentId: "bio",
            childWorkflowId,
        })
    )._unsafeUnwrap();
}

/** Poll `predicate` until it holds, or fail the test on the deadline. */
async function waitUntil(predicate: () => boolean, label: string, timeoutMs = 15_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
        await new Promise((r) => setTimeout(r, 25));
    }
}

/** Reject rather than hang when a promise that should settle does not. */
async function settlesWithin<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([
            promise,
            new Promise<never>((_, reject) => {
                timer = setTimeout(() => reject(new Error(`${label} did not settle within ${timeoutMs}ms`)), timeoutMs);
            }),
        ]);
    } finally {
        if (timer) clearTimeout(timer);
    }
}

const typesOf = (parts: readonly CortexChatPart[]): string[] => parts.map((p) => p.type);

// ── Single-stream reading ────────────────────────────────────────────

describe("run-event stream — one workflow", () => {
    it("delivers a finished run's parts in write order and settles", async () => {
        const runId = rig.nextWorkflowId("run-order-");
        const handle = await startEmitter(runId, {
            before: [dagState(runId, ["running"]), summary(runId, "T1S1", "first"), summary(runId, "T1S2", "second"), runCompleted(runId)],
            after: [],
            gate: false,
        });
        await handle.getResult();

        const seen: CortexChatPart[] = [];
        const stream = createRunEventStream({ pool: rig.pool, logger: createCapturingLogger() });
        await settlesWithin(
            stream.subscribe({ runId, onPart: (p) => void seen.push(p), signal: new AbortController().signal }),
            20_000,
            "subscription on a terminal run",
        );

        expect(typesOf(seen)).toEqual(["data-dag-state", "data-step-summary", "data-step-summary", "data-run-completed"]);
        expect((seen[1] as { markdown: string }).markdown).toBe("first");
        expect((seen[2] as { markdown: string }).markdown).toBe("second");
    });

    it("drops values that are not chat data parts and keeps reading", async () => {
        const runId = rig.nextWorkflowId("run-junk-");
        const handle = await startEmitter(runId, {
            before: [{ type: "data-loop-event", data: { stepId: "T1S1", event: { kind: "iteration" } } }, summary(runId, "T1S1", "survivor"), "not-an-object"],
            after: [],
            gate: false,
        });
        await handle.getResult();

        const seen: CortexChatPart[] = [];
        const stream = createRunEventStream({ pool: rig.pool, logger: createCapturingLogger() });
        await settlesWithin(
            stream.subscribe({ runId, onPart: (p) => void seen.push(p), signal: new AbortController().signal }),
            20_000,
            "subscription over non-contract values",
        );

        expect(typesOf(seen)).toEqual(["data-step-summary"]);
    });

    it("keeps delivering after the handler throws, and logs the failure", async () => {
        const runId = rig.nextWorkflowId("run-throw-");
        const handle = await startEmitter(runId, {
            before: [summary(runId, "T1S1", "first"), summary(runId, "T1S2", "second"), summary(runId, "T1S3", "third")],
            after: [],
            gate: false,
        });
        await handle.getResult();

        const seen: CortexChatPart[] = [];
        const logger = createCapturingLogger();
        const stream = createRunEventStream({ pool: rig.pool, logger });
        await settlesWithin(
            stream.subscribe({
                runId,
                onPart: (p) => {
                    seen.push(p);
                    if (seen.length === 1) throw new Error("handler defect");
                },
                signal: new AbortController().signal,
            }),
            20_000,
            "subscription with a throwing handler",
        );

        expect(seen).toHaveLength(3);
        expect(logger.records.some((r) => r.level === "warn" && r.msg.includes("handler threw"))).toBe(true);
    });
});

// ── Parent + child fan-in ────────────────────────────────────────────

describe("run-event stream — parent and child fan-in", () => {
    it("delivers step-level parts from every recorded child alongside run-level parts", async () => {
        const runId = rig.nextWorkflowId("run-fanin-");
        const childA = `${runId}-child-a`;
        const childB = `${runId}-child-b`;

        const parent = await startEmitter(runId, { before: [dagState(runId, ["running", "running"]), runCompleted(runId)], after: [], gate: false });
        const a = await startEmitter(childA, {
            before: [activity(runId, "T1S1", "executing", "Running deseq2.R"), summary(runId, "T1S1", "A")],
            after: [],
            gate: false,
        });
        const b = await startEmitter(childB, { before: [summary(runId, "T1S2", "B")], after: [], gate: false });
        await Promise.all([parent.getResult(), a.getResult(), b.getResult()]);

        await recordChild(rig.pool, runId, "T1S1", childA);
        await recordChild(rig.pool, runId, "T1S2", childB);

        const seen: CortexChatPart[] = [];
        const stream = createRunEventStream({ pool: rig.pool, logger: createCapturingLogger() });
        await settlesWithin(stream.subscribe({ runId, onPart: (p) => void seen.push(p), signal: new AbortController().signal }), 20_000, "fan-in subscription");

        // Ordering holds within a stream, not across them — assert on the set.
        const summaries = seen.filter((p) => p.type === "data-step-summary").map((p) => (p as { markdown: string }).markdown);
        expect(summaries.sort()).toEqual(["A", "B"]);
        expect(typesOf(seen).filter((t) => t === "data-run-completed")).toHaveLength(1);
        expect(typesOf(seen).filter((t) => t === "data-step-activity")).toHaveLength(1);
        // Each workflow is opened once, so nothing is delivered twice.
        expect(seen).toHaveLength(5);
    });

    it("picks up a child that starts after the subscription, without resubscribing", async () => {
        const runId = rig.nextWorkflowId("run-late-");
        const childId = `${runId}-child-late`;

        const parent = await startEmitter(runId, { before: [dagState(runId, ["running"])], after: [runCompleted(runId)], gate: true });
        await DBOS.getEvent<boolean>(runId, "gated", 30);

        const seen: CortexChatPart[] = [];
        const stream = createRunEventStream({ pool: rig.pool, logger: createCapturingLogger() });
        const subscription = stream.subscribe({ runId, onPart: (p) => void seen.push(p), signal: new AbortController().signal });

        await waitUntil(() => seen.some((p) => p.type === "data-dag-state"), "the parent's first part");

        const child = await startEmitter(childId, { before: [summary(runId, "T1S1", "late child")], after: [], gate: false });
        await child.getResult();
        await recordChild(rig.pool, runId, "T1S1", childId);

        await waitUntil(() => seen.some((p) => p.type === "data-step-summary"), "the late child's part");

        await DBOS.send(runId, "go", "release");
        await parent.getResult();
        await settlesWithin(subscription, 20_000, "subscription after the run finished");

        expect((seen.find((p) => p.type === "data-step-summary") as { markdown: string }).markdown).toBe("late child");
        expect(typesOf(seen)).toContain("data-run-completed");
    });

    it("keeps the parent and the remaining children when one child yields nothing", async () => {
        const runId = rig.nextWorkflowId("run-badchild-");
        const goodChild = `${runId}-child-good`;

        const parent = await startEmitter(runId, { before: [runCompleted(runId)], after: [], gate: false });
        const good = await startEmitter(goodChild, { before: [summary(runId, "T1S2", "good")], after: [], gate: false });
        await Promise.all([parent.getResult(), good.getResult()]);

        // A child workflow id in the ledger that no workflow ever backed — the
        // shape a crashed or never-dispatched step leaves behind.
        await recordChild(rig.pool, runId, "T1S1", `${runId}-child-absent`);
        await recordChild(rig.pool, runId, "T1S2", goodChild);

        const seen: CortexChatPart[] = [];
        const stream = createRunEventStream({ pool: rig.pool, logger: createCapturingLogger() });
        await settlesWithin(
            stream.subscribe({ runId, onPart: (p) => void seen.push(p), signal: new AbortController().signal }),
            20_000,
            "subscription with an unbacked child",
        );

        expect(typesOf(seen).sort()).toEqual(["data-run-completed", "data-step-summary"]);
    });
});

// ── Lifecycle ────────────────────────────────────────────────────────

describe("run-event stream — lifecycle", () => {
    it("settles without hanging when the run is already terminal and emitted nothing", async () => {
        const runId = rig.nextWorkflowId("run-empty-");
        const handle = await startEmitter(runId, { before: [], after: [], gate: false });
        await handle.getResult();

        const seen: CortexChatPart[] = [];
        const stream = createRunEventStream({ pool: rig.pool, logger: createCapturingLogger() });
        await settlesWithin(
            stream.subscribe({ runId, onPart: (p) => void seen.push(p), signal: new AbortController().signal }),
            20_000,
            "subscription on an empty terminal run",
        );

        expect(seen).toEqual([]);
    });

    it("settles for a run id no workflow ever used", async () => {
        const stream = createRunEventStream({ pool: rig.pool, logger: createCapturingLogger() });
        const seen: CortexChatPart[] = [];
        await settlesWithin(
            stream.subscribe({ runId: "run-that-never-existed", onPart: (p) => void seen.push(p), signal: new AbortController().signal }),
            20_000,
            "subscription on an unknown run",
        );

        expect(seen).toEqual([]);
    });

    it("stops delivering and settles when the caller aborts mid-run", async () => {
        const runId = rig.nextWorkflowId("run-abort-");
        const parent = await startEmitter(runId, {
            before: [dagState(runId, ["running"])],
            after: [summary(runId, "T1S1", "after-abort"), runCompleted(runId)],
            gate: true,
        });
        await DBOS.getEvent<boolean>(runId, "gated", 30);

        const seen: CortexChatPart[] = [];
        const controller = new AbortController();
        const stream = createRunEventStream({ pool: rig.pool, logger: createCapturingLogger() });
        const subscription = stream.subscribe({ runId, onPart: (p) => void seen.push(p), signal: controller.signal });

        await waitUntil(() => seen.length > 0, "the first part before aborting");
        controller.abort();
        await settlesWithin(subscription, 5_000, "aborted subscription");
        const atAbort = seen.length;

        // Let the run finish; nothing it writes afterwards may reach the handler.
        await DBOS.send(runId, "go", "release");
        await parent.getResult();
        await new Promise((r) => setTimeout(r, 500));

        expect(seen).toHaveLength(atAbort);
        expect(typesOf(seen)).not.toContain("data-run-completed");
    });

    it("replays what a mid-run subscriber missed and converges on current state", async () => {
        const runId = rig.nextWorkflowId("run-midrun-");
        const parent = await startEmitter(runId, {
            before: [
                dagState(runId, ["running"]),
                activity(runId, "T1S1", "sandbox-init", "Starting sandbox"),
                activity(runId, "T1S1", "executing", "Running deseq2.R"),
                summary(runId, "T1S1", "early summary"),
            ],
            after: [activity(runId, "T1S1", "complete", "Step complete"), runCompleted(runId)],
            gate: true,
        });
        await DBOS.getEvent<boolean>(runId, "gated", 30);

        const seen: CortexChatPart[] = [];
        const stream = createRunEventStream({ pool: rig.pool, logger: createCapturingLogger() });
        const subscription = stream.subscribe({ runId, onPart: (p) => void seen.push(p), signal: new AbortController().signal });

        await waitUntil(() => seen.some((p) => p.type === "data-step-summary"), "the history written before subscribing");

        await DBOS.send(runId, "go", "release");
        await parent.getResult();
        await settlesWithin(subscription, 20_000, "mid-run subscription");

        // The history the subscriber missed is replayed...
        expect(typesOf(seen)).toContain("data-dag-state");
        expect((seen.find((p) => p.type === "data-step-summary") as { markdown: string }).markdown).toBe("early summary");
        // ...and the reconciling activity ends on the run's current value.
        const activities = seen.filter((p) => p.type === "data-step-activity");
        expect((activities.at(-1) as { phase: string }).phase).toBe("complete");
        expect(typesOf(seen)).toContain("data-run-completed");
    });
});
