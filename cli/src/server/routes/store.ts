import { Hono } from "hono";
import type { Result } from "neverthrow";
import { z } from "zod";

import type {
    FarmLinkView,
    PendingAddView,
    StartTransfersResponse,
    StoreAddAccepted,
    StoreFlightView,
    StoreState,
    TransferReportView,
    TransferStartView,
} from "../../api/store.ts";
import { deleteStoreFlight } from "../../db/primary_mutation.ts";
import { getStoreFlight, listPendingStoreAdds, type PendingStoreAdd } from "../../db/primary_query.ts";
import { env } from "../../lib/env.ts";
import { findAnalysis } from "../../modules/analysis/analysis.ts";
import { migrateRetiredSandboxImageOverride } from "../../modules/libs/pull.ts";
import { collectStoreDebris, linkIntoAnalysisFarm, startPendingFlushChild, type DebrisSweepOutcome, type StoreActionError } from "../../modules/libs/store.ts";
import { startCatalogTransfer, type CatalogTransferStart, type StoreDownloadError } from "../../modules/libs/store_download.ts";
import {
    describeRecordedFlightFailure,
    describeStoreFlightSpec,
    enqueueStoreAdd,
    readStoreFlights,
    storeFlightKey,
    type StoreFlightReport,
} from "../../modules/libs/store_flight.ts";
import { readTransferReports, startImageTransfer, type TransferReport, type TransferStart, type TransferStartError } from "../../modules/libs/transfers.ts";
import { TRANSFER_KINDS } from "../../types/store.ts";
import { apiError, holdConnection, internalError, readBody, type ServerEnv } from "../http.ts";

/** The work behind the store routes. Production passes {@link DEFAULT_STORE_ROUTE_OPTS}; a test replaces the parts that spawn or start a container. */
export type StoreRouteOpts = {
    /** The CLI-owned store root. */
    readonly storeRoot: () => string;
    /** Start the detached flush child over the pending set. */
    readonly startFlush: () => number | null;
    readonly startImage: (kind: "runtime_image" | "provisioner_image") => Result<TransferStart, TransferStartError>;
    readonly startCatalog: (params: { readonly storeRoot: string; readonly update: boolean }) => Promise<Result<CatalogTransferStart, StoreDownloadError>>;
    /** The silent debris pass after a failed record is deleted. */
    readonly collectDebris: (storeRoot: string) => Promise<Result<DebrisSweepOutcome, StoreActionError>>;
};

/** The production {@link StoreRouteOpts}. */
export const DEFAULT_STORE_ROUTE_OPTS: StoreRouteOpts = {
    storeRoot: () => env.packageStoreDir,
    startFlush: startPendingFlushChild,
    startImage: startImageTransfer,
    startCatalog: (params) => startCatalogTransfer(params),
    collectDebris: (storeRoot) => collectStoreDebris(storeRoot),
};

const startTransferBody = z.object({
    kind: z.enum([...TRANSFER_KINDS, "images"]),
    update: z.boolean().optional(),
});

const farmLinkBody = z.object({
    packages: z.array(z.string()).min(1),
    lang: z.enum(["python", "r"]).optional(),
});

/**
 * The routes of the package store and the sandbox images (draft 2.6), mounted at `/api/v1`. They read
 * SQLite, the lock files, and the store on the host, and they start the detached children, thus none of
 * them needs the runtime.
 */
export function storeRoutes(opts: StoreRouteOpts = DEFAULT_STORE_ROUTE_OPTS): Hono<ServerEnv> {
    const routes = new Hono<ServerEnv>();

    // `readStoreFlights` deletes the live rows of a dead holder during the read, the same sweep as each
    // other reader of the flights.
    routes.get("/store", (c) => {
        const body: StoreState = {
            transfers: readTransferReports().map(toTransferReportView),
            flights: readStoreFlights().map(toStoreFlightView),
            pendingAdds: listPendingStoreAdds().unwrapOr([]).map(toPendingAddView),
        };
        return c.json(body);
    });

    routes.post("/store/transfers", async (c) => {
        holdConnection(c);
        const body = await readBody(c, startTransferBody);
        if (body.isErr()) return body.error;
        const { kind, update } = body.value;
        const response: StartTransfersResponse = { migratedImage: null, starts: [] };
        if (kind === "catalog") {
            response.starts.push(fromCatalogStart(await opts.startCatalog({ storeRoot: opts.storeRoot(), update: update ?? false })));
            return c.json(response, 202);
        }
        // A retired variant override pins each sandbox to an image with no farm contract, thus an image
        // start clears it first, the same as `inflexa sandbox pull` did.
        response.migratedImage = migrateRetiredSandboxImageOverride();
        const kinds = kind === "images" ? (["runtime_image", "provisioner_image"] as const) : [kind];
        for (const imageKind of kinds) {
            response.starts.push(
                opts.startImage(imageKind).match(
                    (outcome) => imageStartView(imageKind, outcome),
                    (error): TransferStartView => ({ kind: imageKind, outcome: "failed", message: error.message }),
                ),
            );
        }
        return c.json(response, 202);
    });

    routes.post("/store/flights/:flightId/retry", (c) => {
        const flight = failedFlight(c.req.param("flightId"));
        if (flight.isErr()) return internalError(c, flight.error, "read the flight");
        const row = flight.value;
        if (row === null) return apiError(c, "not_found", `No failed flight ${c.req.param("flightId")}.`);
        // The retry is a new query, and the row already holds it: the spelling, the track, and the specifier.
        const enqueued = enqueueStoreAdd({
            query: {
                spelling: row.spelling,
                ...(row.ecosystem === null ? {} : { track: row.ecosystem }),
                ...(row.specifier.startsWith("==") ? { version: row.specifier.slice(2) } : {}),
            },
            analysisId: null,
        });
        if (enqueued.isErr()) {
            return enqueued.error.type === "merge_in_flight"
                ? apiError(c, "conflict", enqueued.error.message)
                : internalError(c, enqueued.error, "enqueue the retry");
        }
        opts.startFlush();
        const accepted: StoreAddAccepted = { flightKey: row.id, spec: describeStoreFlightSpec(row), flushStarted: true };
        return c.json(accepted, 202);
    });

    routes.delete("/store/flights/:flightId", (c) => {
        const flight = failedFlight(c.req.param("flightId"));
        if (flight.isErr()) return internalError(c, flight.error, "read the flight");
        if (flight.value === null) return apiError(c, "not_found", `No failed flight ${c.req.param("flightId")}.`);
        return deleteStoreFlight(flight.value.id).match(
            () => {
                // Fire-and-forget: the pass yields to live work on its own, and a pass that frees nothing is
                // silent by design.
                void opts.collectDebris(opts.storeRoot());
                return c.json({ deleted: true as const });
            },
            (e) => internalError(c, e, "delete the flight"),
        );
    });

    return routes;
}

