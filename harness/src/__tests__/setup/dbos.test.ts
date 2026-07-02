/**
 * Smoke test for the DBOS testcontainer rig. If any of the six sub-tests
 * fails the rig is not ready to back integration tests #7-#11.
 *
 * Each sub-test:
 *   1. Trivial workflow returns its argument + 1.
 *   2. send/recv across two workflows.
 *   3. writeStream/readStream round-trip on a single workflow.
 *   4. cancel transitions a long-running workflow into CANCELLED.
 *
 * Workflows are registered ONCE at module top level — DBOS demands
 * `registerWorkflow` before `launch`, but the rig launches lazily, so we
 * stash the registered wrappers in module-locals and the test bodies just
 * invoke them. The DBOS engine itself is shared across the whole `bun
 * test` invocation.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { DBOS } from "@dbos-inc/dbos-sdk";

import { setupDbosForTests, type DbosTestRig } from "./dbos.js";

// Reopen the registration window if an earlier test file already launched
// the shared DBOS engine: a plain shutdown (no `deregister`) keeps every
// prior registration and lets the top-level `registerWorkflow` calls below
// through; `beforeAll` relaunches via `DBOS.launch()`.
if (DBOS.isInitialized()) {
    await DBOS.shutdown();
}

const incrementAndWait = DBOS.registerWorkflow(
    async (x: number): Promise<number> => {
        return x + 1;
    },
    { name: "rig-smoke-increment" },
);

const recvHello = DBOS.registerWorkflow(
    async (timeoutSeconds: number): Promise<string | null> => {
        return DBOS.recv<string>("hello", timeoutSeconds);
    },
    { name: "rig-smoke-recv-hello" },
);

const writeEvents = DBOS.registerWorkflow(
    async (count: number): Promise<number> => {
        for (let i = 0; i < count; i += 1) {
            await DBOS.writeStream("events", { idx: i, value: `event-${i}` });
        }
        await DBOS.closeStream("events");
        return count;
    },
    { name: "rig-smoke-write-events" },
);

const longRunner = DBOS.registerWorkflow(
    async (): Promise<number> => {
        // Loop a step that polls until cancelled. `cancelWorkflow` raises
        // DBOSWorkflowCancelledError from the next DBOS call, which terminates
        // this workflow.
        for (let i = 0; i < 200; i += 1) {
            await DBOS.runStep(
                async () => {
                    await new Promise((r) => setTimeout(r, 25));
                    return i;
                },
                { name: "step-tick" },
            );
        }
        return -1;
    },
    { name: "rig-smoke-long-runner" },
);

let rig: DbosTestRig;

beforeAll(async () => {
    rig = await setupDbosForTests("dbos_rig_smoke");
    // Relaunch when the module-top registration-window bounce stopped the
    // engine; a no-op when the rig's lazy launch above did the launching.
    if (!DBOS.isInitialized()) await DBOS.launch();
});

afterAll(async () => {
    if (rig) await rig.drop();
});

describe("DBOS testcontainer rig — smoke", () => {
    it("registers and runs a trivial workflow end-to-end", async () => {
        const wfId = rig.nextWorkflowId("incr-");
        const handle = await DBOS.startWorkflow(incrementAndWait, {
            workflowID: wfId,
        })(41);
        const result = await handle.getResult();
        expect(result).toBe(42);

        // Sanity-check `getResult(wfId)` matches the handle result.
        const fetched = await DBOS.getResult<number>(wfId);
        expect(fetched).toBe(42);
    });

    it("delivers send/recv across workflows", async () => {
        const wfId = rig.nextWorkflowId("recv-");
        const handle = await DBOS.startWorkflow(recvHello, {
            workflowID: wfId,
        })(10);

        // `recv` is durable — the workflow is blocked on the topic. Send from
        // outside the workflow.
        await DBOS.send(wfId, "world", "hello");

        const received = await handle.getResult();
        expect(received).toBe("world");
    });

    it("writeStream values are readable via readStream", async () => {
        const wfId = rig.nextWorkflowId("stream-");
        const handle = await DBOS.startWorkflow(writeEvents, {
            workflowID: wfId,
        })(3);
        await handle.getResult();

        const values: Array<{ idx: number; value: string }> = [];
        for await (const v of DBOS.readStream<{ idx: number; value: string }>(wfId, "events")) {
            values.push(v);
        }
        expect(values).toHaveLength(3);
        expect(values[0]).toEqual({ idx: 0, value: "event-0" });
        expect(values[2]).toEqual({ idx: 2, value: "event-2" });
    });

    it("cancelWorkflow transitions a running workflow to CANCELLED", async () => {
        const wfId = rig.nextWorkflowId("cancel-");
        const handle = await DBOS.startWorkflow(longRunner, {
            workflowID: wfId,
        })();

        // Give the workflow a moment to enter its loop, then cancel.
        await new Promise((r) => setTimeout(r, 100));
        await DBOS.cancelWorkflow(wfId);

        // The cancellation propagates as a thrown error from the next DBOS call
        // inside the workflow. Awaiting the handle either resolves with the
        // workflow's terminal state or rejects with the cancel error — we
        // don't care which, we only care that the durable status lands on
        // CANCELLED.
        try {
            await handle.getResult();
        } catch {
            /* expected */
        }

        // The status transition is async — poll briefly.
        const deadline = Date.now() + 5_000;
        let status: Awaited<ReturnType<typeof DBOS.getWorkflowStatus>> = null;
        while (Date.now() < deadline) {
            status = await DBOS.getWorkflowStatus(wfId);
            if (status && status.status === "CANCELLED") break;
            await new Promise((r) => setTimeout(r, 100));
        }
        expect(status?.status).toBe("CANCELLED");
    });
});
