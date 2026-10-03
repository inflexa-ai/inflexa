import { describe, expect, test } from "bun:test";
import { ok } from "neverthrow";

import type { SandboxReadiness } from "../api/runs.ts";
import type { TransferReport } from "../modules/libs/transfers.ts";
import type { TransferKind, TransferStatus } from "../types/store.ts";
import { sandboxRefusal, type SandboxGateOpts } from "./sandbox_gate.ts";

/** One transfer report as `readTransferReports` gives it, with everything else quiet. */
function report(kind: TransferKind, state: TransferStatus | null, live: boolean, message: string | null = null): TransferReport {
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

/** A machine with everything present. */
function machine(over: Partial<Omit<SandboxReadiness, "inputCount">> = {}): Omit<SandboxReadiness, "inputCount"> {
    return {
        image: { state: "present", image: "ghcr.io/inflexa-ai/sandbox-base:latest" },
        store: "installed",
        farm: { present: true, catalogPresent: true, failure: null },
        ...over,
    };
}

/** The gate over one input, no transfer, and a machine with everything present, unless `over` says different. */
function opts(over: Partial<SandboxGateOpts> = {}): SandboxGateOpts {
    return {
        inputCount: () => ok(1),
        transfers: () => [],
        readiness: () => Promise.resolve(machine()),
        ...over,
    };
}

function unexpected(name: string): () => never {
    return () => {
        throw new Error(`the test did not expect a call of ${name}`);
    };
}

describe("sandboxRefusal", () => {
    test("a machine with the image and the store gives no refusal", async () => {
        expect(await sandboxRefusal("a1", opts())).toBeNull();
    });

    test("an analysis with no inputs needs no sandbox, thus it reads neither the transfers nor the machine", async () => {
        const gate = opts({ inputCount: () => ok(0), transfers: unexpected("transfers"), readiness: unexpected("readiness") });
        expect(await sandboxRefusal("a1", gate)).toBeNull();
    });

    test("a live transfer refuses before the machine read, thus a recorded farm failure stays for the next check", async () => {
        const gate = opts({ transfers: () => [report("catalog", "running", true)], readiness: unexpected("readiness") });
        expect(await sandboxRefusal("a1", gate)).toContain("`inflexa sandbox status`");
    });

    test("an absent image refuses with the pull command, and the reason of the failed row rides along", async () => {
        const gate = opts({
            transfers: () => [report("runtime_image", "failed", false, "The disk ran out.\nThe stack.")],
            readiness: () => Promise.resolve(machine({ image: { state: "absent", image: "ghcr.io/inflexa-ai/sandbox-base:latest" } })),
        });
        expect(await sandboxRefusal("a1", gate)).toBe("The sandbox image is not installed. The disk ran out. Run `inflexa sandbox pull` to download it.");
    });

    test("a missing store refuses with the download command, and a declined state says so", async () => {
        const gate = opts({ transfers: () => [report("catalog", "declined", false)], readiness: () => Promise.resolve(machine({ store: "missing" })) });
        expect(await sandboxRefusal("a1", gate)).toBe(
            "The package store was declined at setup, and the analysis sandbox needs it. Run `inflexa store download` to obtain it.",
        );
    });

    test("a locally built store passes, because the filesystem decides and not the row", async () => {
        const gate = opts({ transfers: () => [report("catalog", "canceled", false)], readiness: () => Promise.resolve(machine({ store: "local" })) });
        expect(await sandboxRefusal("a1", gate)).toBeNull();
    });

    test("a recorded farm failure refuses with its reason", async () => {
        const gate = opts({
            readiness: (analysisId) => {
                expect(analysisId).toBe("a1");
                return Promise.resolve(machine({ farm: { present: true, catalogPresent: true, failure: "the catalog farm is absent" } }));
            },
        });
        expect(await sandboxRefusal("a1", gate)).toContain("could not be composed: the catalog farm is absent");
    });
});
