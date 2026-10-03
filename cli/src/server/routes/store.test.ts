import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomUUIDv7 } from "bun";
import { closeSync, constants, cpSync, mkdirSync, mkdtempSync, openSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Hono } from "hono";
import { ok } from "neverthrow";

import type { CatalogCancelView, FarmLinkView, ReclaimView, SandboxStatus, StartTransfersResponse, StoreAddAccepted, StoreState } from "../../api/store.ts";
import { claimStoreFlight, insertAnalysis, insertAnchor, settleStoreFlightFailure } from "../../db/primary_mutation.ts";
import { listPendingStoreAdds } from "../../db/primary_query.ts";
import type { CaptureResult } from "../../lib/container.ts";
import { instanceLockPath, PACKAGE_STORE_RECLAIM_LOCK_KEY } from "../../lib/lock.ts";
import { asStr256 } from "../../lib/types.ts";
import type { ProvisionerRunner } from "../../modules/libs/provisioner.ts";
import { freshDb } from "../../test_support/db.ts";
import type { ServerEnv } from "../http.ts";
import { listen } from "../serve.ts";
import { DEFAULT_STORE_ROUTE_OPTS, farmLinkRoutes, storeRoutes, type StoreRouteOpts } from "./store.ts";

// The routes alone, with no app and no bearer check: `app.test.ts` covers those. Each start of a detached
// child is a stub, thus no test spawns a transfer, a flush, or a container. Each `as` cast of a body reads
// JSON that the route under test builds from the same `src/api/` type.

const FIXTURE = join(import.meta.dir, "..", "..", "modules", "libs", "test-fixtures", "farm-parity");

/** A store directory outside the fixture graph: with no farm link it is what a reclamation removes. */
const DEBRIS_DIR = "orphan-1.0-000000000orphan1";

const roots: string[] = [];

/** A copy of the fixture store, removed after the test. */
function tempStore(): string {
    const root = mkdtempSync(join(tmpdir(), "inflexa-store-routes-"));
    roots.push(root);
    cpSync(FIXTURE, root, { recursive: true });
    return root;
}

/** Route options whose child starts record and start nothing, over `storeRoot`. */
function stubbed(storeRoot: string, over: Partial<StoreRouteOpts> = {}): { opts: StoreRouteOpts; flushes: () => number; debris: () => number } {
    let flushes = 0;
    let debris = 0;
    return {
        flushes: () => flushes,
        debris: () => debris,
        opts: {
            ...DEFAULT_STORE_ROUTE_OPTS,
            storeRoot: () => storeRoot,
            startFlush: () => {
                flushes += 1;
                return 4242;
            },
            startImage: () => ok({ type: "started", pid: 4242 }),
            startCatalog: async () => ok({ type: "up_to_date", manifestDigest: "sha256:abc" }),
            cancelCatalog: async () => ({ type: "no_run" }),
            collectDebris: async () => {
                debris += 1;
                return ok({ swept: false, dirs: [], reports: 0 });
            },
            ...over,
        },
    };
}

function post(body?: unknown): RequestInit {
    return body === undefined ? { method: "POST" } : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}

/** A failed flight record of `spelling`, as a refused flush leaves it. */
function seedFailedFlight(spelling: string): string {
    const id = `python::${spelling}::`;
    claimStoreFlight({ id, ecosystem: "python", spelling, specifier: "", holderPid: process.pid })._unsafeUnwrap();
    settleStoreFlightFailure({ id, message: "resolve: the index timed out" })._unsafeUnwrap();
    return id;
}

/** An analysis row, for the routes that name one. */
function seedAnalysis(name: string): string {
    const now = Date.now();
    const anchorId = randomUUIDv7();
    const id = randomUUIDv7();
    insertAnchor({ id: anchorId, createdAt: now, updatedAt: now, cachedPath: `/tmp/${name}`, markerWritten: false, lastSeen: now })._unsafeUnwrap();
    insertAnalysis({ id, createdAt: now, updatedAt: now, name: asStr256(name), slug: name, anchorId, projectId: null })._unsafeUnwrap();
    return id;
}

beforeEach(() => {
    freshDb();
});

afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
    rmSync(instanceLockPath(PACKAGE_STORE_RECLAIM_LOCK_KEY), { force: true });
});

