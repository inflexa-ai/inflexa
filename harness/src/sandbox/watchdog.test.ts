/**
 * Watchdog pure-logic tests. Covers:
 *  - sharding distributes rows across the configured shard count
 *  - checkShard sends synthetic-failure only when sandbox dead AND
 *    workflow still in flight
 *  - skipped paths: alive sandbox; terminal workflow status; no execId
 */

import { describe, expect, test } from "bun:test";
import type { ActiveSandboxRow } from "../state/index.js";
import { checkShard, shardActiveSandboxes, shardIndex, SHARD_COUNT, syntheticFailureMessage } from "./watchdog.js";

function row(sandboxId: string, execId: string | null = `wf-${sandboxId}:step-a:fn-0`): ActiveSandboxRow {
    return {
        runId: `run-${sandboxId}`,
        stepId: "step-a",
        analysisId: "an-1",
        sandboxRef: { sandboxId, host: "h", port: 1, backend: "k8s" },
        execId,
    };
}

describe("shardActiveSandboxes", () => {
    test("partitions rows across shards by stable hash", () => {
        const rows = Array.from({ length: 20 }, (_, i) => row(`sbx-${i}`));
        const shards = shardActiveSandboxes(rows);
        expect(shards.length).toBe(SHARD_COUNT);
        // No row is dropped.
        expect(shards.flat()).toHaveLength(rows.length);
        // Each row lands in the deterministic shard for its sandboxId.
        for (const r of rows) {
            const idx = shardIndex(r.sandboxRef.sandboxId);
            expect(shards[idx]).toContain(r);
        }
    });

    test("sharding is deterministic across runs", () => {
        expect(shardIndex("sbx-aaa")).toBe(shardIndex("sbx-aaa"));
    });

    test("returns empty shards when no rows match", () => {
        const shards = shardActiveSandboxes([], 4);
        expect(shards.length).toBe(4);
        expect(shards.flat()).toHaveLength(0);
    });
});

