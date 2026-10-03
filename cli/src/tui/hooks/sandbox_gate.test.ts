import { afterEach, describe, expect, test } from "bun:test";
import { errAsync, okAsync } from "neverthrow";

import type { StoreState, TransferReportView } from "../../api/store.ts";
import type { Notice } from "../theme.ts";
import {
    awaitTransfersSettled,
    pendingAddLines,
    refreshTransferState,
    storeFlightLines,
    transferReports,
    __resetSandboxGateForTest,
    type SandboxGateSeams,
} from "./sandbox_gate.tsx";

// The hold waits while a transfer is live. It starts NO TRANSFER and it opens
// NO consent — the options below carry no transfer start and no dialog, which
// makes that structural rather than asserted. The server decides if a sandbox
// can start (`server/sandbox_gate.test.ts`).

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

/** An option set whose fields a test overrides. The defaults describe a store with no transfer. */
function seams(over: Partial<SandboxGateSeams> & { notices?: Notice[] }): SandboxGateSeams {
    const notices = over.notices ?? [];
    return {
        readStore: () => storeWith([]),
        notify: (notice) => notices.push(notice),
        pollMs: 5,
        ...over,
    };
}

afterEach(() => {
    __resetSandboxGateForTest();
});

describe("awaitTransfersSettled", () => {
    test("passes when nothing moves", async () => {
        expect(await awaitTransfersSettled(seams({}))).toBe("ready");
    });

    test("waits while a transfer is live, and passes only after it settles", async () => {
        let reads = 0;
        const notices: Notice[] = [];
        const gate = seams({
            notices,
            readStore: () => {
                reads += 1;
                return storeWith(reads < 3 ? [report("catalog", "running", true)] : [report("catalog", "installed", false)]);
            },
        });

        expect(await awaitTransfersSettled(gate)).toBe("ready");
        expect(reads).toBeGreaterThanOrEqual(3);
        // The hold names what it waits for, one time.
        expect(notices.filter((notice) => notice.text.includes("Waiting for the catalog transfer"))).toHaveLength(1);
    });

    test("a terminal transfer state does not hold, because the server decides on the machine", async () => {
        const gate = seams({ readStore: () => storeWith([report("runtime_image", "failed", false, "The disk ran out.")]) });
        expect(await awaitTransfersSettled(gate)).toBe("ready");
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

        expect(await awaitTransfersSettled(gate)).toBe("blocked");
        expect(notices.map((notice) => notice.text).join("\n")).toContain("inflexa serve");
    });
});
