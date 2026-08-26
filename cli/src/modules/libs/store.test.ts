import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ok } from "neverthrow";

import { env } from "../../lib/env.ts";
import { instanceLockPath, PACKAGE_STORE_RECLAIM_LOCK_KEY } from "../../lib/lock.ts";
import { claimStoreFlight, deleteStoreFlight, settleStoreFlightFailure } from "../../db/primary_mutation.ts";
import { assertTestSandbox } from "../../test_support/sandbox.ts";
import type { CaptureResult } from "../../lib/container.ts";
import { FARM_LOCK_KEY_PREFIX } from "./composition.ts";
import type { ProvisionerRunner } from "./provisioner.ts";
import { readStoreFlights } from "./store_flight.ts";
import { collectStoreDebris, reclaimStore } from "./store.ts";

// The silent debris pass: it frees only the tier that nothing references — no
// farm link AND no graph node — plus the stale acquire reports, and it yields
// to any live work. Everything runs against a copied fixture and an injected
// runner; nothing here starts an engine.

const FIXTURE = join(import.meta.dir, "test-fixtures", "farm-parity");

/** A store directory outside the fixture graph: with no farm link it is debris. */
const DEBRIS_DIR = "orphan-1.0-000000000orphan1";

/** A store directory outside the graph that ONE farm links: the link keeps it. */
const LINKED_DIR = "kept-1.0-00000000000kept1";

const created: string[] = [];

function tempStore(): string {
    const root = mkdtempSync(join(tmpdir(), "inflexa-debris-"));
    created.push(root);
    cpSync(FIXTURE, root, { recursive: true });
    return root;
}

/** A runner that records each invocation and reports a green run. */
function countingRunner(invocations: (readonly string[])[]): ProvisionerRunner {
    return async (invocation) => {
        invocations.push([...invocation.args]);
        expect(invocation.egressAllow).toBeNull();
        return ok<CaptureResult, never>({ code: 0, stdout: "", stderr: "" });
    };
}

beforeEach(() => {
    assertTestSandbox(env.locksDir);
    for (const flight of readStoreFlights()) deleteStoreFlight(flight.row.id).unwrapOr(0);
});

afterEach(() => {
    for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
    rmSync(instanceLockPath(PACKAGE_STORE_RECLAIM_LOCK_KEY), { force: true });
    for (const flight of readStoreFlights()) deleteStoreFlight(flight.row.id).unwrapOr(0);
});

