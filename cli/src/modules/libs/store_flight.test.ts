import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { randomUUIDv7 } from "bun";
import { err, ok, type Result } from "neverthrow";

import { db } from "../../db/primary.ts";
import { getLibStoreFlight } from "../../db/primary_query.ts";
import { insertAnalysis, insertAnchor } from "../../db/primary_mutation.ts";
import { env } from "../../lib/env.ts";
import { LIB_STORE_RECLAIM_LOCK_KEY, instanceLockPath, releaseInstanceLock } from "../../lib/lock.ts";
import { asStr256 } from "../../lib/types.ts";
import { canonicalDistributionName } from "./composition.ts";
import { assertTestSandbox } from "../../test_support/sandbox.ts";
import {
    cancelLibStoreFlight,
    libStoreFlightKey,
    parseLibStoreFlightSpec,
    readLibStoreFlights,
    withLibStoreFlight,
    type LibStoreFlightSpec,
} from "./store_flight.ts";

// The flights run against the REAL SQLite database of the test sandbox, because the row IS the mechanism:
// it is how a second caller learns that a flight is live, and how the cap counts what runs. Only the work
// itself is a stub, thus no test starts a container.

/** A wait step short enough that a queued flight and a joined caller each move within one test. */
const POLL_MS = 5;

/** Drop each flight row and the reclaim lock, so every test starts from a machine on which nothing flies. */
function resetFlights(): void {
    releaseInstanceLock(LIB_STORE_RECLAIM_LOCK_KEY);
    rmSync(instanceLockPath(LIB_STORE_RECLAIM_LOCK_KEY), { force: true });
    db()
        .map((conn) => conn.query("DELETE FROM lib_store_flights").run())
        ._unsafeUnwrap();
}

beforeEach(() => {
    // env.locksDir is about to be written and cleared; refuse to run outside the test sandbox rather than
    // touch a real lock file (data-loss guard — see test_support/sandbox.ts).
    assertTestSandbox(env.locksDir);
    resetFlights();
});

afterEach(() => resetFlights());

/** Read one spec, failing the test when the request cannot be read at all. */
function spec(raw: string): LibStoreFlightSpec {
    return parseLibStoreFlightSpec(raw, "python")._unsafeUnwrap();
}

/**
 * Put one analysis in the database and give back its id.
 *
 * A subscription carries a real foreign key to `analyses`, so that a deleted analysis takes its
 * subscriptions with it. A test that subscribes therefore seeds a row rather than an invented id.
 */
function seedAnalysisId(name: string): string {
    const now = Date.now();
    const anchorId = randomUUIDv7();
    insertAnchor({ id: anchorId, createdAt: now, updatedAt: now, cachedPath: join(tmpdir(), "anchor"), markerWritten: true, lastSeen: now })._unsafeUnwrap();
    const analysis = insertAnalysis({
        id: randomUUIDv7(),
        createdAt: now,
        updatedAt: now,
        name: asStr256(name),
        slug: name.toLowerCase().replace(/\W+/g, "-"),
        anchorId,
        projectId: null,
    })._unsafeUnwrap();
    return analysis.id;
}

/** A promise plus the two functions that settle it, so a test releases work at the moment it chooses. */
function gate(): { readonly promise: Promise<void>; readonly open: () => void } {
    let open = (): void => undefined;
    const promise = new Promise<void>((resolve) => {
        open = resolve;
    });
    return { promise, open };
}

describe("the flight key — the normalized spec", () => {
    test("the name is PEP 503 canonical, thus two spellings key one flight", () => {
        expect(canonicalDistributionName("Scan_PY")).toBe("scan-py");
        expect(canonicalDistributionName("zope.interface")).toBe("zope-interface");
        expect(libStoreFlightKey(spec("Scan_PY"))).toBe(libStoreFlightKey(spec("scan.py")));
    });

    test("a specifier is part of the key, thus two constraints on one name key two flights", () => {
        expect(libStoreFlightKey(spec("numpy==1.26.4"))).not.toBe(libStoreFlightKey(spec("numpy>=1.26")));
        expect(libStoreFlightKey(spec("scanpy"))).not.toBe(libStoreFlightKey(spec("scanpy[leiden]")));
    });

    test("the space of a request is not part of the key", () => {
        expect(libStoreFlightKey(spec("numpy == 1.26.4"))).toBe(libStoreFlightKey(spec("numpy==1.26.4")));
    });

    // Task 9.5. The three parts join with `::`, and the key holds no control character.
    test("the three parts join with `::`, and no part of the key is a control character", () => {
        expect(libStoreFlightKey(spec("numpy==1.26.4"))).toBe("python::numpy::==1.26.4");
        expect(libStoreFlightKey(spec("scanpy"))).toBe("python::scanpy::");
        // A control character in the key puts one in the source file that writes it, and `grep` then
        // reads that file as binary and reports nothing.
        expect([...libStoreFlightKey(spec("scanpy[leiden]"))].every((character) => character.charCodeAt(0) >= 32)).toBe(true);
    });

    test("the ecosystem separates two tracks that carry one name", () => {
        const python = parseLibStoreFlightSpec("igraph", "python")._unsafeUnwrap();
        const r = parseLibStoreFlightSpec("igraph", "r")._unsafeUnwrap();
        expect(libStoreFlightKey(python)).not.toBe(libStoreFlightKey(r));
    });

    test("a request that starts with no package name is refused, and it names the request", () => {
        const error = parseLibStoreFlightSpec("==1.0", "python")._unsafeUnwrapErr();
        expect(error.type).toBe("invalid_spec");
        // A name and a bare version, with the operator omitted, is the common typing mistake.
        const trailing = parseLibStoreFlightSpec("numpy 1.0", "python")._unsafeUnwrapErr();
        expect(trailing.type).toBe("invalid_spec");
        expect(trailing.message).toContain("numpy 1.0");
    });
});

