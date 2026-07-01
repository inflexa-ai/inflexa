/**
 * Reaper pure-logic tests. Covers:
 *  - classifyManaged: in-flight workflow → leave; terminal/missing → reap;
 *    creation-time grace for label-less / status-less machines
 *  - terminalStepStatus mapping
 *  - reapOnce: tears down + reconciles reapable machines, leaves in-flight
 *    ones, and survives a teardown failure on one machine
 */

import { describe, expect, test } from "bun:test";
import type { Pool } from "pg";

import { classifyManaged, reapOnce, terminalStepStatus } from "./reaper.js";
import type { ManagedSandbox } from "./types.js";

const GRACE = 10 * 60_000;
const NOW = 1_000_000_000;

function managed(sandboxId: string, ownerWorkflowId: string | null, createdAtMs: number | null = NOW): ManagedSandbox {
    return { sandboxId, ownerWorkflowId, createdAtMs };
}

describe("classifyManaged", () => {
    test("leaves a machine whose workflow is still in flight", () => {
        // RUNNING is the critical one — an actively-executing step must keep its
        // sandbox.
        for (const status of ["PENDING", "ENQUEUED", "RUNNING"]) {
            expect(classifyManaged(managed("s", "wf-1"), { status }, NOW, GRACE)).toBe("leave");
        }
    });

    test("reaps a machine whose workflow is terminal, regardless of age", () => {
        for (const status of ["SUCCESS", "ERROR", "CANCELLED"]) {
            expect(classifyManaged(managed("s", "wf-1", NOW), { status }, NOW, GRACE)).toBe("reap");
        }
    });

    test("status-less (gone workflow / no label): grace-gated", () => {
        // Fresh → within grace → leave (guards the create race).
        expect(classifyManaged(managed("s", null, NOW - 1000), null, NOW, GRACE)).toBe("leave");
        // Old → past grace → reap.
        expect(classifyManaged(managed("s", null, NOW - GRACE - 1), null, NOW, GRACE)).toBe("reap");
    });

    test("unknown creation time is treated as past grace (reap)", () => {
        expect(classifyManaged(managed("s", null, null), null, NOW, GRACE)).toBe("reap");
    });
});

describe("terminalStepStatus", () => {
    test("maps workflow terminal status to step status", () => {
        expect(terminalStepStatus("CANCELLED")).toBe("canceled");
        expect(terminalStepStatus("SUCCESS")).toBe("completed");
        expect(terminalStepStatus("ERROR")).toBe("failed");
        expect(terminalStepStatus(null)).toBe("failed");
    });
});

interface FakePool {
    pool: Pool;
    reconciled: string[];
}

/** Minimal pool that records `reconcileReapedSandbox` UPDATEs by sandboxId. */
function fakePool(): FakePool {
    const reconciled: string[] = [];
    const pool = {
        query: async (arg: { values?: unknown[] }) => {
            reconciled.push(String(arg.values?.[0]));
            return { rowCount: 1 };
        },
    } as unknown as Pool;
    return { pool, reconciled };
}

describe("reapOnce", () => {
    test("reaps terminal/orphaned machines and leaves in-flight ones", async () => {
        const managedList: ManagedSandbox[] = [
            managed("sbx-live", "wf-live"), // PENDING → leave
            managed("sbx-cancelled", "wf-cancelled"), // CANCELLED → reap
            managed("sbx-orphan", null, NOW - GRACE - 1), // no owner, old → reap
            managed("sbx-fresh", null, NOW - 1), // no owner, fresh → leave
        ];
        const statuses: Record<string, string> = {
            "wf-live": "PENDING",
            "wf-cancelled": "CANCELLED",
        };
        const tornDown: string[] = [];
        const { pool, reconciled } = fakePool();

        const summary = await reapOnce({
            pool,
            sandboxClient: {
                listManagedSandboxes: async () => managedList,
                teardownById: async (id) => {
                    tornDown.push(id);
                },
            },
            getStatus: async (wf) => (statuses[wf] ? { status: statuses[wf]! } : null),
            graceMs: GRACE,
            nowMs: () => NOW,
        });

        expect(tornDown.sort()).toEqual(["sbx-cancelled", "sbx-orphan"]);
        expect(reconciled.sort()).toEqual(["sbx-cancelled", "sbx-orphan"]);
        expect(summary).toEqual({
            managedCount: 4,
            reapedCount: 2,
            rowsReconciled: 2,
            leftCount: 2,
        });
    });

    test("a teardown failure on one machine does not abort the sweep", async () => {
        const managedList = [managed("sbx-a", "wf-a"), managed("sbx-b", "wf-b")];
        const tornDown: string[] = [];
        const { pool } = fakePool();

        const summary = await reapOnce({
            pool,
            sandboxClient: {
                listManagedSandboxes: async () => managedList,
                teardownById: async (id) => {
                    if (id === "sbx-a") throw new Error("delete failed");
                    tornDown.push(id);
                },
            },
            getStatus: async () => ({ status: "ERROR" }),
            graceMs: GRACE,
            nowMs: () => NOW,
        });

        // sbx-a's teardown threw → not counted; sbx-b still reaped.
        expect(tornDown).toEqual(["sbx-b"]);
        expect(summary.reapedCount).toBe(1);
        expect(summary.managedCount).toBe(2);
    });
});
