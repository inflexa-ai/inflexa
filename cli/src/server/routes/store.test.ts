import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomUUIDv7 } from "bun";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { ok } from "neverthrow";

import type { FarmLinkView, StartTransfersResponse, StoreAddAccepted, StoreState } from "../../api/store.ts";
import { claimStoreFlight, insertAnalysis, insertAnchor, settleStoreFlightFailure } from "../../db/primary_mutation.ts";
import { listPendingStoreAdds } from "../../db/primary_query.ts";
import { asStr256 } from "../../lib/types.ts";
import { enqueueStoreAdd } from "../../modules/libs/store_flight.ts";
import { freshDb } from "../../test_support/db.ts";
import type { ServerEnv } from "../http.ts";
import { DEFAULT_STORE_ROUTE_OPTS, farmLinkRoutes, storeRoutes, type StoreRouteOpts } from "./store.ts";

// The routes alone, with no app and no bearer check: `app.test.ts` covers those. Each start of a detached
// child is a stub, thus no test spawns a transfer, a flush, or a container. Each `as` cast of a body reads
// JSON that the route under test builds from the same `src/api/` type.

const FIXTURE = join(import.meta.dir, "..", "..", "modules", "libs", "test-fixtures", "farm-parity");

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
});

describe("GET /api/v1/store", () => {
    test("gives the three transfers, the flights with their prose, and the adds that wait", async () => {
        const { opts } = stubbed(tempStore());
        seedFailedFlight("polars");
        enqueueStoreAdd({ query: { spelling: "rpy2" }, analysisId: null })._unsafeUnwrap();

        const store = (await (await storeRoutes(opts).request("/store")).json()) as StoreState;

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
