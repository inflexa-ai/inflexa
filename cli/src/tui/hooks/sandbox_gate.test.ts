import { afterEach, describe, expect, test } from "bun:test";

import type { Notice } from "../theme.ts";
import type { TransferReport } from "../../modules/libs/transfers.ts";
import { awaitSandboxReady, refreshTransferState, __resetSandboxGateForTest, type SandboxGateSeams } from "./sandbox_gate.tsx";

// The gate holds a sandbox-making action while a transfer is live, and it
// refuses a terminal state with the retry command. It starts NO TRANSFER and
// it opens NO consent — the seams below carry no transfer start and no
// dialog, which makes that structural rather than asserted. The one start the
// poll owns is the pending-set flush child, whose consent each add's ask
// already carried; its default stub starts nothing and records nothing.

/** One report in the shape the rows give, with everything else quiet. */
function report(kind: TransferReport["kind"], state: TransferReport["state"], live: boolean, message: string | null = null): TransferReport {
    const row =
        state === null
            ? null
            : {
                  id: kind,
                  createdAt: 0,
                  updatedAt: 0,
                  state,
                  bytesTransferred: 0,
                  totalBytes: null,
                  layersCompleted: 0,
                  totalLayers: null,
                  digest: null,
                  message,
                  holderPid: live ? 4242 : null,
                  phase: null,
              };
    return { kind, row, state, live, holderPid: live ? 4242 : null };
}

/** A seam set whose fields a test overrides. The defaults describe a machine with everything present. */
function seams(over: Partial<SandboxGateSeams> & { notices?: Notice[] }): SandboxGateSeams {
    const notices = over.notices ?? [];
    return {
        storeRoot: () => "/tmp/store",
        readTransfers: () => [],
        readFlights: () => [],
        readPending: () => [],
        inspect: async () => "installed",
        takeFarmFailure: () => null,
        sandboxImage: () => "ghcr.io/inflexa-ai/sandbox-base:latest",
        imageReadiness: async () => ({ kind: "present" }),
        notify: (notice) => notices.push(notice),
        pollMs: 5,
        pendingFlushAfterMs: 10_000,
        startFlush: () => null,
        ...over,
    };
}

afterEach(() => {
    __resetSandboxGateForTest();
});

describe("awaitSandboxReady", () => {
    test("passes when nothing moves and the machine holds the image and the store", async () => {
        expect(await awaitSandboxReady(seams({}))).toBe("ready");
    });

    test("waits while a transfer is live, and decides only after it settles", async () => {
        let reads = 0;
        const notices: Notice[] = [];
        const gate = seams({
            notices,
            readTransfers: () => {
                reads += 1;
                return reads < 3 ? [report("catalog", "running", true)] : [report("catalog", "installed", false)];
            },
        });

        expect(await awaitSandboxReady(gate)).toBe("ready");
        expect(reads).toBeGreaterThanOrEqual(3);
        // The hold names what it waits for, one time.
        expect(notices.filter((notice) => notice.text.includes("Waiting for the catalog transfer"))).toHaveLength(1);
    });

    test("a live catalog transfer over an unusable store refuses with the classified in-flight reason", async () => {
        const notices: Notice[] = [];
        const gate = seams({
            notices,
            inspect: async () => "missing",
            readTransfers: () => [report("catalog", "running", true)],
        });

        // The store cannot serve a sandbox before the catalog lands, and the
        // landing of a multi-gigabyte download is not a wait a launch can hold.
        expect(await awaitSandboxReady(gate)).toBe("blocked");
        expect(notices.some((notice) => notice.kind === "error" && notice.text.includes("in flight") && notice.text.includes("Launch again"))).toBe(true);
    });

    test("refuses an absent image with the pull command, and the failed row's reason rides along", async () => {
        const notices: Notice[] = [];
        const gate = seams({
            notices,
            imageReadiness: async () => ({ kind: "absent" }),
            readTransfers: () => [report("runtime_image", "failed", false, "The disk ran out.")],
        });

        expect(await awaitSandboxReady(gate)).toBe("blocked");
        const text = notices.map((notice) => notice.text).join("\n");
        expect(text).toContain("`inflexa sandbox pull`");
        expect(text).toContain("The disk ran out.");
    });

    test("refuses a missing store with the download command, and a declined state says so", async () => {
        const notices: Notice[] = [];
        const gate = seams({
            notices,
            inspect: async () => "missing",
            readTransfers: () => [report("catalog", "declined", false)],
        });

        expect(await awaitSandboxReady(gate)).toBe("blocked");
        const text = notices.map((notice) => notice.text).join("\n");
        expect(text).toContain("declined at setup");
        expect(text).toContain("`inflexa store download`");
    });

    test("a locally built store passes, because the filesystem decides and not the row", async () => {
        const gate = seams({
            inspect: async () => "local",
            // The catalog row can say whatever a dead run left; the content wins.
            readTransfers: () => [report("catalog", "canceled", false)],
        });

        expect(await awaitSandboxReady(gate)).toBe("ready");
    });

    test("reports a recorded farm failure once, and the next action composes again", async () => {
        const notices: Notice[] = [];
        let failure: { analysisId: string; reason: string } | null = { analysisId: "a1", reason: "the catalog farm is absent" };
        const gate = seams({
            notices,
            takeFarmFailure: () => {
                const taken = failure;
                failure = null;
                return taken;
            },
        });

        expect(await awaitSandboxReady(gate)).toBe("blocked");
        expect(notices.map((notice) => notice.text).join("\n")).toContain("the catalog farm is absent");
        // The read CONSUMED the record, thus the next action is not refused on it.
        expect(await awaitSandboxReady(gate)).toBe("ready");
    });
});

describe("the pending flush gate", () => {
    const PENDING = [{ ecosystem: "python" as const, name: "polars", specifier: "" }];

    test("the poll starts the flush child once the pending set outwaits the gate", async () => {
        const starts: number[] = [];
        const gate = seams({
            readPending: () => PENDING,
            pendingFlushAfterMs: 20,
            startFlush: () => {
                starts.push(Date.now());
                return 4242;
            },
        });

        refreshTransferState(gate);
        expect(starts).toHaveLength(0);
        await Bun.sleep(30);
        refreshTransferState(gate);

        expect(starts).toHaveLength(1);
    });

    test("a set that empties before the gate fires starts nothing, and the anchor clears", async () => {
        let pending = PENDING;
        let started = 0;
        const gate = seams({
            readPending: () => pending,
            pendingFlushAfterMs: 20,
            startFlush: () => {
                started += 1;
                return 4242;
            },
        });

        refreshTransferState(gate);
        pending = [];
        refreshTransferState(gate);
        await Bun.sleep(30);
        refreshTransferState(gate);

        // The empty poll cleared the anchor, thus the elapsed time before it
        // counts for nothing and no child starts.
        expect(started).toBe(0);
    });

    test("the anchor does not slide while the set grows, thus a burst still flushes at the bound", async () => {
        let pending = PENDING;
        let started = 0;
        const gate = seams({
            readPending: () => pending,
            pendingFlushAfterMs: 40,
            startFlush: () => {
                started += 1;
                return 4242;
            },
        });

        refreshTransferState(gate);
        await Bun.sleep(25);
        // The set GROWS below the bound: a sliding anchor would restart the
        // wait here, and the fire below would prove it did not.
        pending = [...PENDING, { ecosystem: "python" as const, name: "rpy2", specifier: "" }];
        refreshTransferState(gate);
        expect(started).toBe(0);
        await Bun.sleep(25);
        refreshTransferState(gate);

        expect(started).toBe(1);
    });
});