describe("checkShard", () => {
    test("dead sandbox + workflow PENDING → exactly one synthetic-failure send", async () => {
        const sent: Array<{ workflowId: string; execId: string; reason: string }> = [];

        const summary = await checkShard([row("sbx-1")], {
            isAlive: async () => ({ alive: false, oomKilled: false }),
            getStatus: async () => ({ status: "PENDING" }),
            sendSynthetic: async (workflowId, execId, _failure, reason) => {
                sent.push({ workflowId, execId, reason });
            },
        });

        expect(sent).toEqual([
            {
                workflowId: "wf-sbx-1",
                execId: "wf-sbx-1:step-a:fn-0",
                reason: "sandbox-dead",
            },
        ]);
        expect(summary).toMatchObject({
            activeCount: 1,
            deadCount: 1,
            syntheticSends: 1,
            liveWorkflowsSkipped: 0,
        });
    });

    test("OOM-killed sandbox sends the sandbox-oom-killed reason", async () => {
        const sent: Array<{ reason: string; syntheticReason: string }> = [];

        await checkShard([row("sbx-oom")], {
            isAlive: async () => ({ alive: false, oomKilled: true }),
            getStatus: async () => ({ status: "PENDING" }),
            sendSynthetic: async (_workflowId, _execId, failure, reason) => {
                sent.push({ reason, syntheticReason: failure.syntheticFailure?.reason ?? "" });
            },
        });

        expect(sent).toEqual([{ reason: "sandbox-oom-killed", syntheticReason: "sandbox-oom-killed" }]);
    });

    test("alive sandbox is skipped", async () => {
        const sent: unknown[] = [];
        const summary = await checkShard([row("sbx-2")], {
            isAlive: async () => ({ alive: true, oomKilled: false }),
            getStatus: async () => ({ status: "PENDING" }),
            sendSynthetic: async (...args) => {
                sent.push(args);
            },
        });
        expect(sent).toHaveLength(0);
        expect(summary.deadCount).toBe(0);
    });

    test("dead sandbox but terminal workflow does NOT send", async () => {
        const sent: unknown[] = [];
        const summary = await checkShard([row("sbx-3")], {
            isAlive: async () => ({ alive: false, oomKilled: false }),
            getStatus: async () => ({ status: "SUCCESS" }),
            sendSynthetic: async (...args) => {
                sent.push(args);
            },
        });
        expect(sent).toHaveLength(0);
        expect(summary).toMatchObject({
            deadCount: 1,
            syntheticSends: 0,
            liveWorkflowsSkipped: 1,
        });
    });

    test("dead sandbox without execId is recorded but not sent", async () => {
        const sent: unknown[] = [];
        const summary = await checkShard([row("sbx-4", null)], {
            isAlive: async () => ({ alive: false, oomKilled: false }),
            getStatus: async () => ({ status: "PENDING" }),
            sendSynthetic: async (...args) => {
                sent.push(args);
            },
        });
        expect(sent).toHaveLength(0);
        expect(summary).toMatchObject({ deadCount: 1, syntheticSends: 0 });
    });

    test("isAlive throw is logged and that row is skipped (no synthetic)", async () => {
        const sent: unknown[] = [];
        const summary = await checkShard([row("sbx-5"), row("sbx-6")], {
            isAlive: async (ref) => {
                if (ref.sandboxId === "sbx-5") throw new Error("API 5xx");
                return { alive: true, oomKilled: false };
            },
            getStatus: async () => ({ status: "PENDING" }),
            sendSynthetic: async (...args) => {
                sent.push(args);
            },
        });
        expect(sent).toHaveLength(0);
        expect(summary.activeCount).toBe(2);
    });

    test("multiple dead+in-flight rows produce one synthetic each", async () => {
        const sent: string[] = [];
        await checkShard([row("a"), row("b"), row("c")], {
            isAlive: async () => ({ alive: false, oomKilled: false }),
            getStatus: async () => ({ status: "PENDING" }),
            sendSynthetic: async (_wf, execId) => {
                sent.push(execId);
            },
        });
        expect(sent.sort()).toEqual(["wf-a:step-a:fn-0", "wf-b:step-a:fn-0", "wf-c:step-a:fn-0"]);
    });

    test("execId with embedded colon in workflowId resolves to the full child workflowId", async () => {
        // Production shape: childWorkflowId = `${analysisId}:${runId}-${idx}`,
        // execId = `${childWorkflowId}:${stepId}:${fnId}`. The send target must
        // be the full childWorkflowId — splitting on the first colon would land
        // synthetics on the analysisId-only string and miss the running workflow.
        const seen: Array<{ workflowId: string; execId: string }> = [];
        const r: ActiveSandboxRow = {
            runId: "run-1",
            stepId: "s-a",
            analysisId: "an-1",
            sandboxRef: { sandboxId: "sbx-prod", host: "h", port: 1, backend: "k8s" },
            execId: "an-1:run-1-0:s-a:fn-0",
        };
        await checkShard([r], {
            isAlive: async () => ({ alive: false, oomKilled: false }),
            getStatus: async () => ({ status: "PENDING" }),
            sendSynthetic: async (workflowId, execId) => {
                seen.push({ workflowId, execId });
            },
        });
        expect(seen).toEqual([{ workflowId: "an-1:run-1-0", execId: "an-1:run-1-0:s-a:fn-0" }]);
    });
});

describe("checkShard — dead sandbox status gating", () => {
    test("dead sandbox with null getStatus is skipped", async () => {
        const sent: unknown[] = [];

        const summary = await checkShard([row("sbx-nobus")], {
            isAlive: async () => ({ alive: false, oomKilled: false }),
            getStatus: async () => null,
            sendSynthetic: async (...args) => {
                sent.push(args);
            },
        });

        expect(sent).toHaveLength(0);
        expect(summary.liveWorkflowsSkipped).toBe(1);
    });
});

describe("syntheticFailureMessage", () => {
    test("encodes a null-signature done-marker with the kind tag", () => {
        const msg = syntheticFailureMessage(
            "wf-1:s-a:fn-0",
            {
                execId: "wf-1:s-a:fn-0",
                exitCode: null,
                stdout: "",
                stderr: "",
                durationMs: null,
                timedOut: false,
                syntheticFailure: { reason: "sandbox-dead" },
            },
            "sandbox-dead",
            1700000000,
        );
        expect(msg.signature).toBeNull();
        expect(msg.timestamp).toBe(1700000000);
        const payload = msg.payload as {
            done: boolean;
            kind: string;
            reason: string;
            result: { syntheticFailure: { reason: string } };
        };
        expect(payload.done).toBe(true);
        expect(payload.kind).toBe("synthetic-failure");
        expect(payload.reason).toBe("sandbox-dead");
        expect(payload.result.syntheticFailure.reason).toBe("sandbox-dead");
    });
});
