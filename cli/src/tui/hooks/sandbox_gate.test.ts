import { afterEach, describe, expect, test } from "bun:test";
import { errAsync, okAsync } from "neverthrow";

import type { SandboxReadiness } from "../../api/runs.ts";
import type { StoreState, TransferReportView } from "../../api/store.ts";
import type { Notice } from "../theme.ts";
import {
    awaitSandboxReady,
    pendingAddLines,
    refreshTransferState,
    storeFlightLines,
    transferReports,
    __resetSandboxGateForTest,
    type SandboxGateSeams,
} from "./sandbox_gate.tsx";

// The gate holds a sandbox-making action while a transfer is live, and it
// refuses a terminal state with the retry command. It starts NO TRANSFER and
// it opens NO consent — the seams below carry no transfer start and no
// dialog, which makes that structural rather than asserted.

/** One report in the wire shape of `GET /api/v1/store`, with everything else quiet. */
function report(kind: TransferReportView["kind"], state: TransferReportView["state"], live: boolean, message: string | null = null): TransferReportView {
    const row =
        state === null
            ? null
            : {
                  createdAt: "1970-01-01T00:00:00.000Z",
                  updatedAt: "1970-01-01T00:00:00.000Z",
                  state,
                  bytesTransferred: 0,
                  totalBytes: null,
                  layersCompleted: 0,
                  totalLayers: null,
                  digest: null,
                  message,
                  phase: null,
              };
    return { kind, row, state, live, holderPid: live ? 4242 : null };
}

/** A store read that answers with `transfers` and nothing else. */
function storeWith(transfers: readonly TransferReportView[]): ReturnType<SandboxGateSeams["readStore"]> {
    const store: StoreState = { transfers: [...transfers], flights: [], pendingAdds: [] };
    return okAsync(store);
}

/** A readiness read of `GET {A}/sandbox-readiness`. The defaults describe a machine with everything present. */
function machine(over: Partial<SandboxReadiness> = {}): ReturnType<SandboxGateSeams["readiness"]> {
    return okAsync({
        image: { state: "present", image: "ghcr.io/inflexa-ai/sandbox-base:latest" },
        store: "installed",
        farm: { present: true, catalogPresent: true, failure: null },
        inputCount: 1,
        ...over,
    });
}

/** An option set whose fields a test overrides. The defaults describe a machine with everything present. */
function seams(over: Partial<SandboxGateSeams> & { notices?: Notice[] }): SandboxGateSeams {
    const notices = over.notices ?? [];
    return {
        readStore: () => storeWith([]),
        readiness: () => machine(),
        notify: (notice) => notices.push(notice),
        pollMs: 5,
        ...over,
    };
}

afterEach(() => {
    __resetSandboxGateForTest();
});

