import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ok } from "neverthrow";

import { env } from "../../lib/env.ts";
import { acquireInstanceLock, instanceLockPath, PACKAGE_STORE_RECLAIM_LOCK_KEY, releaseInstanceLock } from "../../lib/lock.ts";
import {
    claimPendingStoreAdds,
    claimStoreFlight,
    deleteStoreFlight,
    settleStoreFlightFailure,
    settleTransfer,
    startTransferRun,
} from "../../db/primary_mutation.ts";
import { assertTestSandbox } from "../../test_support/sandbox.ts";
import type { CaptureResult } from "../../lib/container.ts";
import { FARM_LOCK_KEY_PREFIX } from "./composition.ts";
import type { ProvisionerRunner } from "./provisioner.ts";
import { readStoreFlights } from "./store_flight.ts";
import { listPendingStoreAdds } from "../../db/primary_query.ts";
import { transferLockKey } from "./transfers.ts";
import { cancelCatalogTransfer, storeDownloadPaths } from "./store_download.ts";
import { collectStoreDebris, describeRequestRefusal, reclaimStore, runStoreAdd, runStoreDownload } from "./store.ts";

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
    // The pending set is one table for the whole process. A row that outlived
    // its test would count in the next one.
    claimPendingStoreAdds().unwrapOr([]);
});

