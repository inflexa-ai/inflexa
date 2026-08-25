import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ok } from "neverthrow";

import { env } from "../../lib/env.ts";
import { instanceLockPath, PACKAGE_STORE_RECLAIM_LOCK_KEY } from "../../lib/lock.ts";
import { db } from "../../db/primary.ts";
import { listPendingStoreAdds } from "../../db/primary_query.ts";
import { claimPendingStoreAdds, claimStoreFlight, deleteStoreFlight, settleStoreFlightFailure } from "../../db/primary_mutation.ts";
import { assertTestSandbox } from "../../test_support/sandbox.ts";
import type { CaptureResult } from "../../lib/container.ts";
import { classifyPoolMiss, describeRecordedFlightFailure, enqueueStoreAdd, flushPendingStoreAdds, readStoreFlights, storeFlightKey } from "./store_flight.ts";
import { flushAndPrint } from "./store.ts";
import type { LoadCheckRunner, ProvisionerRunner } from "./provisioner.ts";

// The flush is the two-phase flight over the pending set: one provisioner
// `acquire` run for the whole batch, the load check inside the sandbox image,
// and the commit of the staged nodes under the metadata lock. Every container
// seam is injected, so nothing here starts an engine.

const FIXTURE = join(import.meta.dir, "test-fixtures", "farm-parity");

const created: string[] = [];

function tempStore(): string {
    const root = mkdtempSync(join(tmpdir(), "inflexa-flight-"));
    created.push(root);
    cpSync(FIXTURE, root, { recursive: true });
    mkdirSync(join(root, ".inflexa-download"), { recursive: true });
    return root;
}