describe("GET /api/v1/store", () => {
    test("gives the three transfers, the flights with their prose, and the adds that wait", async () => {
        const { opts } = stubbed(tempStore());
        seedFailedFlight("polars");
        const routes = storeRoutes(opts);
        expect((await routes.request("/store/adds", post({ package: "rpy2", queued: true }))).status).toBe(202);

        const store = (await (await routes.request("/store")).json()) as StoreState;

        expect(store.transfers.map((report) => report.kind)).toEqual(["runtime_image", "provisioner_image", "catalog"]);
        expect(store.flights).toMatchObject([
            {
                id: "python::polars::",
                spec: "polars (python)",
                state: "failed",
                message: "resolve: the index timed out",
                failure: "the version did not resolve against the index (the index timed out)",
            },
        ]);
        expect(store.pendingAdds).toMatchObject([{ flightKey: "any::rpy2::", spec: "rpy2", analysisId: null }]);
    });
});

/**
 * Write the pin into a FIFO pin marker, which ends a read that waits on it. A FIFO that no reader holds open
 * refuses the nonblocking open, and then nothing waits on the pin.
 */
function writePin(fifo: string): void {
    try {
        const fd = openSync(fifo, constants.O_WRONLY | constants.O_NONBLOCK);
        writeSync(fd, "slow==1.0\n");
        closeSync(fd);
    } catch {
        // No reader holds the FIFO open.
    }
}

/**
 * Longer than the idle timeout of `Bun.serve`. The timeout is 10 s, and its timer counts in ticks of 4 s, thus a
 * request that sends no byte closes from 8 s to 12 s after it starts.
 */
const SLOW_INVENTORY_MS = 15_000;

describe("GET /api/v1/store/inventory over a real listener", () => {
    test(
        "an inventory that takes longer than the idle timeout of `Bun.serve` still answers",
        async () => {
            const root = tempStore();
            // The pin marker of one store directory is a FIFO, thus the read of the inventory waits on it until the
            // test writes the pin: a store whose walk takes longer than the idle timeout.
            const pin = join(root, "store", "slow-1.0-00000000000slow1", ".inflexa-pin");
            mkdirSync(dirname(pin), { recursive: true });
            expect(Bun.spawnSync(["mkfifo", pin]).exitCode).toBe(0);
            const server = listen(new Hono<ServerEnv>().route("/api/v1", storeRoutes(stubbed(root).opts)), 0)._unsafeUnwrap();
            const release = setTimeout(() => writePin(pin), SLOW_INVENTORY_MS);
            try {
                const outcome = await fetch(`http://127.0.0.1:${server.port}/api/v1/store/inventory`).then(
                    async (response) => ({ status: response.status, body: await response.text() }),
                    (cause: unknown) => ({ status: 0, body: `the request failed: ${String(cause)}` }),
                );
                expect(outcome).toMatchObject({ status: 200, body: expect.stringContaining('"slow==1.0"') });
            } finally {
                clearTimeout(release);
                writePin(pin);
                await server.stop(true);
            }
        },
        SLOW_INVENTORY_MS + 15_000,
    );
});

describe("POST /api/v1/store/adds", () => {
    test("a queued add enqueues and starts no flush; a direct add starts the flush", async () => {
        const stub = stubbed(tempStore());
        const routes = storeRoutes(stub.opts);

        const queued = await routes.request("/store/adds", post({ package: "scanpy==1.11", queued: true }));
        expect(queued.status).toBe(202);
        expect((await queued.json()) as StoreAddAccepted).toEqual({ flightKey: "any::scanpy::==1.11", spec: "scanpy==1.11", flushStarted: false });
        expect(stub.flushes()).toBe(0);

        const direct = await routes.request("/store/adds", post({ package: "numpy", lang: "python", version: "2.0.0" }));
        expect(((await direct.json()) as StoreAddAccepted).flushStarted).toBe(true);
        expect(stub.flushes()).toBe(1);
        expect(
            listPendingStoreAdds()
                ._unsafeUnwrap()
                .map((entry) => entry.spelling),
        ).toEqual(["scanpy", "numpy"]);
    });

    test("the analysis rides by name, and an unknown one is 404", async () => {
        const routes = storeRoutes(stubbed(tempStore()).opts);
        const analysisId = seedAnalysis("liver");

        expect((await routes.request("/store/adds", post({ package: "polars", analysis: "liver", queued: true }))).status).toBe(202);
        expect(listPendingStoreAdds()._unsafeUnwrap()[0]?.analysisId).toBe(analysisId);
        expect((await routes.request("/store/adds", post({ package: "polars", analysis: "kidney", queued: true }))).status).toBe(404);
    });

    test("a package the command surface refuses is 400 with the remedy, and nothing enqueues", async () => {
        const response = await storeRoutes(stubbed(tempStore()).opts).request("/store/adds", post({ package: "r:Seurat", queued: true }));
        expect(response.status).toBe(400);
        expect(await response.json()).toMatchObject({ error: "validation_error", message: expect.stringContaining("--lang r") });
        expect(listPendingStoreAdds()._unsafeUnwrap()).toEqual([]);
    });
});