describe("withLibStoreFlight — one flight for each key", () => {
    test("the owner runs the work, and the row is gone once the flight ends", async () => {
        const target = spec("scanpy");
        let ran = 0;
        const outcome = await withLibStoreFlight(
            { spec: target, analysisId: null },
            async () => {
                ran += 1;
                // The row is live exactly while the work runs, and it reports `running`.
                expect(getLibStoreFlight(libStoreFlightKey(target))._unsafeUnwrap()?.state).toBe("running");
                return ok("done");
            },
            { pollMs: POLL_MS },
        );

        expect(outcome._unsafeUnwrap()).toEqual({ type: "flew", spec: target, value: "done" });
        expect(ran).toBe(1);
        expect(getLibStoreFlight(libStoreFlightKey(target))._unsafeUnwrap()).toBeNull();
    });

    test("a second request for one key starts no second run: it subscribes and it reports the same progress", async () => {
        const target = spec("scanpy");
        const analysisId = seedAnalysisId("Second analysis");
        const held = gate();
        let runs = 0;
        const reported: string[] = [];

        const owner = withLibStoreFlight(
            { spec: target, analysisId: null },
            async ({ onProgress }) => {
                runs += 1;
                onProgress("[provision] resolving scanpy");
                await held.promise;
                return ok("owner");
            },
            { pollMs: POLL_MS },
        );
        // The owner claims the key first; the second request then meets a live flight.
        await Promise.sleep(POLL_MS * 4);
        const joiner = withLibStoreFlight(
            { spec: target, analysisId, onProgress: (line) => reported.push(line) },
            async () => {
                runs += 1;
                return ok("joiner");
            },
            { pollMs: POLL_MS },
        );

        await Promise.sleep(POLL_MS * 8);
        held.open();
        const [first, second] = await Promise.all([owner, joiner]);

        // Exactly one run: the second request started no container of its own.
        expect(runs).toBe(1);
        expect(first._unsafeUnwrap()).toEqual({ type: "flew", spec: target, value: "owner" });
        expect(second._unsafeUnwrap()).toEqual({ type: "joined", spec: target });
        // The subscriber read the progress of the owner from the row.
        expect(reported).toContain("[provision] resolving scanpy");
    });

    test("a failed flight is not a cache: the row clears, and the next request starts fresh", async () => {
        const target = spec("scanpy");
        const failed = await withLibStoreFlight({ spec: target, analysisId: null }, async () => err({ message: "the index was unreachable" }), {
            pollMs: POLL_MS,
        });
        expect(failed._unsafeUnwrapErr()).toEqual({ message: "the index was unreachable" });
        expect(getLibStoreFlight(libStoreFlightKey(target))._unsafeUnwrap()).toBeNull();

        let ran = 0;
        const again = await withLibStoreFlight(
            { spec: target, analysisId: null },
            async () => {
                ran += 1;
                return ok("second");
            },
            { pollMs: POLL_MS },
        );
        expect(ran).toBe(1);
        expect(again._unsafeUnwrap().type).toBe("flew");
    });
});