describe("awaitSandboxReady", () => {
    test("passes when nothing moves and the machine holds the image and the store", async () => {
        expect(await awaitSandboxReady("a1", seams({}))).toBe("ready");
    });

    test("waits while a transfer is live, and decides only after it settles", async () => {
        let reads = 0;
        const notices: Notice[] = [];
        const gate = seams({
            notices,
            readStore: () => {
                reads += 1;
                return storeWith(reads < 3 ? [report("catalog", "running", true)] : [report("catalog", "installed", false)]);
            },
        });

        expect(await awaitSandboxReady("a1", gate)).toBe("ready");
        expect(reads).toBeGreaterThanOrEqual(3);
        // The hold names what it waits for, one time.
        expect(notices.filter((notice) => notice.text.includes("Waiting for the catalog transfer"))).toHaveLength(1);
    });

    test("a live catalog transfer over an unusable store refuses with the classified in-flight reason", async () => {
        const notices: Notice[] = [];
        const gate = seams({
            notices,
            readiness: () => machine({ store: "missing" }),
            readStore: () => storeWith([report("catalog", "running", true)]),
        });

        // The store cannot serve a sandbox before the catalog lands, and the
        // landing of a multi-gigabyte download is not a wait a launch can hold.
        expect(await awaitSandboxReady("a1", gate)).toBe("blocked");
        expect(notices.some((notice) => notice.kind === "error" && notice.text.includes("in flight") && notice.text.includes("Launch again"))).toBe(true);
    });

    test("refuses an absent image with the pull command, and the failed row's reason rides along", async () => {
        const notices: Notice[] = [];
        const gate = seams({
            notices,
            readiness: () => machine({ image: { state: "absent", image: "ghcr.io/inflexa-ai/sandbox-base:latest" } }),
            readStore: () => storeWith([report("runtime_image", "failed", false, "The disk ran out.")]),
        });

        expect(await awaitSandboxReady("a1", gate)).toBe("blocked");
        const text = notices.map((notice) => notice.text).join("\n");
        expect(text).toContain("`inflexa sandbox pull`");
        expect(text).toContain("The disk ran out.");
    });

    test("refuses a missing store with the download command, and a declined state says so", async () => {
        const notices: Notice[] = [];
        const gate = seams({
            notices,
            readiness: () => machine({ store: "missing" }),
            readStore: () => storeWith([report("catalog", "declined", false)]),
        });

        expect(await awaitSandboxReady("a1", gate)).toBe("blocked");
        const text = notices.map((notice) => notice.text).join("\n");
        expect(text).toContain("declined at setup");
        expect(text).toContain("`inflexa store download`");
    });

    test("a locally built store passes, because the filesystem decides and not the row", async () => {
        const gate = seams({
            readiness: () => machine({ store: "local" }),
            // The catalog row can say whatever a dead run left; the content wins.
            readStore: () => storeWith([report("catalog", "canceled", false)]),
        });

        expect(await awaitSandboxReady("a1", gate)).toBe("ready");
    });

    test("reports a recorded farm failure once, and the next action composes again", async () => {
        const notices: Notice[] = [];
        // The server consumes the record at the read, so the second read reports no failure.
        let failure: string | null = "the catalog farm is absent";
        const gate = seams({
            notices,
            readiness: (analysisId) => {
                expect(analysisId).toBe("a1");
                const taken = failure;
                failure = null;
                return machine({ farm: { present: true, catalogPresent: true, failure: taken } });
            },
        });

        expect(await awaitSandboxReady("a1", gate)).toBe("blocked");
        expect(notices.map((notice) => notice.text).join("\n")).toContain("the catalog farm is absent");
        // The read CONSUMED the record, thus the next action is not refused on it.
        expect(await awaitSandboxReady("a1", gate)).toBe("ready");
    });
});

describe("the store poll", () => {
    test("publishes the transfers, the flights, and the pending adds of one read", async () => {
        const store: StoreState = {
            transfers: [report("catalog", "running", true)],
            flights: [
                {
                    id: "python::polars::",
                    spec: "polars (python)",
                    state: "running",
                    subscribers: 1,
                    progress: "resolving",
                    message: null,
                    failure: null,
                    updatedAt: "1970-01-01T00:00:00.000Z",
                },
            ],
            pendingAdds: [{ flightKey: "any::rpy2::", spec: "rpy2", analysisId: null, createdAt: "1970-01-01T00:00:00.000Z" }],
        };

        const read = await refreshTransferState({ readStore: () => okAsync(store) });

        expect(read._unsafeUnwrap()).toEqual(store.transfers);
        expect(transferReports()).toEqual(store.transfers);
        expect(storeFlightLines().map((flight) => flight.spec)).toEqual(["polars (python)"]);
        expect(pendingAddLines()).toEqual([{ spec: "rpy2" }]);
    });

    test("a store that does not answer blocks the gate with the instruction of the client", async () => {
        const notices: Notice[] = [];
        const gate = seams({
            notices,
            readStore: () => errAsync({ type: "unreachable", reason: "connection_failed", baseUrl: "http://127.0.0.1:1", cause: null }),
        });

        expect(await awaitSandboxReady("a1", gate)).toBe("blocked");
        expect(notices.map((notice) => notice.text).join("\n")).toContain("inflexa serve");
    });
});
