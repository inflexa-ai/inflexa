import type { StoreEcosystem, StoreFlightStatus, TransferKind, TransferPhase, TransferStatus } from "../types/store.ts";

/** The persisted row of one transfer kind, on the wire. Timestamps are ISO 8601. */
export type TransferRowView = {
    createdAt: string;
    /** When the last write landed. The heartbeat of a live child moves it. */
    updatedAt: string;
    /** The state as WRITTEN. Read {@link TransferReportView.state}, which corrects a dead holder. */
    state: TransferStatus;
    bytesTransferred: number;
    totalBytes: number | null;
    layersCompleted: number;
    totalLayers: number | null;
    /** What the last resolve saw: a manifest digest for the catalog, a local image digest for an image. */
    digest: string | null;
    /** The message of a failure, or the notice of a completed run. */
    message: string | null;
    phase: TransferPhase | null;
};

/** The lifecycle of one transfer kind, as a reader acts on it. */
export type TransferReportView = {
    kind: TransferKind;
    /** The row, or `null` when no transfer of this kind ran. */
    row: TransferRowView | null;
    /** The state a reader acts on: a `running` row with no live holder reads as `failed`. `null` when no transfer ran. */
    state: TransferStatus | null;
    /** True while a child holds the lock of the kind. */
    live: boolean;
    /** The pid of the live child, or `null`. */
    holderPid: number | null;
};

/** One acquisition flight: a live one, or a terminal `failed` record. */
export type StoreFlightView = {
    /** The flight key, which the retry and the delete routes take. */
    id: string;
    /** The spec as a user reads it. */
    spec: string;
    state: StoreFlightStatus;
    /** How many analyses subscribe to the flight. */
    subscribers: number;
    /** The newest provisioner line of a running flight, or `null`. */
    progress: string | null;
    /** The whole recorded reason of a `failed` flight, or `null`. */
    message: string | null;
    /** The recorded reason as one line of prose, or `null` on a live flight. */
    failure: string | null;
    updatedAt: string;
};

/** One enqueued add that no flush took yet. */
export type PendingAddView = {
    /** The key of the flight that the flush makes for this add. */
    flightKey: string;
    spec: string;
    /** The analysis whose farm the add extends, or `null`. */
    analysisId: string | null;
    createdAt: string;
};

/**
 * The body of `GET /api/v1/store`: the three transfers, the flights, and the adds that wait. The lists are
 * not paged: a user action makes each item, and a success removes its flight.
 */
export type StoreState = {
    transfers: TransferReportView[];
    flights: StoreFlightView[];
    pendingAdds: PendingAddView[];
};

/** The body of a `202` of `POST /api/v1/store/flights/:flightId/retry`. */
export type StoreAddAccepted = {
    flightKey: string;
    spec: string;
    /** True when the server started the flush of the pending set. */
    flushStarted: boolean;
};

/** The kind that `POST /api/v1/store/transfers` starts: one kind, or `images` for the two image kinds. */
export type TransferStartKind = TransferKind | "images";

/** The body of `POST /api/v1/store/transfers`. `update` applies a moved catalog tag. */
export type StartTransferRequest = {
    kind: TransferStartKind;
    update?: boolean;
};

/** What a start did for one transfer kind. Only `started` put a child on the machine. */
export type TransferStartView =
    | { kind: TransferKind; outcome: "started"; pid: number }
    | { kind: TransferKind; outcome: "already_running"; report: TransferReportView }
    | { kind: "catalog"; outcome: "up_to_date" }
    | { kind: "catalog"; outcome: "update_available"; installedDigest: string; latestDigest: string }
    | { kind: TransferKind; outcome: "failed"; message: string };

/** The body of a `202` of `POST /api/v1/store/transfers`. */
export type StartTransfersResponse = {
    /** A retired sandbox image override that the image start removed from the config, or `null`. */
    migratedImage: string | null;
    starts: TransferStartView[];
};

/** The body of `POST {A}/farm/link`. */
export type FarmLinkRequest = {
    /** The packages to link: each a name, or `name==version`. */
    packages: string[];
    lang?: StoreEcosystem;
};

/** The body of `POST {A}/farm/link`. */
export type FarmLinkView = {
    /** Each package that the farm links now, as `name==version` in the spelling of the request. */
    linked: string[];
    /** How many store directories the farm links after the call. */
    storeDirs: number;
};