/**
 * `POST {A}/farm/link`, mounted at `/api/v1/analyses/:analysisId`: link packages that the pool holds into the
 * farm of the analysis. The farm queue of the server serializes it with each other composition of that farm.
 */
export function farmLinkRoutes(opts: Pick<StoreRouteOpts, "storeRoot"> = DEFAULT_STORE_ROUTE_OPTS): Hono<ServerEnv> {
    const routes = new Hono<ServerEnv>();
    routes.post("/farm/link", async (c) => {
        holdConnection(c);
        const analysisId = c.req.param("analysisId") ?? "";
        const body = await readBody(c, farmLinkBody);
        if (body.isErr()) return body.error;
        const analysis = findAnalysis(analysisId);
        if (analysis.isErr()) return internalError(c, analysis.error, "read the analysis");
        if (analysis.value === null || analysis.value.id !== analysisId) return apiError(c, "not_found", `No analysis ${analysisId}.`);
        const linked = await linkIntoAnalysisFarm(opts.storeRoot(), analysis.value, body.value.packages, body.value.lang ?? null);
        return linked.match(
            (outcome) => {
                const view: FarmLinkView = { linked: [...outcome.linked], storeDirs: outcome.storeDirs };
                return c.json(view);
            },
            (e) => apiError(c, "conflict", e.message),
        );
    });
    return routes;
}

/** The flight row of `flightId` when it is a `failed` record, else `null`: a live flight has no retry and no delete. */
function failedFlight(flightId: string): ReturnType<typeof getStoreFlight> {
    return getStoreFlight(flightId).map((row) => (row !== null && row.state === "failed" ? row : null));
}

function imageStartView(kind: "runtime_image" | "provisioner_image", outcome: TransferStart): TransferStartView {
    return outcome.type === "started"
        ? { kind, outcome: "started", pid: outcome.pid }
        : { kind, outcome: "already_running", report: toTransferReportView(outcome.report) };
}

function fromCatalogStart(start: Result<CatalogTransferStart, StoreDownloadError>): TransferStartView {
    return start.match(
        (outcome): TransferStartView => {
            switch (outcome.type) {
                case "started":
                    return { kind: "catalog", outcome: "started", pid: outcome.pid };
                case "already_running":
                    return { kind: "catalog", outcome: "already_running", report: toTransferReportView(outcome.report) };
                case "up_to_date":
                    return { kind: "catalog", outcome: "up_to_date" };
                case "update_available":
                    return { kind: "catalog", outcome: "update_available", installedDigest: outcome.installedDigest, latestDigest: outcome.latestDigest };
                default: {
                    const exhaustive: never = outcome;
                    throw new Error(`unhandled catalog start: ${JSON.stringify(exhaustive)}`);
                }
            }
        },
        (error): TransferStartView => ({ kind: "catalog", outcome: "failed", message: error.message }),
    );
}

function toTransferReportView(report: TransferReport): TransferReportView {
    const row = report.row;
    return {
        kind: report.kind,
        row:
            row === null
                ? null
                : {
                      createdAt: new Date(row.createdAt).toISOString(),
                      updatedAt: new Date(row.updatedAt).toISOString(),
                      state: row.state,
                      bytesTransferred: row.bytesTransferred,
                      totalBytes: row.totalBytes,
                      layersCompleted: row.layersCompleted,
                      totalLayers: row.totalLayers,
                      digest: row.digest,
                      message: row.message,
                      phase: row.phase,
                  },
        state: report.state,
        live: report.live,
        holderPid: report.holderPid,
    };
}

function toStoreFlightView(flight: StoreFlightReport): StoreFlightView {
    const row = flight.row;
    return {
        id: row.id,
        spec: describeStoreFlightSpec(row),
        state: row.state,
        subscribers: flight.analysisIds.length,
        progress: row.progress,
        message: row.message,
        failure: row.state === "failed" ? describeRecordedFlightFailure(row.message) : null,
        updatedAt: new Date(row.updatedAt).toISOString(),
    };
}

function toPendingAddView(entry: PendingStoreAdd): PendingAddView {
    return {
        flightKey: storeFlightKey(entry),
        spec: describeStoreFlightSpec(entry),
        analysisId: entry.analysisId,
        createdAt: new Date(entry.createdAt).toISOString(),
    };
}
