import { describe, expect, test } from "bun:test";
import type { ExecEventMessage } from "@inflexa-ai/harness";

import { handleExecCallback, startExecIngress, type DeliverFn } from "./ingress.ts";

// Valid execId: `${workflowId}:${stepId}:${fnId}` where the workflowId itself
// contains exactly one colon (`analysisId:runId`).
const EXEC_ID = "an-1:run-1:step-1:fn-2";
const WORKFLOW_ID = "an-1:run-1";

type Delivered = { workflowId: string; execId: string; message: ExecEventMessage };

function capture(): { deliver: DeliverFn; delivered: Delivered[] } {
    const delivered: Delivered[] = [];
    return {
        delivered,
        deliver: async (workflowId, execId, message) => {
            delivered.push({ workflowId, execId, message });
        },
    };
}

function post(path: string, body: string, headers: Record<string, string> = {}): Request {
    return new Request(`http://127.0.0.1${path}`, { method: "POST", body, headers });
}

describe("handleExecCallback", () => {
    test("forwards an event envelope with raw bytes and headers preserved", async () => {
        const { deliver, delivered } = capture();
        const raw = '{"stream":"stdout","chunk":"hi"}';
        const res = await handleExecCallback(
            post(`/sandbox/${EXEC_ID}/event`, raw, { "x-sandbox-signature": "deadbeef", "x-sandbox-timestamp": "1700000000" }),
            deliver,
        );

        expect(res.status).toBe(200);
        expect(delivered).toHaveLength(1);
        const d = delivered[0]!;
        expect(d.workflowId).toBe(WORKFLOW_ID);
        expect(d.execId).toBe(EXEC_ID);
        expect(d.message.payload).toEqual({ stream: "stdout", chunk: "hi" });
        expect(d.message.payloadRaw).toBe(raw);
        expect(d.message.signature).toBe("deadbeef");
        expect(d.message.timestamp).toBe(1_700_000_000);
    });

    test("wraps a completion payload as a done-marker over the same raw bytes", async () => {
        const { deliver, delivered } = capture();
        const raw = '{"exitCode":0,"stdout":"ok"}';
        const res = await handleExecCallback(post(`/sandbox/${EXEC_ID}/complete`, raw, { "x-sandbox-signature": "s", "x-sandbox-timestamp": "1" }), deliver);

        expect(res.status).toBe(200);
        expect(delivered[0]!.message.payload).toEqual({ done: true, result: { exitCode: 0, stdout: "ok" } });
        expect(delivered[0]!.message.payloadRaw).toBe(raw);
    });

    test("missing signature headers forward as nulls, not guesses", async () => {
        const { deliver, delivered } = capture();
        await handleExecCallback(post(`/sandbox/${EXEC_ID}/event`, "{}"), deliver);
        expect(delivered[0]!.message.signature).toBeNull();
        expect(delivered[0]!.message.timestamp).toBeNull();
    });

    test("unparseable timestamp forwards as null", async () => {
        const { deliver, delivered } = capture();
        await handleExecCallback(post(`/sandbox/${EXEC_ID}/event`, "{}", { "x-sandbox-timestamp": "not-a-number" }), deliver);
        expect(delivered[0]!.message.timestamp).toBeNull();
    });

    test("execId with no derivable workflow id is a permanent 400", async () => {
        const { deliver, delivered } = capture();
        const res = await handleExecCallback(post("/sandbox/no-colons/event", "{}"), deliver);
        expect(res.status).toBe(400);
        expect(delivered).toHaveLength(0);
    });

    test("non-JSON body is a permanent 400", async () => {
        const { deliver, delivered } = capture();
        const res = await handleExecCallback(post(`/sandbox/${EXEC_ID}/event`, "not json"), deliver);
        expect(res.status).toBe(400);
        expect(delivered).toHaveLength(0);
    });

    test("unroutable path and method are 404", async () => {
        const { deliver } = capture();
        expect((await handleExecCallback(post(`/sandbox/${EXEC_ID}/other`, "{}"), deliver)).status).toBe(404);
        expect((await handleExecCallback(new Request(`http://127.0.0.1/sandbox/${EXEC_ID}/event`), deliver)).status).toBe(404);
    });

    test("failed delivery is a retryable 502", async () => {
        const deliver: DeliverFn = async () => {
            throw new Error("dbos not launched");
        };
        const res = await handleExecCallback(post(`/sandbox/${EXEC_ID}/event`, "{}"), deliver);
        expect(res.status).toBe(502);
    });
});

describe("startExecIngress", () => {
    test("binds loopback, serves a round-trip, and stops", async () => {
        const { deliver, delivered } = capture();
        const ingress = startExecIngress(deliver)._unsafeUnwrap();
        try {
            expect(ingress.port).toBeGreaterThan(0);
            expect(ingress.cortexBaseUrl).toBe(`http://host.docker.internal:${ingress.port}`);

            const res = await fetch(`http://127.0.0.1:${ingress.port}/sandbox/${EXEC_ID}/event`, { method: "POST", body: "{}" });
            expect(res.status).toBe(200);
            expect(delivered).toHaveLength(1);
        } finally {
            ingress.stop();
        }
    });
});