afterEach(() => {
    for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
    rmSync(instanceLockPath(PACKAGE_STORE_RECLAIM_LOCK_KEY), { force: true });
    for (const flight of readStoreFlights()) deleteStoreFlight(flight.row.id).unwrapOr(0);
    claimPendingStoreAdds().unwrapOr([]);
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
        claimStoreFlight({ id: "any::live::", ecosystem: null, spelling: "live", specifier: "", holderPid: process.pid })._unsafeUnwrap();
        const invocations: (readonly string[])[] = [];

        const outcome = (await collectStoreDebris(root, { run: countingRunner(invocations) }))._unsafeUnwrap();

        expect(outcome.swept).toBe(false);
        expect(invocations).toHaveLength(0);
    });

    test("a failed flight row blocks nothing", async () => {
        const root = tempStore();
        mkdirSync(join(root, "store", DEBRIS_DIR), { recursive: true });
        claimStoreFlight({ id: "any::gone::", ecosystem: null, spelling: "gone", specifier: "", holderPid: process.pid })._unsafeUnwrap();
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
        claimStoreFlight({ id: "any::gone::", ecosystem: null, spelling: "gone", specifier: "", holderPid: process.pid })._unsafeUnwrap();
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
        claimStoreFlight({ id: "any::live::", ecosystem: null, spelling: "live", specifier: "", holderPid: process.pid })._unsafeUnwrap();
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

describe("runStoreDownload --foreground", () => {
    afterEach(() => {
        releaseInstanceLock(transferLockKey("catalog"));
        settleTransfer("catalog", { state: "canceled", message: null }).unwrapOr(undefined);
        process.exitCode = 0;
    });

    test("a failed settle exits 1 and prints the recorded message", async () => {
        const transfer = async (): Promise<void> => {
            startTransferRun("catalog", { state: "running", holderPid: process.pid })._unsafeUnwrap();
            settleTransfer("catalog", { state: "failed", message: "resolve: the registry said no" })._unsafeUnwrap();
        };

        await runStoreDownload({ foreground: true }, { transfer });

        expect(process.exitCode).toBe(1);
    });

    test("a live detached transfer refuses the foreground run", async () => {
        startTransferRun("catalog", { state: "running", holderPid: process.pid })._unsafeUnwrap();
        // This process holds the lock, thus the report reads the transfer as live.
        expect(acquireInstanceLock(transferLockKey("catalog")).acquired).toBe(true);
        let ran = 0;
        const transfer = async (): Promise<void> => {
            ran += 1;
        };

        await runStoreDownload({ foreground: true }, { transfer });

        expect(process.exitCode).toBe(1);
        expect(ran).toBe(0);
    });

    test("an installed settle exits clean", async () => {
        const transfer = async (): Promise<void> => {
            startTransferRun("catalog", { state: "running", holderPid: process.pid })._unsafeUnwrap();
            settleTransfer("catalog", { state: "installed", message: null })._unsafeUnwrap();
        };

        await runStoreDownload({ foreground: true }, { transfer });

        expect(process.exitCode ?? 0).toBe(0);
    });
});

/**
 * Run `fn` with `console.error` captured, and restore the exit code. A refused
 * command marks the process failed, and a leaked code would fail the whole
 * single-process run.
 */
async function captureRefusal(fn: () => Promise<void>): Promise<{ stderr: string; exitCode: typeof process.exitCode }> {
    const origLog = console.log;
    const origError = console.error;
    const origExitCode = process.exitCode;
    let stderr = "";
    console.log = () => undefined;
    console.error = (msg?: unknown) => {
        stderr += `${String(msg)}\n`;
    };
    try {
        await fn();
        return { stderr, exitCode: process.exitCode };
    } finally {
        console.log = origLog;
        console.error = origError;
        // Bun ignores an `undefined` assignment, thus a captured failure code
        // clears with an explicit 0.
        process.exitCode = origExitCode ?? 0;
    }
}

describe("the argument of `store add`", () => {
    test("a pinned argument records the spelling and the specifier", async () => {
        await captureRefusal(() => runStoreAdd("scanpy==1.11", { version: null, lang: null, analysis: null, queued: true }));

        const pending = listPendingStoreAdds()._unsafeUnwrap();
        expect(pending).toHaveLength(1);
        expect(pending[0]?.spelling).toBe("scanpy");
        expect(pending[0]?.specifier).toBe("==1.11");
    });

    test("a prefix at the command surface refuses, and the refusal names the flag", async () => {
        // The command surface names an ecosystem with `--lang`. Two ways to say
        // one thing is what lets a flag and an argument disagree.
        const { stderr, exitCode } = await captureRefusal(() => runStoreAdd("r:Seurat", { version: null, lang: null, analysis: null, queued: true }));

        expect(stderr).toContain("--lang r");
        expect(exitCode).toBe(1);
        expect(listPendingStoreAdds()._unsafeUnwrap()).toHaveLength(0);
    });

    test("a version in the argument and a `--version` that disagree refuse", async () => {
        const { stderr, exitCode } = await captureRefusal(() => runStoreAdd("scanpy==1.11", { version: "1.12", lang: null, analysis: null, queued: true }));

        expect(stderr).toContain("two versions");
        expect(exitCode).toBe(1);
        expect(listPendingStoreAdds()._unsafeUnwrap()).toHaveLength(0);
    });

    test("an unknown prefix refuses with the flag, and a range specifier refuses with the exact-version rule", async () => {
        const prefix = await captureRefusal(() => runStoreAdd("bioc:fgsea", { version: null, lang: null, analysis: null, queued: true }));
        expect(prefix.stderr).toContain("--lang python");

        const range = await captureRefusal(() => runStoreAdd("numpy>=1.26", { version: null, lang: null, analysis: null, queued: true }));
        expect(range.stderr).toContain(">=");

        expect(listPendingStoreAdds()._unsafeUnwrap()).toHaveLength(0);
    });
});

describe("describeRequestRefusal", () => {
    // The graph keys the identity of each track, and an R name is case- and
    // dot-sensitive. Each refusal and each remedy must echo the spelling of
    // the query: `store add go-db` acquires nothing, `store add GO.db` does.
    test("each refusal echoes the spelling of the query, never an address", () => {
        const unknown = describeRequestRefusal({ type: "unknown_distribution" }, { spelling: "GO.db", track: "r" });
        expect(unknown).toContain('"GO.db"');
        expect(unknown).toContain("store add GO.db");
        expect(unknown).not.toContain("go-db");

        const version = describeRequestRefusal({ type: "unknown_version", version: "3.18", available: ["3.19"] }, { spelling: "GO.db", track: "r" });
        expect(version).toContain('"GO.db"');
        expect(version).toContain("store add GO.db --version 3.18");
        expect(version).not.toContain("go-db");

        const both = describeRequestRefusal(
            { type: "ambiguous_ecosystem", identities: ["python:go-db", "r:GO.db"], candidates: ["go-db-1.0-py", "go-db-1.0-r"] },
            { spelling: "GO.db" },
        );
        expect(both).toContain('"GO.db"');
        // The two candidates are store directories, and they stay verbatim —
        // only the asked SPELLING obeys the echo rule.
        expect(both).toContain("--lang python");
    });

    test("an unknown name renders the spelling of its suggestion before the store-add ask", () => {
        // The pool holds `Seurat`, and an R name is case-sensitive. An
        // acquisition of `seurat` would be needless work, thus the spelling
        // that links comes first. The error carries the identity KEY, and the
        // render quotes the spelling inside it — `store add r:Seurat` refuses
        // at this surface.
        const refusal = describeRequestRefusal({ type: "unknown_distribution", suggestion: "r:Seurat" }, { spelling: "seurat" });

        expect(refusal).toContain('"Seurat"');
        expect(refusal).not.toContain("r:Seurat");
        expect(refusal).toContain("store add seurat");
        expect(refusal.indexOf('"Seurat"')).toBeLessThan(refusal.indexOf("store add seurat"));
    });
});

describe("cancelCatalogTransfer", () => {
    test("a timed-out stop keeps the staged tree and settles nothing", async () => {
        const root = tempStore();
        // The child still writes into this tree — a removal here can tear a
        // rename mid-flight, and the torn merge can read back as complete.
        const staging = storeDownloadPaths(root).staging;
        mkdirSync(staging, { recursive: true });
        writeFileSync(join(staging, "half-written.tar"), "bytes\n");

        const outcome = await cancelCatalogTransfer(root, async () => ({ type: "timed_out" as const, holderPid: 4242 }));

        expect(outcome).toEqual({ type: "timed_out", holderPid: 4242 });
        expect(existsSync(join(staging, "half-written.tar"))).toBe(true);
    });
});

describe("the in-process debris single-flight", () => {
    test("a second concurrent collection joins the live pass, and one container runs", async () => {
        const root = tempStore();
        mkdirSync(join(root, "store", DEBRIS_DIR), { recursive: true });
        let runs = 0;
        const run: ProvisionerRunner = async () => {
            runs += 1;
            // The pause holds the pass live while the second caller arrives.
            await Promise.sleep(50);
            return ok({ code: 0, stdout: "", stderr: "" });
        };

        const [first, second] = await Promise.all([collectStoreDebris(root, { run }), collectStoreDebris(root, { run })]);

        // The joiner gets the outcome of the live pass, and no second pass
        // enters beside it — an entry beside the first would free the
        // re-entrant reclaim lock under it.
        expect(runs).toBe(1);
        expect(first._unsafeUnwrap()).toEqual(second._unsafeUnwrap());
        expect(first._unsafeUnwrap().swept).toBe(true);
    });
});
