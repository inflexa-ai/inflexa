import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { randomUUIDv7 } from "bun";
import { ok } from "neverthrow";

import type { SandboxReadiness } from "../api/runs.ts";
import { composeFullFarm, takeFarmCompositionFailure } from "../modules/libs/composition.ts";
import type { TransferReport } from "../modules/libs/transfers.ts";
import type { TransferKind, TransferStatus } from "../types/store.ts";
import { INPUT_DRIFT_SANDBOX_GATE_OPTS, readSandboxReadiness, sandboxRefusal, type SandboxGateOpts, type SandboxReadinessOpts } from "./sandbox_gate.ts";

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
        readFarmFailure: takeFarmCompositionFailure,
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
            readFarmFailure: (analysisId) => {
                expect(analysisId).toBe("a1");
                return { analysisId, reason: "the catalog farm is absent" };
            },
        });
        expect(await sandboxRefusal("a1", gate)).toContain("could not be composed: the catalog farm is absent");
    });

    test("the gate takes the record when it reads the machine, also when an image refusal comes first", async () => {
        const taken: string[] = [];
        const gate = opts({
            readiness: () => Promise.resolve(machine({ image: { state: "absent", image: "ghcr.io/inflexa-ai/sandbox-base:latest" } })),
            readFarmFailure: (analysisId) => {
                taken.push(analysisId);
                return null;
            },
        });
        expect(await sandboxRefusal("a1", gate)).toContain("`inflexa sandbox pull`");
        expect(taken).toEqual(["a1"]);
    });

    test("a refusal for a live transfer does not take the record", async () => {
        const gate = opts({ transfers: () => [report("catalog", "running", true)], readFarmFailure: unexpected("readFarmFailure") });
        expect(await sandboxRefusal("a1", gate)).toContain("`inflexa sandbox status`");
    });
});

describe("a readiness read leaves the farm failure for the gate", () => {
    test("two reads report the failure, the gate names it, and the next read reports none", async () => {
        const storeRoot = mkdtempSync(join(tmpdir(), "inflexa-gate-"));
        try {
            const analysisId = randomUUIDv7();
            // No catalog farm in an empty store, thus the composition fails and records the reason.
            expect((await composeFullFarm({ storeRoot, analysisId })).isErr()).toBe(true);
            const readOpts: SandboxReadinessOpts = {
                imageReadiness: (image) => Promise.resolve({ state: "present", image }),
                inspectStoreContent: () => Promise.resolve("installed"),
            };
            const read = () => readSandboxReadiness(analysisId, readOpts);

            const first = (await read()).farm.failure;
            expect(first).toContain("the catalog farm is absent");
            expect((await read()).farm.failure).toBe(first);

            const gate = opts({ readiness: read, readFarmFailure: takeFarmCompositionFailure });
            expect(await sandboxRefusal(analysisId, gate)).toContain(`could not be composed: ${first}`);
            expect((await read()).farm.failure).toBeNull();
        } finally {
            rmSync(storeRoot, { recursive: true, force: true });
        }
    });
});

describe("the gate of the re-profile after an input change", () => {
    test("names a recorded farm failure, and leaves it for the next drive that a person starts", async () => {
        const storeRoot = mkdtempSync(join(tmpdir(), "inflexa-gate-"));
        const analysisId = randomUUIDv7();
        try {
            // No catalog farm in an empty store, thus the composition fails and records the reason.
            expect((await composeFullFarm({ storeRoot, analysisId })).isErr()).toBe(true);
            const gate: SandboxGateOpts = {
                ...INPUT_DRIFT_SANDBOX_GATE_OPTS,
                inputCount: () => ok(1),
                transfers: () => [],
                readiness: () => Promise.resolve(machine()),
            };

            expect(await sandboxRefusal(analysisId, gate)).toContain("the catalog farm is absent");
            expect(await sandboxRefusal(analysisId, gate)).toContain("the catalog farm is absent");
            expect(await sandboxRefusal(analysisId, opts({ readFarmFailure: takeFarmCompositionFailure }))).toContain("the catalog farm is absent");
        } finally {
            takeFarmCompositionFailure(analysisId);
            rmSync(storeRoot, { recursive: true, force: true });
        }
    });
});