/** The report path a fake runner writes: the host half of the `--report /mnt/libs/<name>` argument. */
function reportPathOf(storeRoot: string, args: readonly string[]): string {
    const at = args.indexOf("--report");
    const containerPath = args[at + 1] ?? "";
    return join(storeRoot, containerPath.replace(/^\/mnt\/libs\//, ""));
}

/** A runner that acquires one fake distribution: it writes the pool directory, the markers, and the report. */
function acquiringRunner(outcomesBySpec: Record<string, unknown>, nodes: Record<string, unknown>): ProvisionerRunner {
    return async (invocation, onLine) => {
        onLine("[provision] fake acquire");
        for (const dir of Object.keys(nodes)) {
            const home = join(invocation.storeRoot, "store", dir);
            mkdirSync(join(home, dir.split("-")[0] ?? "pkg"), { recursive: true });
            writeFileSync(join(home, ".inflexa-pin"), "x==1\n");
            writeFileSync(join(home, ".inflexa-hash"), `${"a".repeat(64)}\n`);
        }
        const report = {
            schema: 1,
            arch: "arm64",
            outcomes: Object.entries(outcomesBySpec).map(([spec, outcome]) => ({ spec, ...(outcome as Record<string, unknown>) })),
            nodes,
        };
        writeFileSync(reportPathOf(invocation.storeRoot, invocation.args), `${JSON.stringify(report, null, 2)}\n`);
        return ok<CaptureResult, never>({ code: 0, stdout: "", stderr: "" });
    };
}

/** A load check with a fixed verdict per staged directory. */
function loadCheck(failing: readonly string[]): LoadCheckRunner {
    return async (params) => {
        const raw = JSON.parse(readFileSync(join(params.storeRoot, params.reportName), "utf8")) as { nodes: Record<string, unknown> };
        const results = Object.keys(raw.nodes).map((dir) => ({ package: dir, track: "python", ok: !failing.includes(dir) }));
        return ok<CaptureResult, never>({ code: results.every((r) => r.ok) ? 0 : 1, stdout: JSON.stringify({ results }), stderr: "" });
    };
}

beforeEach(() => {
    assertTestSandbox(env.locksDir);
    // The pending set and the flight rows persist in the sandboxed database;
    // every test starts empty. A `failed` row is durable by design, thus the
    // sweep alone does not clear it.
    claimPendingStoreAdds().unwrapOr([]);
    for (const flight of readStoreFlights()) deleteStoreFlight(flight.row.id).unwrapOr(0);
});

afterEach(() => {
    for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
    rmSync(instanceLockPath(PACKAGE_STORE_RECLAIM_LOCK_KEY), { force: true });
    claimPendingStoreAdds().unwrapOr([]);
    for (const flight of readStoreFlights()) {
        deleteStoreFlight(flight.row.id).unwrapOr(0);
        rmSync(instanceLockPath(flight.row.id), { force: true });
    }
});

describe("the pending set", () => {
    test("an enqueue lands once per spec and analysis, and the listing renders it", () => {
        enqueueStoreAdd({ name: "Scanpy", version: null, ecosystem: null, analysisId: null })._unsafeUnwrap();
        enqueueStoreAdd({ name: "SCAN_PY", version: null, ecosystem: null, analysisId: null })._unsafeUnwrap();

        const pending = listPendingStoreAdds()._unsafeUnwrap();
        // PEP 503 canonicalizes: the case folds, and each separator run becomes
        // one hyphen. `SCAN_PY` is a different distribution (`scan-py`), and a
        // second spelling of `scanpy` is the same one.
        expect(pending.map((entry) => entry.name).sort()).toEqual(["scan-py", "scanpy"]);
        enqueueStoreAdd({ name: "SCANPY", version: null, ecosystem: null, analysisId: null })._unsafeUnwrap();
        expect(listPendingStoreAdds()._unsafeUnwrap()).toHaveLength(2);
        expect(pending[0]?.name).toBe("scanpy");
        expect(pending[0]?.ecosystem).toBeNull();
    });

    test("a version and an ecosystem key separate entries", () => {
        enqueueStoreAdd({ name: "igraph", version: null, ecosystem: "python", analysisId: null })._unsafeUnwrap();
        enqueueStoreAdd({ name: "igraph", version: null, ecosystem: "r", analysisId: null })._unsafeUnwrap();
        enqueueStoreAdd({ name: "igraph", version: "0.11", ecosystem: "python", analysisId: null })._unsafeUnwrap();

        expect(listPendingStoreAdds()._unsafeUnwrap()).toHaveLength(3);
    });

    test("the claim takes the whole set atomically, thus a second flusher runs nothing", () => {
        enqueueStoreAdd({ name: "alpha", version: null, ecosystem: "python", analysisId: null })._unsafeUnwrap();

        const first = claimPendingStoreAdds()._unsafeUnwrap();
        const second = claimPendingStoreAdds()._unsafeUnwrap();

        expect(first).toHaveLength(1);
        expect(second).toHaveLength(0);
    });
});

describe("flushPendingStoreAdds", () => {
    test("an empty pending set flushes to nothing, and no runner starts", async () => {
        let ran = 0;
        const run: ProvisionerRunner = async () => {
            ran += 1;
            return ok({ code: 0, stdout: "", stderr: "" });
        };

        const result = (await flushPendingStoreAdds(tempStore(), { run }))._unsafeUnwrap();

        expect(result).toEqual({ type: "empty" });
        expect(ran).toBe(0);
    });

    test("one batch, one acquire run, per-spec outcomes, and the green set commits to the graph", async () => {
        const root = tempStore();
        enqueueStoreAdd({ name: "newpkg", version: null, ecosystem: "python", analysisId: null })._unsafeUnwrap();
        enqueueStoreAdd({ name: "ghost", version: null, ecosystem: null, analysisId: null })._unsafeUnwrap();
        const NEW_DIR = "newpkg-1.0-00000000000new01";
        const invocations: string[][] = [];
        const run: ProvisionerRunner = async (invocation, onLine) => {
            invocations.push([...invocation.args]);
            expect(invocation.egressAllow).toContain("pypi.org");
            return acquiringRunner(
                {
                    "python:newpkg": { outcome: "acquired", store_dirs: [NEW_DIR] },
                    ghost: { outcome: "refused", reason: "no ecosystem holds the name" },
                },
                { [NEW_DIR]: { track: "python", name: "newpkg", version: "1.0", order: "0a", edges: [] } },
            )(invocation, onLine);
        };

        const result = (await flushPendingStoreAdds(root, { run, loadCheck: loadCheck([]) }))._unsafeUnwrap();

        // ONE provisioner run resolved the whole batch.
        expect(invocations).toHaveLength(1);
        expect(invocations[0]).toContain("python:newpkg");
        expect(invocations[0]).toContain("ghost");
        if (result.type !== "flew") throw new Error(`expected a flight, got ${result.type}`);
        const kinds = new Map(result.outcomes.map((outcome) => [outcome.spec.name, outcome.kind]));
        expect(kinds.get("newpkg")).toBe("acquired");
        expect(kinds.get("ghost")).toBe("refused");
        // The commit appended the staged node under the metadata lock, and the graph
        // orders the new name by its own record.
        const graph = JSON.parse(readFileSync(join(root, "deps.json"), "utf8")) as {
            nodes: Record<string, unknown>;
            by_name: { python: Record<string, string[]> };
        };
        expect(graph.nodes[NEW_DIR]).toBeDefined();
        expect(graph.by_name.python["newpkg"]).toEqual([NEW_DIR]);
        // The acquired flight deleted its row — a success that everyone has is
        // noise. The refused spec settled as the ONE durable `failed` row, with
        // the phase and the whole reason.
        const rows = readStoreFlights();
        expect(rows).toHaveLength(1);
        expect(rows[0]?.row.state).toBe("failed");
        expect(rows[0]?.row.name).toBe("ghost");
        expect(rows[0]?.row.message).toBe("resolve: no ecosystem holds the name");
        // The pending set drained.
        expect(listPendingStoreAdds()._unsafeUnwrap()).toHaveLength(0);
    });

    test("a both-hit spec stops with its two candidates, and the rest of the set still lands", async () => {
        const root = tempStore();
        enqueueStoreAdd({ name: "igraph", version: null, ecosystem: null, analysisId: null })._unsafeUnwrap();
        const run = acquiringRunner(
            {
                igraph: {
                    outcome: "both_hit",
                    candidates: [
                        { ecosystem: "python", name: "igraph" },
                        { ecosystem: "r", name: "igraph" },
                    ],
                },
            },
            {},
        );

        const result = (await flushPendingStoreAdds(root, { run, loadCheck: loadCheck([]) }))._unsafeUnwrap();

        if (result.type !== "flew") throw new Error(`expected a flight, got ${result.type}`);
        expect(result.outcomes).toEqual([
            {
                kind: "both_hit",
                spec: { ecosystem: null, name: "igraph", specifier: "" },
                candidates: [
                    { ecosystem: "python", name: "igraph" },
                    { ecosystem: "r", name: "igraph" },
                ],
            },
        ]);
    });

    test("a red load check drops the spec, commits nothing for it, and reports the refusal", async () => {
        const root = tempStore();
        enqueueStoreAdd({ name: "badpkg", version: null, ecosystem: "python", analysisId: null })._unsafeUnwrap();
        const BAD_DIR = "badpkg-1.0-00000000000bad01";
        const run = acquiringRunner(
            { "python:badpkg": { outcome: "acquired", store_dirs: [BAD_DIR] } },
            { [BAD_DIR]: { track: "python", name: "badpkg", version: "1.0", order: "0a", edges: [] } },
        );

        const result = (await flushPendingStoreAdds(root, { run, loadCheck: loadCheck([BAD_DIR]) }))._unsafeUnwrap();

        if (result.type !== "flew") throw new Error(`expected a flight, got ${result.type}`);
        expect(result.outcomes[0]?.kind).toBe("refused");
        // No advertised state: the graph holds no node for the failed package. The
        // pool bytes stay, and the debris pass frees them.
        const graph = JSON.parse(readFileSync(join(root, "deps.json"), "utf8")) as { nodes: Record<string, unknown> };
        expect(graph.nodes[BAD_DIR]).toBeUndefined();
        expect(existsSync(join(root, "store", BAD_DIR))).toBe(true);
        // The refusal settled durably, with the load-check phase in front.
        const rows = readStoreFlights();
        expect(rows).toHaveLength(1);
        expect(rows[0]?.row.state).toBe("failed");
        expect(rows[0]?.row.message).toStartWith("load_check: ");
        expect(rows[0]?.row.message).toContain(BAD_DIR);
    });

    test("a retry of a failed spec claims the same row, and its success clears the failure", async () => {
        const root = tempStore();
        enqueueStoreAdd({ name: "flaky", version: null, ecosystem: "python", analysisId: null })._unsafeUnwrap();
        const refusing = acquiringRunner({ "python:flaky": { outcome: "refused", reason: "the index timed out" } }, {});
        (await flushPendingStoreAdds(root, { run: refusing, loadCheck: loadCheck([]) }))._unsafeUnwrap();
        const failedRow = readStoreFlights()[0];
        expect(failedRow?.row.state).toBe("failed");
        expect(failedRow?.row.message).toBe("resolve: the index timed out");

        const FLAKY_DIR = "flaky-1.0-0000000000flaky1";
        enqueueStoreAdd({ name: "flaky", version: null, ecosystem: "python", analysisId: null })._unsafeUnwrap();
        const succeeding = acquiringRunner(
            { "python:flaky": { outcome: "acquired", store_dirs: [FLAKY_DIR] } },
            { [FLAKY_DIR]: { track: "python", name: "flaky", version: "1.0", order: "0a", edges: [] } },
        );
        const retried = (await flushPendingStoreAdds(root, { run: succeeding, loadCheck: loadCheck([]) }))._unsafeUnwrap();

        if (retried.type !== "flew") throw new Error(`expected a flight, got ${retried.type}`);
        // The retry CLAIMED the failed row (it did not read as "joined"), flew,
        // and its success deleted the row — no stale failure line stays.
        expect(retried.outcomes[0]?.kind).toBe("acquired");
        expect(readStoreFlights()).toHaveLength(0);
    });

    test("a broken flight ledger is its own refusal, never a join", async () => {
        const root = tempStore();
        enqueueStoreAdd({ name: "alpha", version: null, ecosystem: "python", analysisId: null })._unsafeUnwrap();
        let ran = 0;
        const run: ProvisionerRunner = async () => {
            ran += 1;
            return ok({ code: 0, stdout: "", stderr: "" });
        };
        const conn = db()._unsafeUnwrap();
        conn.run("ALTER TABLE package_store_flights RENAME TO package_store_flights_broken");
        try {
            const result = (await flushPendingStoreAdds(root, { run }))._unsafeUnwrap();

            if (result.type !== "flew") throw new Error(`expected a flight, got ${result.type}`);
            expect(result.outcomes).toHaveLength(1);
            const outcome = result.outcomes[0];
            if (outcome?.kind !== "refused") throw new Error(`expected a refusal, got ${outcome?.kind}`);
            // The refusal names the ledger problem, and no acquire run started:
            // "joined" would promise that somebody else does the work.
            expect(outcome.reason).toContain("flight ledger");
            expect(ran).toBe(0);
        } finally {
            conn.run("ALTER TABLE package_store_flights_broken RENAME TO package_store_flights");
        }
    });

    test("a live reclamation defers the batch and puts the approvals back", async () => {
        const root = tempStore();
        enqueueStoreAdd({ name: "alpha", version: null, ecosystem: "python", analysisId: null })._unsafeUnwrap();
        const holder = Bun.spawn(["sleep", "60"]);
        mkdirSync(env.locksDir, { recursive: true });
        writeFileSync(instanceLockPath(PACKAGE_STORE_RECLAIM_LOCK_KEY), String(holder.pid));
        let ran = 0;
        const run: ProvisionerRunner = async () => {
            ran += 1;
            return ok({ code: 0, stdout: "", stderr: "" });
        };

        try {
            const result = (await flushPendingStoreAdds(root, { run, reclaimWaitMs: 20, pollMs: 5 }))._unsafeUnwrap();

            expect(result.type).toBe("deferred");
            expect(ran).toBe(0);
            // The approval survives: the next flush takes it.
            expect(listPendingStoreAdds()._unsafeUnwrap()).toHaveLength(1);
        } finally {
            holder.kill();
            await holder.exited;
        }
    });
});

describe("the flush tail", () => {
    // The trigger of the silent debris pass: only a flush that ended with
    // refusals starts one, and the pass itself is tested in `store.test.ts`.

    test("a refusal triggers the debris pass over the refused bytes", async () => {
        const root = tempStore();
        enqueueStoreAdd({ name: "badpkg", version: null, ecosystem: "python", analysisId: null })._unsafeUnwrap();
        const BAD_DIR = "badpkg-1.0-00000000000bad02";
        const run = acquiringRunner(
            { "python:badpkg": { outcome: "acquired", store_dirs: [BAD_DIR] } },
            { [BAD_DIR]: { track: "python", name: "badpkg", version: "1.0", order: "0a", edges: [] } },
        );
        const debrisInvocations: (readonly string[])[] = [];
        const debrisRun: ProvisionerRunner = async (invocation) => {
            debrisInvocations.push([...invocation.args]);
            return ok<CaptureResult, never>({ code: 0, stdout: "", stderr: "" });
        };

        try {
            await flushAndPrint(root, { flush: { run, loadCheck: loadCheck([BAD_DIR]) }, debris: { run: debrisRun } });
        } finally {
            // The refusal prints through the CLI error path, which marks the
            // process failed; the test process must not keep that mark. Bun
            // ignores an `undefined` assignment as a reset, thus zero it is.
            process.exitCode = 0;
        }

        expect(debrisInvocations).toEqual([["reclaim", "--debris"]]);
    });

    test("a clean flush starts no debris pass", async () => {
        const root = tempStore();
        enqueueStoreAdd({ name: "goodpkg", version: null, ecosystem: "python", analysisId: null })._unsafeUnwrap();
        const GOOD_DIR = "goodpkg-1.0-0000000000good1";
        const run = acquiringRunner(
            { "python:goodpkg": { outcome: "acquired", store_dirs: [GOOD_DIR] } },
            { [GOOD_DIR]: { track: "python", name: "goodpkg", version: "1.0", order: "0a", edges: [] } },
        );
        const debrisInvocations: (readonly string[])[] = [];
        const debrisRun: ProvisionerRunner = async (invocation) => {
            debrisInvocations.push([...invocation.args]);
            return ok<CaptureResult, never>({ code: 0, stdout: "", stderr: "" });
        };

        await flushAndPrint(root, { flush: { run, loadCheck: loadCheck([]) }, debris: { run: debrisRun } });

        expect(debrisInvocations).toHaveLength(0);
    });
});

describe("describeRecordedFlightFailure", () => {
    test("translates each phase into its plain sentence, with a bounded head of the raw reason", () => {
        expect(describeRecordedFlightFailure("resolve: nothing provides scipy==99")).toBe(
            "the version did not resolve against the index (nothing provides scipy==99)",
        );
        expect(describeRecordedFlightFailure("load_check: ImportError: no module named x\ntraceback line")).toBe(
            "the package failed its import proof inside the sandbox image (ImportError: no module named x)",
        );
        expect(describeRecordedFlightFailure('commit: the dependency "a-1" resolves to nothing in the pool')).toBe(
            'a dependency of it did not land in the pool (the dependency "a-1" resolves to nothing in the pool)',
        );
    });

    test("an unknown or absent record degrades to a head, never to a throw", () => {
        expect(describeRecordedFlightFailure(null)).toBe("no reason was recorded");
        expect(describeRecordedFlightFailure("something odd happened")).toBe("something odd happened");
        const long = `resolve: ${"x".repeat(300)}`;
        expect(describeRecordedFlightFailure(long).length).toBeLessThan(200);
    });
});

describe("classifyPoolMiss", () => {
    test("a pending add and a live flight read as in flight", () => {
        enqueueStoreAdd({ name: "Scanpy", version: null, ecosystem: "python", analysisId: null })._unsafeUnwrap();
        expect(classifyPoolMiss("scanpy")).toContain("in flight");

        claimStoreFlight({ id: "python::igraph::", ecosystem: "python", name: "igraph", specifier: "", holderPid: process.pid })._unsafeUnwrap();
        expect(classifyPoolMiss("igraph")).toContain("in flight");
    });

    test("a failed row carries its translated reason, and an unknown name carries nothing", () => {
        claimStoreFlight({ id: "python::numba::", ecosystem: "python", name: "numba", specifier: "", holderPid: process.pid })._unsafeUnwrap();
        settleStoreFlightFailure({ id: "python::numba::", message: "resolve: the index timed out" })._unsafeUnwrap();

        const detail = classifyPoolMiss("numba");
        expect(detail).toContain("its last flight failed");
        expect(detail).toContain("the version did not resolve against the index");
        expect(classifyPoolMiss("nonesuch")).toBeUndefined();
    });
});

describe("the flight key", () => {
    test("carries the ecosystem, the canonical name, and the specifier", () => {
        expect(storeFlightKey({ ecosystem: "python", name: "scanpy", specifier: "==1.10" })).toBe("python::scanpy::==1.10");
        expect(storeFlightKey({ ecosystem: null, name: "scanpy", specifier: "" })).toBe("any::scanpy::");
    });
});