describe("cancel — one unsubscribe, and a stop at zero subscribers", () => {
    test("a cancel with two subscribers leaves the flight for the other", async () => {
        const target = spec("scanpy");
        const analysisId = seedAnalysisId("Cancelling analysis");
        const held = gate();
        const owner = withLibStoreFlight(
            { spec: target, analysisId: null },
            async () => {
                await held.promise;
                return ok("owner");
            },
            { pollMs: POLL_MS },
        );
        await Promise.sleep(POLL_MS * 4);
        const joiner = withLibStoreFlight({ spec: target, analysisId }, async () => ok("joiner"), { pollMs: POLL_MS });
        await Promise.sleep(POLL_MS * 4);

        const cancel = cancelLibStoreFlight({ spec: target, analysisId });
        expect(cancel).toEqual({ type: "unsubscribed", remaining: 1 });
        // The subscriber that cancelled stops reporting, and the flight goes on for the owner.
        expect((await joiner)._unsafeUnwrap()).toEqual({ type: "canceled", spec: target });
        expect(getLibStoreFlight(libStoreFlightKey(target))._unsafeUnwrap()?.state).toBe("running");

        held.open();
        expect((await owner)._unsafeUnwrap().type).toBe("flew");
    });

    test("the last cancel stops the flight: the work is aborted and the row is gone", async () => {
        const target = spec("scanpy");
        const started = gate();
        const owner = withLibStoreFlight(
            { spec: target, analysisId: null },
            async ({ signal }) => {
                started.open();
                // A real runner kills its container on the signal; this one waits for it and reports.
                await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
                return ok("aborted");
            },
            { pollMs: POLL_MS },
        );
        await started.promise;

        expect(cancelLibStoreFlight({ spec: target, analysisId: null })).toEqual({ type: "unsubscribed", remaining: 0 });
        expect((await owner)._unsafeUnwrap()).toEqual({ type: "canceled", spec: target });
        expect(getLibStoreFlight(libStoreFlightKey(target))._unsafeUnwrap()).toBeNull();
    });

    test("a cancel of a flight that is not there, and of a subscription that is not there, changes nothing", async () => {
        expect(cancelLibStoreFlight({ spec: spec("scanpy"), analysisId: null })).toEqual({ type: "no_flight" });

        const target = spec("anndata");
        const held = gate();
        const owner = withLibStoreFlight(
            { spec: target, analysisId: null },
            async () => {
                await held.promise;
                return ok("owner");
            },
            { pollMs: POLL_MS },
        );
        await Promise.sleep(POLL_MS * 4);
        expect(cancelLibStoreFlight({ spec: target, analysisId: seedAnalysisId("Uninvolved analysis") })).toEqual({ type: "no_subscription" });
        held.open();
        await owner;
    });
});

describe("the concurrency cap", () => {
    /** One started flight, as the cap tests read it: what it acquires, whether its work began, and its gate. */
    type StartedFlight = {
        readonly spec: LibStoreFlightSpec;
        readonly started: () => boolean;
        readonly open: () => void;
        readonly done: Promise<Result<{ readonly type: string }, unknown>>;
    };

    /** Start one flight whose work reports when it began and waits for its gate. */
    function flightOf(raw: string, cap: number): StartedFlight {
        const target = spec(raw);
        const held = gate();
        let began = false;
        const done = withLibStoreFlight(
            { spec: target, analysisId: null },
            async () => {
                began = true;
                await held.promise;
                return ok(raw);
            },
            { pollMs: POLL_MS, cap },
        );
        return { spec: target, started: () => began, open: held.open, done };
    }

    // Task 4.11. Two different specs are two flights, and a cap of 2 lets both run at one time.
    test("two different adds run in parallel under the cap", async () => {
        const first = flightOf("scanpy", 2);
        const second = flightOf("anndata", 2);
        await Promise.sleep(POLL_MS * 8);

        // Both works are inside their run at the SAME moment, thus neither waited for the other.
        expect(first.started()).toBe(true);
        expect(second.started()).toBe(true);
        const live = readLibStoreFlights();
        expect(live).toHaveLength(2);
        expect(live.every((flight) => flight.row.state === "running")).toBe(true);

        first.open();
        second.open();
        expect((await first.done)._unsafeUnwrap()).toMatchObject({ type: "flew" });
        expect((await second.done)._unsafeUnwrap()).toMatchObject({ type: "flew" });
    });

    test("a cap of 1 queues the second flight, and it starts when the slot frees", async () => {
        const first = flightOf("scanpy", 1);
        await Promise.sleep(POLL_MS * 4);
        const second = flightOf("anndata", 1);
        await Promise.sleep(POLL_MS * 8);

        // The second owns its key, and it waits: its row reports `queued` and its work has not begun.
        expect(first.started()).toBe(true);
        expect(second.started()).toBe(false);
        expect(getLibStoreFlight(libStoreFlightKey(second.spec))._unsafeUnwrap()?.state).toBe("queued");

        first.open();
        await first.done;
        await Promise.sleep(POLL_MS * 8);
        expect(second.started()).toBe(true);

        second.open();
        expect((await second.done)._unsafeUnwrap()).toMatchObject({ type: "flew" });
    });
});