describe("POST /api/v1/store/transfers", () => {
    test("`images` starts the two image kinds; `catalog` reports why no child was necessary", async () => {
        const started: string[] = [];
        const routes = storeRoutes(
            stubbed(tempStore(), {
                startImage: (kind) => {
                    started.push(kind);
                    return ok({ type: "started", pid: 7 });
                },
            }).opts,
        );

        const images = await routes.request("/store/transfers", post({ kind: "images" }));
        expect(images.status).toBe(202);
        expect((await images.json()) as StartTransfersResponse).toEqual({
            migratedImage: null,
            starts: [
                { kind: "runtime_image", outcome: "started", pid: 7 },
                { kind: "provisioner_image", outcome: "started", pid: 7 },
            ],
        });
        expect(started).toEqual(["runtime_image", "provisioner_image"]);

        const one = (await (await routes.request("/store/transfers", post({ kind: "provisioner_image" }))).json()) as StartTransfersResponse;
        expect(one.starts.map((start) => start.kind)).toEqual(["provisioner_image"]);

        const catalog = (await (await routes.request("/store/transfers", post({ kind: "catalog" }))).json()) as StartTransfersResponse;
        expect(catalog.starts).toEqual([{ kind: "catalog", outcome: "up_to_date" }]);
    });

    test("an unknown kind is 400", async () => {
        expect((await storeRoutes(stubbed(tempStore()).opts).request("/store/transfers", post({ kind: "everything" }))).status).toBe(400);
    });
});

describe("POST /api/v1/store/transfers/catalog/cancel", () => {
    test("gives the outcome of the stop", async () => {
        const routes = storeRoutes(stubbed(tempStore(), { cancelCatalog: async () => ({ type: "canceled", holderPid: 99 }) }).opts);
        expect((await (await routes.request("/store/transfers/catalog/cancel", post())).json()) as CatalogCancelView).toEqual({
            outcome: "canceled",
            holderPid: 99,
        });
    });
});

describe("POST /api/v1/store/reclaim", () => {
    test("a second reclamation while the first runs is 409 `conflict`, and the first then removes its preview", async () => {
        const root = tempStore();
        mkdirSync(join(root, "store", DEBRIS_DIR), { recursive: true });
        let release: () => void = () => undefined;
        const held = new Promise<void>((resolve) => {
            release = resolve;
        });
        let runs = 0;
        const blockingRunner: ProvisionerRunner = async () => {
            runs += 1;
            await held;
            return ok<CaptureResult, never>({ code: 0, stdout: "", stderr: "" });
        };
        const routes = storeRoutes(stubbed(root, { reclaimDeps: { run: blockingRunner, flightWaitMs: 50, flightPollMs: 5 } }).opts);

        const first = Promise.resolve(routes.request("/store/reclaim", post()));
        while (runs === 0) await Bun.sleep(5);

        // The lock file is re-entrant for this pid, thus the in-process exclusion is what refuses here.
        const second = await routes.request("/store/reclaim", post());
        expect(second.status).toBe(409);
        expect(await second.json()).toMatchObject({ error: "conflict", message: expect.stringContaining("reclaims the package store already") });

        release();
        const done = await first;
        expect(done.status).toBe(200);
        expect((await done.json()) as ReclaimView).toEqual({ preview: [DEBRIS_DIR], reclaimed: [DEBRIS_DIR], farmsReaped: [], lines: [] });
    });

    test("a live flight refuses the reclamation with 409 after the wait", async () => {
        claimStoreFlight({ id: "any::live::", ecosystem: null, spelling: "live", specifier: "", holderPid: process.pid })._unsafeUnwrap();
        const routes = storeRoutes(stubbed(tempStore(), { reclaimDeps: { flightWaitMs: 20, flightPollMs: 5 } }).opts);
        const response = await routes.request("/store/reclaim", post());
        expect(response.status).toBe(409);
        expect(await response.json()).toMatchObject({ error: "conflict", message: expect.stringContaining("acquisition is still in flight") });
    });
});