describe("collectStoreDebris", () => {
    test("the pass frees only the unlinked, unadvertised tier, plus the stale reports", async () => {
        const root = tempStore();
        mkdirSync(join(root, "store", DEBRIS_DIR), { recursive: true });
        mkdirSync(join(root, "store", LINKED_DIR), { recursive: true });
        mkdirSync(join(root, "farms", "a1"), { recursive: true });
        symlinkSync(join("..", "..", "store", LINKED_DIR, "pkg"), join(root, "farms", "a1", "pkg"));
        mkdirSync(join(root, ".inflexa-download"), { recursive: true });
        writeFileSync(join(root, ".inflexa-download", "acquire-4242-x.json"), "{}\n");
        writeFileSync(join(root, ".inflexa-download", "catalog.tmp"), "");
        const invocations: (readonly string[])[] = [];

        const outcome = (await collectStoreDebris(root, { run: countingRunner(invocations) }))._unsafeUnwrap();

        // Every graph-advertised directory and the farm-linked one stay out of
        // the preview: only the tier that NOTHING references is debris.
        expect(outcome).toEqual({ swept: true, dirs: [DEBRIS_DIR], reports: 1 });
        expect(invocations).toEqual([["reclaim", "--debris"]]);
    });

    test("a quiet store starts no container", async () => {
        const root = tempStore();
        const invocations: (readonly string[])[] = [];

        const outcome = (await collectStoreDebris(root, { run: countingRunner(invocations) }))._unsafeUnwrap();

        expect(outcome.swept).toBe(false);
        expect(invocations).toHaveLength(0);
    });

    test("the pass yields to a live flight, and it does not wait", async () => {
        const root = tempStore();
        mkdirSync(join(root, "store", DEBRIS_DIR), { recursive: true });
        claimStoreFlight({ id: "any::live::", ecosystem: null, name: "live", specifier: "", holderPid: process.pid })._unsafeUnwrap();
        const invocations: (readonly string[])[] = [];

        const outcome = (await collectStoreDebris(root, { run: countingRunner(invocations) }))._unsafeUnwrap();

        expect(outcome.swept).toBe(false);
        expect(invocations).toHaveLength(0);
    });

    test("a failed flight row blocks nothing", async () => {
        const root = tempStore();
        mkdirSync(join(root, "store", DEBRIS_DIR), { recursive: true });
        claimStoreFlight({ id: "any::gone::", ecosystem: null, name: "gone", specifier: "", holderPid: process.pid })._unsafeUnwrap();
        settleStoreFlightFailure({ id: "any::gone::", message: "resolve: the index timed out" })._unsafeUnwrap();
        const invocations: (readonly string[])[] = [];

        const outcome = (await collectStoreDebris(root, { run: countingRunner(invocations) }))._unsafeUnwrap();

        expect(outcome).toEqual({ swept: true, dirs: [DEBRIS_DIR], reports: 0 });
        expect(invocations).toHaveLength(1);
    });

    test("a failed flight row does not block the reclamation", async () => {
        const root = tempStore();
        // A debris directory justifies the run: the fixture's advertised
        // directories are inventory now, and the reclaim must not touch them.
        mkdirSync(join(root, "store", DEBRIS_DIR), { recursive: true });
        claimStoreFlight({ id: "any::gone::", ecosystem: null, name: "gone", specifier: "", holderPid: process.pid })._unsafeUnwrap();
        settleStoreFlightFailure({ id: "any::gone::", message: "resolve: the index timed out" })._unsafeUnwrap();
        const invocations: (readonly string[])[] = [];

        // A short wait bound: with the row wrongly read as live work, the run
        // refuses instead of removing, and the assertion below catches it.
        const outcome = (await reclaimStore({ storeRoot: root }, { run: countingRunner(invocations), flightWaitMs: 50, flightPollMs: 5 }))._unsafeUnwrap();

        expect(outcome.reclaimed).toEqual([DEBRIS_DIR]);
        expect(invocations).toEqual([["reclaim"]]);
    });

    test("a graph-advertised directory with no farm link is not a reclaim candidate", async () => {
        const root = tempStore();
        const invocations: (readonly string[])[] = [];

        const outcome = (await reclaimStore({ storeRoot: root }, { run: countingRunner(invocations), flightWaitMs: 50, flightPollMs: 5 }))._unsafeUnwrap();

        // The fixture holds no farm, thus every store directory carries only
        // its graph node — inventory, not waste. The preview is empty, and
        // the run starts no container over an empty candidate set.
        expect(outcome.reclaimed).toEqual([]);
        expect(invocations).toEqual([]);
    });

    test("a live flight row still refuses the reclamation", async () => {
        const root = tempStore();
        claimStoreFlight({ id: "any::live::", ecosystem: null, name: "live", specifier: "", holderPid: process.pid })._unsafeUnwrap();
        const invocations: (readonly string[])[] = [];

        const outcome = await reclaimStore({ storeRoot: root }, { run: countingRunner(invocations), flightWaitMs: 30, flightPollMs: 5 });

        if (!outcome.isErr()) throw new Error("expected the reclamation to refuse");
        expect(outcome.error.type).toBe("acquisition_in_flight");
        expect(invocations).toHaveLength(0);
    });

    test("the pass yields to a held reclaim lock and to a live composition", async () => {
        const root = tempStore();
        mkdirSync(join(root, "store", DEBRIS_DIR), { recursive: true });
        const holder = Bun.spawn(["sleep", "60"]);
        mkdirSync(env.locksDir, { recursive: true });
        const invocations: (readonly string[])[] = [];
        try {
            writeFileSync(instanceLockPath(PACKAGE_STORE_RECLAIM_LOCK_KEY), String(holder.pid));
            const heldLock = (await collectStoreDebris(root, { run: countingRunner(invocations) }))._unsafeUnwrap();
            expect(heldLock.swept).toBe(false);
            rmSync(instanceLockPath(PACKAGE_STORE_RECLAIM_LOCK_KEY), { force: true });

            writeFileSync(instanceLockPath(`${FARM_LOCK_KEY_PREFIX}a1`), String(holder.pid));
            const liveComposition = (await collectStoreDebris(root, { run: countingRunner(invocations) }))._unsafeUnwrap();
            expect(liveComposition.swept).toBe(false);

            expect(invocations).toHaveLength(0);
        } finally {
            rmSync(instanceLockPath(`${FARM_LOCK_KEY_PREFIX}a1`), { force: true });
            holder.kill();
            await holder.exited;
        }
    });
});