describe("the failed flights", () => {
    test("a retry enqueues the spec again and starts the flush", async () => {
        const stub = stubbed(tempStore());
        const id = seedFailedFlight("polars");

        const response = await storeRoutes(stub.opts).request(`/store/flights/${encodeURIComponent(id)}/retry`, post());

        expect(response.status).toBe(202);
        expect((await response.json()) as StoreAddAccepted).toEqual({ flightKey: id, spec: "polars (python)", flushStarted: true });
        expect(stub.flushes()).toBe(1);
        expect(listPendingStoreAdds()._unsafeUnwrap()).toMatchObject([{ spelling: "polars", ecosystem: "python", specifier: "" }]);
    });

    test("a delete removes the record and runs the debris pass", async () => {
        const stub = stubbed(tempStore());
        const id = seedFailedFlight("polars");
        const routes = storeRoutes(stub.opts);

        const response = await routes.request(`/store/flights/${encodeURIComponent(id)}`, { method: "DELETE" });

        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ deleted: true });
        expect(stub.debris()).toBe(1);
        expect(((await (await routes.request("/store")).json()) as StoreState).flights).toEqual([]);
    });

    test("an unknown flight and a live flight are 404 for both", async () => {
        claimStoreFlight({ id: "any::live::", ecosystem: null, spelling: "live", specifier: "", holderPid: process.pid })._unsafeUnwrap();
        const routes = storeRoutes(stubbed(tempStore()).opts);
        for (const id of ["any::nothing::", "any::live::"]) {
            expect((await routes.request(`/store/flights/${encodeURIComponent(id)}/retry`, post())).status).toBe(404);
            expect((await routes.request(`/store/flights/${encodeURIComponent(id)}`, { method: "DELETE" })).status).toBe(404);
        }
    });
});

describe("GET /api/v1/sandbox", () => {
    test("maps the inspection to the wire", async () => {
        const routes = storeRoutes(
            stubbed(tempStore(), {
                inspectSandbox: async () => ({
                    images: [{ label: "Runtime", image: "ghcr.io/inflexa-ai/sandbox-base:latest", present: true, digest: "sha256:1" }],
                    runtimeBin: "docker",
                    retiredImages: [],
                    transfers: [],
                    storeRoot: "/tmp/store",
                    storeContent: "missing",
                }),
            }).opts,
        );
        expect((await (await routes.request("/sandbox")).json()) as SandboxStatus).toEqual({
            images: [{ label: "Runtime", image: "ghcr.io/inflexa-ai/sandbox-base:latest", present: true, digest: "sha256:1" }],
            runtimeBin: "docker",
            retiredImages: [],
            transfers: [],
            storeRoot: "/tmp/store",
            storeContent: "missing",
        });
    });
});

describe("POST {A}/farm/link", () => {
    /** The link route mounted the way the app mounts it, under the analysis path, so the route reads the id param. */
    function linkRequest(storeRoot: string, analysisId: string, body: unknown): Promise<Response> {
        const app = new Hono<ServerEnv>().route("/api/v1/analyses/:analysisId", farmLinkRoutes({ storeRoot: () => storeRoot }));
        return Promise.resolve(app.request(`/api/v1/analyses/${analysisId}/farm/link`, post(body)));
    }

    test("links a package that the pool holds into the farm of the analysis", async () => {
        const root = tempStore();
        // A new farm starts from the catalog farm, the template that the download brings: here one with no
        // package, thus the farm links only the closure of the request.
        const catalog = join(root, "farms", "catalog");
        mkdirSync(join(catalog, "python", "site-packages"), { recursive: true });
        const lock = {
            schema: 1,
            arch: "arm64",
            packages: [],
            languages: { python: { version: "3.12", index: "https://pypi.org/simple" }, r: { version: "4.6.0", bioc_releases: [] } },
        };
        writeFileSync(join(catalog, "inflexa.lock"), `${JSON.stringify(lock)}\n`);
        const analysisId = seedAnalysis("liver");
        const response = await linkRequest(root, analysisId, { packages: ["alpha==1.2.0"], lang: "python" });
        expect(response.status).toBe(200);
        const view = (await response.json()) as FarmLinkView;
        expect(view.linked).toEqual(["alpha==1.2.0"]);
        expect(view.storeDirs).toBeGreaterThan(0);
    });

    test("a package that the pool does not hold is 409 with the remedy, and an unknown analysis is 404", async () => {
        const root = tempStore();
        const analysisId = seedAnalysis("liver");
        const refused = await linkRequest(root, analysisId, { packages: ["nothing-here"] });
        expect(refused.status).toBe(409);
        expect(await refused.json()).toMatchObject({ error: "conflict", message: expect.stringContaining("inflexa store add nothing-here") });
        expect((await linkRequest(root, randomUUIDv7(), { packages: ["alpha"] })).status).toBe(404);
    });
});
